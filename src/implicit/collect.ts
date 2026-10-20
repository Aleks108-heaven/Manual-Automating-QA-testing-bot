// Implicit checks: things that need no expected result. Console errors, HTTP error responses, failed requests,
// broken images, and automated accessibility violations. In version 1 they are REPORTED with the verdict and
// never change it (manual: Definitions). They are collected by the runner, never by the model, and they never
// become MATCH or MISMATCH outcomes. Findings are scrubbed, de-duplicated, and capped.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Config } from "../config.ts";
import type { Redactor } from "../redact/redactor.ts";
import type { TestCase } from "../schemas/case.ts";
import type { RunnerAccess } from "../tools/tool-layer.ts";

export const IMPLICIT_KINDS = ["console_error", "http_error", "failed_request", "broken_image", "accessibility"] as const;
export type ImplicitKind = (typeof IMPLICIT_KINDS)[number];

export interface ImplicitFinding {
  kind: ImplicitKind;
  /** The first step after which it was seen. */
  step: number;
  /** The page it was seen on (scrubbed URL, without the query). */
  page: string;
  detail: string;
  /** For accessibility: the axe rule id and its impact. */
  rule?: string;
  impact?: string;
  /** How many times it was seen (for accessibility, how many elements). */
  count: number;
}

export interface ImplicitSummary {
  enabled: boolean;
  findings: ImplicitFinding[];
  counts: Record<ImplicitKind, number>;
  /** True when findings beyond the cap were dropped. */
  truncated: boolean;
}

let axeSource: string | null = null;
function loadAxe(): string {
  axeSource ??= readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  return axeSource;
}

const clip = (text: string, n = 200) => (text.length > n ? `${text.slice(0, n)}...` : text);

export class ImplicitCollector {
  private readonly access: RunnerAccess;
  private readonly config: Config;
  private readonly redactor: Redactor;
  private readonly expectedStatuses: Set<string>;
  private readonly found = new Map<string, ImplicitFinding>();
  private truncated = false;
  private consoleSeen = 0;
  private networkSeen = 0;
  private readonly pagesChecked = new Set<string>();

  constructor(access: RunnerAccess, config: Config, redactor: Redactor, testCase: TestCase) {
    this.access = access;
    this.config = config;
    this.redactor = redactor;
    // A response the case itself expects (for example the 422 of an invalid form) is not a surprise.
    this.expectedStatuses = new Set(testCase.expected.flatMap((e) => (e.kind === "status" ? [`${e.request} ${e.status}`] : [])));
  }

  private add(finding: Omit<ImplicitFinding, "count"> & { count?: number }, key: string): void {
    const existing = this.found.get(key);
    if (existing) {
      existing.count += finding.count ?? 1;
      return;
    }
    if (this.found.size >= this.config.implicit.maxFindings) {
      this.truncated = true;
      return;
    }
    this.found.set(key, { ...finding, detail: this.redactor.scrubText(clip(finding.detail)), count: finding.count ?? 1 });
  }

  private pageOf(url: string): string {
    try {
      const u = new URL(url);
      return this.redactor.scrubUrl(u.origin + u.pathname);
    } catch {
      return this.redactor.scrubUrl(url);
    }
  }

  /** Looks at everything new since the last call. Never throws: a failed check is not a finding. */
  async collectAfterStep(step: number): Promise<void> {
    if (!this.config.implicit.enabled) return;
    const page = this.access.page();
    let pageUrl = "";
    try {
      pageUrl = page.url();
    } catch {
      return;
    }
    const where = this.pageOf(pageUrl);

    const consoleErrors = this.access.consoleErrors();
    for (const text of consoleErrors.slice(this.consoleSeen)) this.add({ kind: "console_error", step, page: where, detail: text }, `console|${text}`);
    this.consoleSeen = consoleErrors.length;

    const network = this.access.network();
    for (const n of network.slice(this.networkSeen)) {
      const label = `${n.method} ${n.path}`;
      if (n.failure !== null) {
        // Requests our own allowlist refused are guardrail events, not findings about the application.
        if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(n.failure)) continue;
        this.add({ kind: "failed_request", step, page: where, detail: `${label}: ${n.failure}` }, `failed|${label}|${n.failure}`);
      } else if (n.status !== null && n.status >= 400 && !n.path.startsWith("/__test") && !this.expectedStatuses.has(`${label} ${n.status}`)) {
        this.add({ kind: "http_error", step, page: where, detail: `${label} answered ${n.status}` }, `http|${label}|${n.status}`);
      }
    }
    this.networkSeen = network.length;

    if (!/^https?:/.test(pageUrl)) return;
    try {
      const broken = await page.evaluate(() =>
        [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src)).map((i) => i.currentSrc || i.src),
      );
      for (const src of broken) this.add({ kind: "broken_image", step, page: where, detail: `image did not load: ${this.redactor.scrubUrl(src)}` }, `image|${src}`);
    } catch {
      /* the page went away */
    }

    // Accessibility: once per distinct page in a run.
    if (this.config.implicit.accessibility && !this.pagesChecked.has(where)) {
      this.pagesChecked.add(where);
      try {
        await page.evaluate(loadAxe());
        const violations = await page.evaluate(async () => {
          const axe = (globalThis as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: Array<{ id: string; impact: string | null; help: string; nodes: unknown[] }> }> } }).axe;
          const result = await axe.run(document, { resultTypes: ["violations"] });
          return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length }));
        });
        for (const v of violations) {
          this.add({ kind: "accessibility", step, page: where, detail: v.help, rule: v.id, ...(v.impact ? { impact: v.impact } : {}), count: v.count }, `a11y|${where}|${v.id}`);
        }
      } catch {
        /* the page blocked evaluation or went away */
      }
    }
  }

  summary(): ImplicitSummary {
    const findings = [...this.found.values()];
    const counts = Object.fromEntries(IMPLICIT_KINDS.map((k) => [k, findings.filter((f) => f.kind === k).length])) as Record<ImplicitKind, number>;
    return { enabled: this.config.implicit.enabled, findings, counts, truncated: this.truncated };
  }
}
