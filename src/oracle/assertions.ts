// The oracle's structured assertions. Code checks each expected result against the live page and the
// network log at the step the case names in `after_step`, and the runner captures the evidence.
// No LLM is involved. `judged` results go to the judge, which arrives in M3.
import type { Config } from "../config.ts";
import type { ExpectedResult } from "../schemas/case.ts";
import { describeWhere, type Outcome } from "../schemas/common.ts";
import type { OutcomeRecord } from "../schemas/run-record.ts";
import { locatorFor } from "../tools/locate.ts";
import type { RunnerAccess } from "../tools/tool-layer.ts";
import type { EvidenceSink } from "./evidence.ts";

export interface OracleContext {
  access: RunnerAccess;
  config: Config;
  evidence: EvidenceSink;
}

interface Check {
  ok: boolean;
  actual: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clip = (text: string, n = 200) => (text.length > n ? `${text.slice(0, n)}...` : text);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Re-checks until the condition holds or the timeout passes. With stableMs > 0 the condition must
 * still hold after that pause, which matters for "nothing is there" style checks.
 */
async function pollUntil(check: () => Promise<Check>, timeoutMs: number, pollMs: number, stableMs: number): Promise<Check> {
  const end = Date.now() + timeoutMs;
  const safe = async (): Promise<Check> => {
    try {
      return await check();
    } catch (error) {
      return { ok: false, actual: `error: ${clip((error as Error).message.split("\n")[0] ?? "")}` };
    }
  };
  let last = await safe();
  for (;;) {
    if (last.ok) {
      if (stableMs === 0) return last;
      await sleep(stableMs);
      const again = await safe();
      if (again.ok) return again;
      last = again;
    }
    if (Date.now() >= end) return last;
    await sleep(pollMs);
    last = await safe();
  }
}

function describeExpected(e: ExpectedResult): string {
  switch (e.kind) {
    case "text_visible":
      return `${describeWhere(e.where)} shows ${e.exact ? "exactly " : ""}"${e.text}"`;
    case "url":
      return e.equals !== undefined ? `url equals ${e.equals}` : `url matches ${e.matches}`;
    case "status":
      return `${e.request} answers ${e.status}`;
    case "count":
      return `${describeWhere(e.where)} matches ${e.equals} element(s)`;
    case "element_state":
      return `${describeWhere(e.where)} is ${e.state}`;
    case "judged":
      return e.description;
  }
}

function checkFor(e: ExpectedResult, ctx: OracleContext): (() => Promise<Check>) | null {
  const { access } = ctx;
  switch (e.kind) {
    case "text_visible":
      return async () => {
        const locator = locatorFor(access.page(), e.where);
        // Playwright compares text with white space collapsed, so a double space is not a difference a user could see.
        const wanted = new RegExp(e.exact ? `^\\s*${escapeRegExp(e.text)}\\s*$` : escapeRegExp(e.text));
        const texts = (await locator.all()).length === 0 ? [] : await locator.allInnerTexts();
        const visibleMatch = locator.filter({ hasText: wanted });
        const found = (await visibleMatch.count()) > 0 && (await visibleMatch.first().isVisible());
        return { ok: found, actual: texts.length === 0 ? "(no matching element)" : clip(texts.map((t) => `"${t.trim()}"`).join(", ")) };
      };
    case "url":
      return async () => {
        const url = new URL(access.page().url());
        const pathAndQuery = url.pathname + url.search;
        if (e.equals !== undefined) {
          const ok = e.equals.startsWith("/") ? pathAndQuery === e.equals || url.pathname === e.equals : url.href === e.equals;
          return { ok, actual: e.equals.startsWith("/") ? pathAndQuery : url.href };
        }
        return { ok: new RegExp(e.matches as string).test(url.href), actual: url.href };
      };
    case "status": {
      const [method, path] = e.request.split(" ") as [string, string];
      return async () => {
        const hits = access.network().filter((n) => n.method === method && n.path === path && n.step <= e.after_step);
        const last = hits[hits.length - 1];
        if (!last) return { ok: false, actual: `no ${e.request} request was made` };
        return { ok: last.status === e.status, actual: String(last.status ?? last.failure ?? "no response") };
      };
    }
    case "count":
      return async () => {
        const n = await locatorFor(access.page(), e.where).count();
        return { ok: n === e.equals, actual: String(n) };
      };
    case "element_state":
      return async () => {
        const locator = locatorFor(access.page(), e.where);
        const n = await locator.count();
        if (n === 0) return e.state === "hidden" ? { ok: true, actual: "no matching element (hidden)" } : { ok: false, actual: "no matching element" };
        if (n > 1) return { ok: false, actual: `${n} elements match, the locator must match one` };
        const states: Record<string, boolean> = {
          visible: await locator.isVisible(),
          hidden: !(await locator.isVisible()),
          enabled: await locator.isEnabled(),
          disabled: await locator.isDisabled(),
          checked: await locator.isChecked().catch(() => false),
          unchecked: !(await locator.isChecked().catch(() => false)),
        };
        return { ok: states[e.state] === true, actual: Object.entries(states).filter(([, v]) => v).map(([k]) => k).join(", ") || "none of the states" };
      };
    case "judged":
      return null;
  }
}

/** Evaluates one structured expected result and captures its evidence. */
export async function evaluateExpected(e: ExpectedResult, ctx: OracleContext): Promise<OutcomeRecord> {
  const { timeoutMs, pollMs, stableMs } = {
    timeoutMs: ctx.config.oracle.assertionTimeoutMs,
    pollMs: ctx.config.oracle.assertionPollMs,
    // Only counts get the stability hold. A message that appears must be caught at once.
    stableMs: e.kind === "count" ? ctx.config.oracle.stabilityMs : 0,
  };
  const check = checkFor(e, ctx);
  const result: Check | null = check ? await pollUntil(check, timeoutMs, pollMs, stableMs) : null;
  const evidence = await ctx.evidence.capture(e.id, e.after_step);

  let outcome: Outcome;
  let detail: string;
  if (result === null) {
    outcome = "NO_EVIDENCE";
    detail = "a judged result needs a judge, and none is configured for this run";
  } else if (evidence.length === 0) {
    // PASS needs evidence for every expected result (manual: Definitions). No evidence, no outcome.
    outcome = "NO_EVIDENCE";
    detail = "the runner could not capture evidence for this check";
  } else if (result.ok) {
    outcome = "MATCH";
    detail = "matched";
  } else {
    outcome = "MISMATCH";
    detail = "did not match";
  }
  return {
    expected_ref: e.id,
    kind: e.kind,
    outcome,
    after_step: e.after_step,
    expected: describeExpected(e),
    actual: result?.actual ?? null,
    detail,
    evidence: evidence.map((r) => r.id),
  };
}
