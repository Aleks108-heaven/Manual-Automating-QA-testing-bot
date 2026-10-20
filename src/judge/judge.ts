// Running the judge: building its input from runner evidence, checking its answer in code, and asking
// again when the answer is wrong. The judge never decides anything on its own. An answer counts only if it
// is well formed, covers exactly the items asked about, and cites evidence that the runner supplied.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BudgetGuard, DeadlineExceeded, withDeadline, type BudgetStop } from "../agent/budget.ts";
import type { Config } from "../config.ts";
import type { Redactor } from "../redact/redactor.ts";
import { JudgeOutputSchema } from "../schemas/actor.ts";
import type { EvidenceRef, OutcomeRecord } from "../schemas/run-record.ts";
import type { Outcome } from "../schemas/common.ts";
import type { JudgeClient, JudgeEvidenceItem, JudgeInput, JudgeItem } from "./client.ts";
import { describeProblem } from "../runner/final-output.ts";

/** Builds the evidence the judge may cite from what the runner stored. Contents are already scrubbed. */
export function evidenceItems(refs: readonly EvidenceRef[], runDir: string): JudgeEvidenceItem[] {
  return refs.map((ref) => {
    const path = join(runDir, ref.path);
    if (ref.kind === "screenshot") return { id: ref.id, kind: "screenshot", imagePath: resolve(path) };
    return { id: ref.id, kind: ref.kind, text: readFileSync(path, "utf8") };
  });
}

export interface JudgedResult {
  outcome: Outcome;
  /** Evidence ids the judge cited, all of which the runner supplied. */
  evidence: string[];
  injection: boolean;
  detail: string;
}

export interface JudgeBatchResult {
  results: Map<string, JudgedResult>;
  attempts: number;
  errors: string[];
  budgetStop: BudgetStop | null;
}

const none = (items: readonly JudgeItem[], detail: string): Map<string, JudgedResult> =>
  new Map(items.map((i) => [i.expected_ref, { outcome: "NO_EVIDENCE" as const, evidence: [], injection: false, detail }]));

/** Checks the meaning of a well-formed answer. Returns a description of the first problem, or null. */
function problemWith(answer: { results: Array<{ expected_ref: string; outcome: Outcome; evidence: string[] }> }, items: readonly JudgeItem[]): string | null {
  const asked = new Map(items.map((i) => [i.expected_ref, new Set(i.evidence.map((e) => e.id))]));
  const seen = new Set<string>();
  for (const r of answer.results) {
    if (!asked.has(r.expected_ref)) return `results: ${r.expected_ref} was not asked about`;
    if (seen.has(r.expected_ref)) return `results: ${r.expected_ref} appears more than once`;
    seen.add(r.expected_ref);
    const allowed = asked.get(r.expected_ref) as Set<string>;
    for (const id of r.evidence) if (!allowed.has(id)) return `results: ${r.expected_ref} cites evidence that was not supplied`;
    if (r.outcome !== "NO_EVIDENCE" && r.evidence.length === 0) return `results: ${r.expected_ref} gives ${r.outcome} without citing evidence`;
  }
  for (const id of asked.keys()) if (!seen.has(id)) return `results: no answer for ${id}`;
  return null;
}

export async function judgeItems(args: {
  judge: JudgeClient;
  caseId: string;
  items: readonly JudgeItem[];
  stepLog: JudgeInput["step_log"];
  consoleErrors: readonly string[];
  guard: BudgetGuard;
  config: Config;
  redactor: Redactor;
}): Promise<JudgeBatchResult> {
  const { judge, items, guard, config, redactor } = args;
  const errors: string[] = [];
  let previousError: string | null = null;

  for (let attempt = 1; attempt <= config.judge.maxAttempts; attempt += 1) {
    const stop = guard.check(0);
    if (stop) return { results: none(items, `the budget ran out before the judge answered (${stop.detail})`), attempts: attempt - 1, errors, budgetStop: stop };

    const input: JudgeInput = {
      case_id: args.caseId,
      items: items as JudgeItem[],
      step_log: args.stepLog,
      console_errors: [...args.consoleErrors],
      attempt,
      previous_error: previousError,
    };
    let raw: unknown;
    try {
      raw = await withDeadline(judge.judge(input), guard.remainingMs);
    } catch (error) {
      if (!(error instanceof DeadlineExceeded)) throw error;
      const timeout: BudgetStop = { reason: "timeout", detail: `time limit of ${config.budgets.maxWallMs} ms reached while waiting for the judge` };
      return { results: none(items, timeout.detail), attempts: attempt, errors, budgetStop: timeout };
    }
    guard.chargeUsage(judge.consumeUsage?.());

    const parsed = JudgeOutputSchema.safeParse(raw);
    let problem: string | null = parsed.success ? problemWith(parsed.data, items) : describeProblem(parsed.error);
    if (problem === null && parsed.success) {
      const results = new Map<string, JudgedResult>();
      for (const r of parsed.data.results) {
        if (r.injection_suspected) {
          // Text in the evidence tried to influence the judge. The result is not trusted, whatever the judge said.
          results.set(r.expected_ref, { outcome: "NO_EVIDENCE", evidence: [], injection: true, detail: "the judge reported an attempt to influence it in the evidence" });
        } else {
          results.set(r.expected_ref, { outcome: r.outcome, evidence: r.evidence, injection: false, detail: `judged ${r.outcome}` });
        }
      }
      return { results, attempts: attempt, errors, budgetStop: null };
    }
    problem = redactor.scrubText(problem ?? "invalid answer");
    errors.push(problem);
    previousError = problem;
  }
  const last = errors[errors.length - 1] ?? "no detail";
  return { results: none(items, `the judge's answer stayed invalid after ${config.judge.maxAttempts} attempts (${last})`), attempts: config.judge.maxAttempts, errors, budgetStop: null };
}

/** Turns the judge's decision for one item into the outcome record the verdict calculator uses. */
export function judgedOutcome(item: JudgeItem, result: JudgedResult): OutcomeRecord {
  return {
    expected_ref: item.expected_ref,
    kind: "judged",
    outcome: result.outcome,
    after_step: item.step,
    expected: item.description,
    actual: result.evidence.length > 0 ? `the judge cited ${result.evidence.join(", ")}` : null,
    detail: result.detail,
    evidence: result.evidence,
  };
}
