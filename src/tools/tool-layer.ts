// The tool layer: the only way the model touches the browser (build brief, module 1).
// It enforces the URL allowlist in code. Redirects, popups, iframes, websockets and
// non-http(s) schemes are covered, and every decision is logged.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page, type Route } from "playwright";
import type { Config } from "../config.ts";
import { Redactor } from "../redact/redactor.ts";
import { describeWhere, type Where } from "../schemas/common.ts";
import type { GuardrailEvent } from "../schemas/run-record.ts";
import { Allowlist } from "./allowlist.ts";
import { GuardrailLog } from "./guardrail-log.ts";
import { locatorFor } from "./locate.ts";
import { buildPolicy, checkRequest, checkWebSocketSend, nextRequestAfterRedirect, type MutationPolicy, type RequestFacts } from "./mutations.ts";
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
  /** Requests to allowed hosts that got no answer at all (refused, reset, timed out, unresolvable). */
  infrastructureFailures(): readonly string[];
  setStep(step: number): void;
  /** Waits until no request is in flight and the network has been quiet for quietMs (or maxMs passes). */
  settle(quietMs: number, maxMs: number): Promise<void>;
  /** A screenshot with password fields and fields filled by fill_secret covered, for evidence. */
  screenshot(): Promise<Buffer>;
  browserVersion: string;
  browserSandbox: boolean;
  guardrails: GuardrailLog;
  targetOrigin: string;
}

class GuardrailBlock extends Error {}

/** fill_secret was asked for something the case does not declare as a secret. */
class SecretDeclarationError extends Error {}

// Errors that mean "nobody answered", as opposed to an HTTP error response from the application.
const CONNECTION_FAILURE = /ERR_CONNECTION_(REFUSED|RESET|TIMED_OUT|CLOSED)|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED/;

export interface ToolLayerOptions {
  targetOrigin: string;
  config: Config;
  runDir: string;
  guardrails?: GuardrailLog;
  /** Test-only: turn off the browser-level host resolver rule, so the route handler can be tested alone. */
  disableHostResolverRules?: boolean;
  /** A Playwright storage state made by the session setup. The model never sees this path or its content. */
  storageStatePath?: string;
  /** Everything that is shown to the model or stored passes through this. Secrets are added as they become known. */
  redactor?: Redactor;
  /** The case's `data`, and the resolved values of its secret entries, by key. Values stay inside this object. */
  caseData?: Record<string, string>;
  secretValues?: Record<string, string>;
  /** Where the scrubbed HAR is written, and a private folder (outside the run directory) for the raw one. */
  harPath?: string;
  harScratchDir?: string;
  /**
   * The state-changing requests the case declares ("POST /api/x", "POST /graphql#Op", "WS /socket"). Anything that
   * changes state and is not declared here, or always allowed by the configuration, is blocked.
   */
  allowedMutations?: readonly string[];
  /** Use this browser (in a new context) instead of launching one. The browser is left running when the layer closes. */
  sharedBrowser?: SharedBrowser;
}

/** Deep-scrubs a tool result. Strings under a `url` key are scrubbed as URLs. */
function scrubValue(redactor: Redactor, node: unknown, key?: string): unknown {
  if (typeof node === "string") return key === "url" ? redactor.scrubUrl(node) : redactor.scrubText(node);
  if (Array.isArray(node)) return node.map((n) => scrubValue(redactor, n, key));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, scrubValue(redactor, v, k)]));
  return node;
}

function hostResolverRules(entries: readonly string[]): string {
  const hosts = entries.map((e) => e.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""));
  return ["MAP * ~NOTFOUND", ...hosts.map((h) => `EXCLUDE ${h}`)].join(" , ");
}

/**
 * One browser used by many runs, each in its own context. The eval suites run hundreds of cases, and starting a
 * browser for each is the slow part. The browser is launched with the host rule for a fixed list of hosts, so a run
 * may use it only if every host it allows is on that list: the rule that stops redirect hops (see create) must cover it.
 */
export interface SharedBrowser {
  readonly browser: Browser;
  /** The allowlist entries (host or host:port) the browser's host rule was built from. */
  readonly entries: readonly string[];
  readonly sandbox: boolean;
  close(): Promise<void>;
}

export async function launchSharedBrowser(config: Config, entries: readonly string[]): Promise<SharedBrowser> {
  const browser = await chromium.launch({
    chromiumSandbox: config.browser.sandbox,
    args: [`--host-resolver-rules=${hostResolverRules(entries)}`],
  });
  return { browser, entries: [...entries], sandbox: config.browser.sandbox, close: () => browser.close().catch(() => undefined) };
}

export class ToolLayer {
  readonly guardrails: GuardrailLog;
  readonly redactor: Redactor;
  private readonly policy: MutationPolicy;
  private readonly secretFields: Where[] = [];
  private rawHarPath: string | null = null;
  private readonly allowlist: Allowlist;
  private readonly entries: string[];
  private readonly network: NetworkEntry[] = [];
  private readonly consoleLog: string[] = [];
  private readonly connectionFailures: string[] = [];
  private current: Page;
  private step = 0;
  private shots = 0;
  private inFlight = 0;
  private lastNetworkActivity = Date.now();

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
    this.redactor = options.redactor ?? new Redactor();
    this.policy = buildPolicy(options.allowedMutations ?? [], options.config.mutations.alwaysAllow, options.config.mutations.stateChangingGets);
    this.guardrails = options.guardrails ?? new GuardrailLog((u) => this.redactor.scrubUrl(u), (t) => this.redactor.scrubText(t));
  }

  static async create(options: ToolLayerOptions): Promise<ToolLayer> {
    const entries = [new URL(options.targetOrigin).host, ...options.config.allowlist.hosts];
    const allowlist = new Allowlist(entries, options.config.allowlist.schemes);
    mkdirSync(join(options.runDir, "shots"), { recursive: true });

    // Required, not just defense in depth: Playwright route handlers do not see redirect hops
    // (verified on Playwright 1.63.0 with Chromium 153: a redirect to another host reached that host
    // when only the route handler was active). The browser's host rule refuses every host that is not
    // on the allowlist, including IP literals, so redirect hops never leave the machine.
    let browser: Browser;
    if (options.sharedBrowser) {
      const shared = options.sharedBrowser;
      const uncovered = entries.filter((e) => !shared.entries.includes(e));
      if (uncovered.length > 0) throw new Error(`The shared browser was launched for other hosts. Its host rule does not cover: ${uncovered.join(", ")}.`);
      if (shared.sandbox !== options.config.browser.sandbox) throw new Error("The shared browser was launched with a different sandbox setting than this run's configuration.");
      if (options.disableHostResolverRules) throw new Error("A shared browser always has the host rule, so disableHostResolverRules cannot be used with it.");
      browser = shared.browser;
    } else {
      browser = await chromium.launch({
        // Playwright adds --no-sandbox unless chromiumSandbox is true, so say it explicitly.
        chromiumSandbox: options.config.browser.sandbox,
        args: options.disableHostResolverRules ? [] : [`--host-resolver-rules=${hostResolverRules(entries)}`],
      });
    }
    // The raw HAR holds cookies and request bodies, so it goes to a private folder first. close() scrubs
    // it into the run directory and deletes the raw file. Playwright traces are not recorded at all.
    let rawHarPath: string | null = null;
    if (options.harPath) {
      if (!options.harScratchDir) throw new Error("harScratchDir is required with harPath");
      mkdirSync(options.harScratchDir, { recursive: true, mode: 0o700 });
      rawHarPath = join(options.harScratchDir, `raw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.har`);
    }
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      ...(options.storageStatePath ? { storageState: options.storageStatePath } : {}),
      ...(rawHarPath ? { recordHar: { path: rawHarPath, content: "omit" as const, mode: "full" as const } } : {}),
    });
    context.setDefaultTimeout(options.config.tools.actionTimeoutMs);
    context.setDefaultNavigationTimeout(options.config.tools.navigationTimeoutMs);
    const page = await context.newPage();
    const layer = new ToolLayer(browser, context, page, options, allowlist, entries);
    layer.rawHarPath = rawHarPath;
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
      if (!decision.allowed) {
        this.log(type, "blocked", url, decision.reason + hop);
        await route.abort("blockedbyclient");
        return;
      }

      // A request that changes state must be declared by the case (or always allowed by the staging owner).
      const facts = { method: request.method(), url, postData: request.postData() };
      const mutation = checkRequest(facts, this.policy);
      if (!mutation.allowed) {
        this.log("mutation", "blocked", url, `${mutation.undeclared.join(", ")} is not declared in allowed_mutations${hop}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (mutation.changesState) {
        await this.forwardStateChange(route, facts, type, decision.reason + hop);
        return;
      }
      if (type !== "request") this.log(type, "allowed", url, decision.reason + hop);
      await route.continue();
    });

    await context.routeWebSocket(/.*/, (ws) => {
      const url = ws.url();
      const decision = this.allowlist.check(url.replace(/^ws/, "http"));
      if (!decision.allowed) {
        this.log("websocket", "blocked", url, decision.reason);
        void ws.close({ code: 1008, reason: "blocked by allowlist" });
        return;
      }
      this.log("websocket", "allowed", url, decision.reason);
      const server = ws.connectToServer();
      // Messages sent by the page are state changes. They are forwarded only if the case declares "WS <path>".
      // Messages from the server to the page pass through untouched.
      ws.onMessage((message) => {
        const check = checkWebSocketSend(url, this.policy);
        if (!check.allowed) {
          this.log("mutation", "blocked", url, `${check.undeclared.join(", ")} is not declared in allowed_mutations (a message sent by the page)`);
          void ws.close({ code: 1008, reason: "blocked: undeclared state change" });
          void server.close();
          return;
        }
        server.send(message);
      });
      ws.onClose((code, reason) => void server.close({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }));
    });

    context.on("request", (request) => {
      this.inFlight += 1;
      this.lastNetworkActivity = Date.now();
      // Backstop. The route handler does not see redirect hops (M1 finding). State-changing requests are followed by
      // hand (forwardStateChange), so this only fires for a chain longer than one hop. It cannot stop the request,
      // but the run still ends as INCONCLUSIVE with the request named.
      if (request.redirectedFrom()) {
        const check = checkRequest({ method: request.method(), url: request.url(), postData: request.postData() }, this.policy);
        if (!check.allowed) {
          this.log("mutation", "blocked", request.url(), `${check.undeclared.join(", ")} is not declared in allowed_mutations (redirect hop, noticed after it was sent)`);
        }
      }
    });
    context.on("requestfinished", () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastNetworkActivity = Date.now();
    });
    context.on("response", (response) => {
      const request = response.request();
      this.network.push(this.entryFor(request.method(), request.url(), response.status(), request.resourceType(), null));
    });
    context.on("requestfailed", (request) => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastNetworkActivity = Date.now();
      const failure = request.failure()?.errorText ?? "failed";
      this.network.push(this.entryFor(request.method(), request.url(), null, request.resourceType(), failure));
      // The target itself did not answer at all. That is infrastructure, not an application response
      // (manual: Definitions, precedence row 1), so the runner turns it into INCONCLUSIVE.
      if (CONNECTION_FAILURE.test(failure) && this.allowlist.check(request.url()).allowed) {
        this.connectionFailures.push(this.redactor.scrubText(`${request.method()} ${this.redactor.scrubUrl(request.url())}: ${failure}`));
      }
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

  /**
   * Sends a state-changing request that is allowed, but follows its first redirect by hand. A redirect with status
   * 307 or 308 keeps the method, so a declared POST could otherwise be moved to a path nobody declared. The
   * browser never sees the redirect hop in the route handler, so the check has to happen here.
   */
  private async forwardStateChange(route: Route, facts: RequestFacts, type: GuardrailEvent["type"], reason: string): Promise<void> {
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch {
      await route.abort("failed");
      return;
    }
    const next = nextRequestAfterRedirect(facts, response.status(), response.headers()["location"] ?? "");
    if (next) {
      const where = this.allowlist.check(next.url);
      if (!where.allowed) {
        this.log(type === "request" ? "request" : "navigation", "blocked", next.url, `${where.reason} (redirect hop of a state-changing request)`);
        await route.abort("blockedbyclient");
        return;
      }
      const check = checkRequest(next, this.policy);
      if (!check.allowed) {
        this.log("mutation", "blocked", next.url, `${check.undeclared.join(", ")} is not declared in allowed_mutations (redirect hop)`);
        await route.abort("blockedbyclient");
        return;
      }
    }
    if (type !== "request") this.log(type, "allowed", facts.url, reason);
    await route.fulfill({ response });
  }

  private entryFor(method: string, url: string, status: number | null, resourceType: string, failure: string | null): NetworkEntry {
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      /* keep the raw string */
    }
    // Stored and shown to the model only in scrubbed form.
    return {
      method,
      url: this.redactor.scrubUrl(url),
      path: this.redactor.scrubText(path),
      status,
      resourceType,
      failure,
      step: this.step,
      at: new Date().toISOString(),
    };
  }

  /** Backstop for navigations the route handler cannot see, such as data: iframes. */
  private attach(page: Page): void {
    page.on("console", (msg) => {
      if (msg.type() === "error") this.consoleLog.push(this.redactor.scrubText(msg.text()));
    });
    page.on("pageerror", (error) => this.consoleLog.push(this.redactor.scrubText(`pageerror: ${error.message}`)));
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
      infrastructureFailures: () => this.connectionFailures,
      setStep: (step) => {
        this.step = step;
      },
      settle: async (quietMs, maxMs) => {
        const end = Date.now() + maxMs;
        while (Date.now() < end) {
          if (this.inFlight === 0 && Date.now() - this.lastNetworkActivity >= quietMs) return;
          await new Promise((r) => setTimeout(r, 25));
        }
      },
      screenshot: () => this.maskedScreenshot(),
      browserVersion: this.browser.version(),
      browserSandbox: this.options.config.browser.sandbox,
      guardrails: this.guardrails,
      targetOrigin: this.options.targetOrigin,
    };
  }

  private locate(where: Where): Locator {
    return locatorFor(this.current, where);
  }

  /** Covers every password input and every field filled by fill_secret, so a secret never appears in a PNG. */
  private async maskedScreenshot(): Promise<Buffer> {
    const page = this.current;
    const mask = [page.locator("input[type=password]"), ...this.secretFields.map((w) => locatorFor(page, w))];
    return page.screenshot({ mask, maskColor: "#000000" });
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
    let result: ToolResult;
    try {
      const data = await this.dispatch(name, parsed.data as never);
      result = { ok: true, data };
    } catch (error) {
      if (error instanceof GuardrailBlock) result = { ok: false, code: "blocked_by_guardrail", message: error.message };
      else if (error instanceof SecretDeclarationError) result = { ok: false, code: "secret_not_declared", message: error.message };
      // An aborted navigation or request shows up as a Playwright error. Report the guardrail, not the symptom.
      else if (this.guardrails.blockedEvents().length > blockedBefore) {
        result = { ok: false, code: "blocked_by_guardrail", message: "the allowlist blocked a request during this action" };
      } else result = this.translate(error);
    }
    // Everything the model is shown passes through the scrubber, so a page that leaks a token cannot show it.
    return result.ok ? { ok: true, data: scrubValue(this.redactor, result.data) } : { ...result, message: this.redactor.scrubText(result.message) };
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
      case "fill_secret": {
        const target = args["target"] as Where;
        const dataKey = String(args["data_key"]);
        const key = dataKey.replace(/^data\./, "");
        const declared = this.options.caseData?.[key];
        if (declared === undefined || !declared.startsWith("secret:")) {
          // The model may only use secrets the case declares. This stops an injected instruction from
          // asking for another role's password or any other credential.
          throw new SecretDeclarationError(`${dataKey} is not a secret declared by this case`);
        }
        const value = this.options.secretValues?.[key];
        if (value === undefined) throw new SecretDeclarationError(`${dataKey} could not be resolved`);
        this.redactor.add(value, dataKey);
        await this.locate(target).fill(value);
        this.secretFields.push(target);
        return { filled: describeWhere(target), data_key: dataKey };
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
        writeFileSync(path, await this.maskedScreenshot());
        return { screenshot_id: id };
      }
      case "console_errors":
        return { errors: [...this.consoleLog] };
      case "network_errors":
        return { errors: this.network.filter((n) => n.failure !== null || (n.status !== null && n.status >= 400)) };
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined); // this also writes the raw HAR
    // A shared browser belongs to whoever launched it, and stays running for the next run.
    if (!this.options.sharedBrowser) await this.browser.close().catch(() => undefined);
    if (this.rawHarPath && this.options.harPath) {
      try {
        if (existsSync(this.rawHarPath)) {
          const har: unknown = JSON.parse(readFileSync(this.rawHarPath, "utf8"));
          writeFileSync(this.options.harPath, JSON.stringify(this.redactor.scrubHar(har), null, 2));
        }
      } finally {
        rmSync(this.rawHarPath, { force: true });
        this.rawHarPath = null;
      }
    }
  }
}
