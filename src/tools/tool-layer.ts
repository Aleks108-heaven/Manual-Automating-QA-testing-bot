// The tool layer: the only way the model touches the browser (build brief, module 1).
// It enforces the URL allowlist in code. Redirects, popups, iframes, websockets and
// non-http(s) schemes are covered, and every decision is logged.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page, type Route } from "playwright";
import type { Config } from "../config.ts";
import { describeWhere, type Where } from "../schemas/common.ts";
import type { GuardrailEvent } from "../schemas/run-record.ts";
import { Allowlist } from "./allowlist.ts";
import { GuardrailLog } from "./guardrail-log.ts";
import { TOOL_SCHEMAS, type ToolName, type ToolResult } from "./schemas.ts";

export interface NetworkEntry {
  method: string;
  url: string;
  path: string;
  status: number | null;
  resourceType: string;
  failure: string | null;
  step: number;
  at: string;
}

/** What the runner (not the model) may use: the page, the network log and the browser version. */
export interface RunnerAccess {
  page(): Page;
  network(): readonly NetworkEntry[];
  consoleErrors(): readonly string[];
  setStep(step: number): void;
  browserVersion: string;
  guardrails: GuardrailLog;
  targetOrigin: string;
}

class GuardrailBlock extends Error {}

export interface ToolLayerOptions {
  targetOrigin: string;
  config: Config;
  runDir: string;
  guardrails?: GuardrailLog;
  /** Test-only: turn off the browser-level host resolver rule, so the route handler can be tested alone. */
  disableHostResolverRules?: boolean;
}

function hostResolverRules(entries: readonly string[]): string {
  const hosts = entries.map((e) => e.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""));
  return ["MAP * ~NOTFOUND", ...hosts.map((h) => `EXCLUDE ${h}`)].join(" , ");
}

export class ToolLayer {
  readonly guardrails: GuardrailLog;
  private readonly allowlist: Allowlist;
  private readonly entries: string[];
  private readonly network: NetworkEntry[] = [];
  private readonly consoleLog: string[] = [];
  private current: Page;
  private step = 0;
  private shots = 0;

  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly options: ToolLayerOptions;

  private constructor(browser: Browser, context: BrowserContext, page: Page, options: ToolLayerOptions, allowlist: Allowlist, entries: string[]) {
    this.browser = browser;
    this.context = context;
    this.options = options;
    this.current = page;
    this.allowlist = allowlist;
    this.entries = entries;
    this.guardrails = options.guardrails ?? new GuardrailLog();
  }

  static async create(options: ToolLayerOptions): Promise<ToolLayer> {
    const entries = [new URL(options.targetOrigin).host, ...options.config.allowlist.hosts];
    const allowlist = new Allowlist(entries, options.config.allowlist.schemes);
    mkdirSync(join(options.runDir, "shots"), { recursive: true });

    // Required, not just defense in depth: Playwright route handlers do not see redirect hops
    // (verified on Playwright 1.63.0 with Chromium 153: a redirect to another host reached that host
    // when only the route handler was active). The browser's host rule refuses every host that is not
    // on the allowlist, including IP literals, so redirect hops never leave the machine.
    const browser = await chromium.launch({
      args: options.disableHostResolverRules ? [] : [`--host-resolver-rules=${hostResolverRules(entries)}`],
    });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    context.setDefaultTimeout(options.config.tools.actionTimeoutMs);
    context.setDefaultNavigationTimeout(options.config.tools.navigationTimeoutMs);
    const page = await context.newPage();
    const layer = new ToolLayer(browser, context, page, options, allowlist, entries);
    layer.guardrails.record({ type: "navigation", decision: "allowed", url: options.targetOrigin, detail: `allowlist: ${entries.join(", ")}` });
    await layer.install();
    return layer;
  }

  private log(type: GuardrailEvent["type"], decision: GuardrailEvent["decision"], url: string, detail: string): void {
    this.guardrails.record({ type, decision, url, detail });
  }

  private async install(): Promise<void> {
    const { context } = this;

    // Every request, including redirect hops, subresources, frames and popups, goes through here.
    await context.route("**/*", async (route: Route) => {
      const request = route.request();
      const url = request.url();
      const decision = this.allowlist.check(url);
      let isFrame = false;
      if (request.isNavigationRequest()) {
        try {
          isFrame = request.frame().parentFrame() !== null;
        } catch {
          // A popup's first request is issued before its frame exists. It is a top-level navigation.
        }
      }
      const type: GuardrailEvent["type"] = request.isNavigationRequest() ? (isFrame ? "frame" : "navigation") : "request";
      const hop = request.redirectedFrom() ? " (redirect hop)" : "";
      if (decision.allowed) {
        if (type !== "request") this.log(type, "allowed", url, decision.reason + hop);
        await route.continue();
      } else {
        this.log(type, "blocked", url, decision.reason + hop);
        await route.abort("blockedbyclient");
      }
    });

    await context.routeWebSocket(/.*/, (ws) => {
      const url = ws.url();
      const decision = this.allowlist.check(url.replace(/^ws/, "http"));
      if (decision.allowed) {
        this.log("websocket", "allowed", url, decision.reason);
        ws.connectToServer();
      } else {
        this.log("websocket", "blocked", url, decision.reason);
        void ws.close({ code: 1008, reason: "blocked by allowlist" });
      }
    });

    context.on("response", (response) => {
      const request = response.request();
      this.network.push(this.entryFor(request.method(), request.url(), response.status(), request.resourceType(), null));
    });
    context.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "failed";
      this.network.push(this.entryFor(request.method(), request.url(), null, request.resourceType(), failure));
      // Route handlers do not see redirect hops. The browser's host rule refuses them instead, and
      // the failure is the only trace, so log it here. (Requests that the route handler aborted
      // are already logged there, and they fail with ERR_BLOCKED_BY_CLIENT.)
      if (failure.includes("ERR_NAME_NOT_RESOLVED")) {
        const decision = this.allowlist.check(request.url());
        if (!decision.allowed) {
          const hop = request.redirectedFrom() ? "redirect hop" : "request";
          this.log(request.isNavigationRequest() ? "navigation" : "request", "blocked", request.url(), `${decision.reason} (${hop} refused by the browser host rule)`);
        }
      }
    });

    context.on("page", (popup) => {
      this.attach(popup);
      void this.handlePopup(popup);
    });
    this.attach(this.current);
  }

  private entryFor(method: string, url: string, status: number | null, resourceType: string, failure: string | null): NetworkEntry {
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      /* keep the raw string */
    }
    return { method, url, path, status, resourceType, failure, step: this.step, at: new Date().toISOString() };
  }

  /** Backstop for navigations the route handler cannot see, such as data: iframes. */
  private attach(page: Page): void {
    page.on("console", (msg) => {
      if (msg.type() === "error") this.consoleLog.push(msg.text());
    });
    page.on("pageerror", (error) => this.consoleLog.push(`pageerror: ${error.message}`));
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
    page.on("framenavigated", (frame: Frame) => {
      const url = frame.url();
      if (url === "about:blank" || url.startsWith("chrome-error://")) return;
      const decision = this.allowlist.check(url);
      if (decision.allowed) return;
      const isMain = frame === page.mainFrame();
      this.log(isMain ? "navigation" : "frame", "blocked", url, `${decision.reason} (caught after navigation)`);
      if (isMain) {
        void page.goto("about:blank").catch(() => undefined);
      } else {
        void frame.frameElement().then((el) => el.evaluate((node) => (node as Element).remove())).catch(() => undefined);
      }
    });
  }

  private async handlePopup(popup: Page): Promise<void> {
    this.log("popup", "allowed", popup.url() || "about:blank", "a new tab or window was opened; its navigation is checked like any other");
    try {
      await popup.waitForLoadState("domcontentloaded", { timeout: 3000 });
    } catch {
      /* the navigation may have been aborted by the route handler */
    }
    const url = popup.url();
    const decision = url === "about:blank" || url.startsWith("chrome-error://") ? { allowed: false, reason: "popup has no allowed page" } : this.allowlist.check(url);
    if (!decision.allowed) {
      await popup.close().catch(() => undefined);
    } else {
      this.current = popup;
    }
  }

  runnerAccess(): RunnerAccess {
    return {
      page: () => this.current,
      network: () => this.network,
      consoleErrors: () => this.consoleLog,
      setStep: (step) => {
        this.step = step;
      },
      browserVersion: this.browser.version(),
      guardrails: this.guardrails,
      targetOrigin: this.options.targetOrigin,
    };
  }

  private locate(where: Where): Locator {
    const page = this.current;
    if ("selector" in where) return page.locator(where.selector);
    // Role locators cover the accessible-name matching the cases use. Cast: the case file carries a plain string.
    return page.getByRole(where.role as Parameters<Page["getByRole"]>[0], where.name === undefined ? {} : { name: where.name, exact: true });
  }

  /** Runs one tool call. The model reaches the browser only through this method. */
  async call(tool: string, rawArgs: unknown): Promise<ToolResult> {
    if (!(tool in TOOL_SCHEMAS)) return { ok: false, code: "unknown_tool", message: `unknown tool ${tool}` };
    const name = tool as ToolName;
    const parsed = TOOL_SCHEMAS[name].safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return { ok: false, code: "invalid_args", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    }
    const blockedBefore = this.guardrails.blockedEvents().length;
    try {
      const data = await this.dispatch(name, parsed.data as never);
      return { ok: true, data };
    } catch (error) {
      if (error instanceof GuardrailBlock) return { ok: false, code: "blocked_by_guardrail", message: error.message };
      // An aborted navigation or request shows up as a Playwright error. Report the guardrail, not the symptom.
      if (this.guardrails.blockedEvents().length > blockedBefore) {
        return { ok: false, code: "blocked_by_guardrail", message: "the allowlist blocked a request during this action" };
      }
      return this.translate(error);
    }
  }

  private translate(error: unknown): ToolResult {
    const message = error instanceof Error ? error.message : String(error);
    const first = message.split("\n")[0] ?? message;
    if (message.includes("strict mode violation")) return { ok: false, code: "ambiguous", message: first };
    if (error instanceof Error && error.name === "TimeoutError") {
      return { ok: false, code: message.includes("waiting for") ? "element_missing" : "timeout", message: first };
    }
    return { ok: false, code: "tool_error", message: first };
  }

  private async dispatch(tool: ToolName, args: Record<string, unknown>): Promise<unknown> {
    const page = this.current;
    switch (tool) {
      case "goto": {
        const raw = String(args["url"]);
        const resolved = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : new URL(raw, this.options.targetOrigin).toString();
        const decision = this.allowlist.check(resolved);
        if (!decision.allowed) {
          this.log(/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw) ? "scheme" : "navigation", "blocked", resolved, decision.reason);
          throw new GuardrailBlock(`navigation refused: ${decision.reason}`);
        }
        this.log("navigation", "allowed", resolved, decision.reason);
        await page.goto(resolved, { waitUntil: "load" });
        return { url: page.url() };
      }
      case "click": {
        const locator = this.locate(args["target"] as Where);
        const href = await locator.evaluate((el) => (el.closest("a") as HTMLAnchorElement | null)?.getAttribute("href") ?? null);
        if (href !== null && !href.startsWith("#")) {
          const absolute = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : new URL(href, page.url()).toString();
          const decision = this.allowlist.check(absolute);
          if (!decision.allowed) {
            this.log(/^https?:/i.test(absolute) ? "navigation" : "scheme", "blocked", absolute, `${decision.reason} (link target, click not performed)`);
            throw new GuardrailBlock(`click refused: the link goes to ${absolute} (${decision.reason})`);
          }
        }
        await locator.click();
        return { clicked: describeWhere(args["target"] as Where) };
      }
      case "fill": {
        await this.locate(args["target"] as Where).fill(String(args["value"]));
        return { filled: describeWhere(args["target"] as Where) };
      }
      case "press": {
        const target = args["target"] as Where | undefined;
        if (target) await this.locate(target).press(String(args["key"]));
        else await page.keyboard.press(String(args["key"]));
        return { pressed: String(args["key"]) };
      }
      case "wait_for": {
        const timeout = typeof args["timeout_ms"] === "number" ? args["timeout_ms"] : undefined;
        await this.locate(args["target"] as Where).waitFor({ state: args["state"] as "visible" | "hidden", ...(timeout ? { timeout } : {}) });
        return { waited: describeWhere(args["target"] as Where), state: args["state"] };
      }
      case "snapshot":
        return { snapshot: await page.locator("body").ariaSnapshot(), url: page.url() };
      case "screenshot": {
        this.shots += 1;
        const label = typeof args["label"] === "string" ? args["label"].replace(/[^A-Za-z0-9_-]/g, "_") : "shot";
        const id = `shot-${String(this.shots).padStart(3, "0")}-${label}`;
        const path = join(this.options.runDir, "shots", `${id}.png`);
        writeFileSync(path, await page.screenshot());
        return { screenshot_id: id };
      }
      case "console_errors":
        return { errors: [...this.consoleLog] };
      case "network_errors":
        return { errors: this.network.filter((n) => n.failure !== null || (n.status !== null && n.status >= 400)) };
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}
