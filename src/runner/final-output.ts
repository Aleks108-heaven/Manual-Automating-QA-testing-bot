// Asking the model for its final report, checking it, and asking again if it is wrong.
// The report is never repaired: a missing field is not filled in, a wrong value is not corrected, an extra
// field is not dropped. A bad report is sent back with a description of what was wrong (field names and
// rules, never the values), within the same time and cost budget as everything else.
import { BudgetGuard, DeadlineExceeded, withDeadline, type BudgetStop } from "../agent/budget.ts";
import type { Config } from "../config.ts";
import type { ModelClient } from "../model/client.ts";
import type { Redactor } from "../redact/redactor.ts";
import { ActorOutputSchema, type ActorOutput } from "../schemas/actor.ts";
import type { TestCase } from "../schemas/case.ts";
import type { ActorStopReason } from "../schemas/common.ts";

export interface FinalOutputResult {
  output: ActorOutput | null;
  attempts: number;
  /** One description per rejected attempt. */
  errors: string[];
  /** Set when the budget ran out before a valid report arrived. */
  budgetStop: BudgetStop | null;
}

/** Turns a failed validation into a short description that names fields and rules but shows no values. */
export function describeProblem(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(report)"}: ${i.message}`).join("; ");
}

export async function requestFinalOutput(args: {
  model: ModelClient;
  testCase: TestCase;
  actorStop: { reason: ActorStopReason; step: number } | null;
  guard: BudgetGuard;
  config: Config;
  redactor: Redactor;
}): Promise<FinalOutputResult> {
  const { model, testCase, actorStop, guard, config, redactor } = args;
  const errors: string[] = [];
  let previousError: string | null = null;

  for (let attempt = 1; attempt <= config.modelOutput.maxAttempts; attempt += 1) {
    const stop = guard.check(0);
    if (stop) return { output: null, attempts: attempt - 1, errors, budgetStop: stop };

    let raw: unknown;
    try {
      raw = await withDeadline(model.finalOutput({ testCase, actorStop, attempt, previousError }), guard.remainingMs);
    } catch (error) {
      if (!(error instanceof DeadlineExceeded)) throw error;
      return { output: null, attempts: attempt, errors, budgetStop: { reason: "timeout", detail: `time limit of ${config.budgets.maxWallMs} ms reached while waiting for the final report` } };
    }
    guard.chargeUsage(model.consumeUsage?.());

    const parsed = ActorOutputSchema.safeParse(raw);
    let problem: string | null = null;
    if (!parsed.success) problem = describeProblem(parsed.error);
    else if ((parsed.data.stop_reason ?? null) !== (actorStop?.reason ?? null)) {
      problem = `stop_reason: the run ${actorStop ? `was stopped with ${actorStop.reason}` : "completed, so stop_reason must be null"}`;
    } else if (parsed.data.test_id !== testCase.id) {
      problem = `test_id: must be ${testCase.id}`;
    }
    if (problem === null && parsed.success) return { output: parsed.data, attempts: attempt, errors, budgetStop: null };

    problem = redactor.scrubText(problem ?? "invalid report");
    errors.push(problem);
    previousError = problem;
  }
  return { output: null, attempts: config.modelOutput.maxAttempts, errors, budgetStop: null };
}
