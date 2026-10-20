// The verdict calculator. Pure code, no LLM. It implements the precedence table on the manual's
// Definitions page (docs/manual/05-definitions.md): the first matching row wins.
import type { ActorStopReason, Outcome, RunnerStopReason, Verdict } from "../schemas/common.ts";

/**
 * The verdict of each row of the precedence table, in order. A test compares this list with the table
 * in docs/manual/05-definitions.md, so the manual and the code cannot drift apart.
 */
export const PRECEDENCE_ROWS: ReadonlyArray<{ row: number; verdict: Verdict }> = [
  { row: 1, verdict: "INCONCLUSIVE" }, // infrastructure made the evidence unreliable
  { row: 2, verdict: "INCONCLUSIVE" }, // a guardrail block fired
  { row: 3, verdict: "FAIL" }, // any expected result is a MISMATCH
  { row: 4, verdict: "BLOCKED" }, // a step could not be performed
  { row: 5, verdict: "INCOMPLETE" }, // a budget or timeout stopped the run
  { row: 6, verdict: "INCONCLUSIVE" }, // NO_EVIDENCE, or an expected result never reached
  { row: 7, verdict: "PASS" }, // every expected result is a MATCH
];

export interface VerdictInput {
  /** Number of expected results in the case. A case with none is invalid and never reaches here. */
  expectedCount: number;
  /** One entry per expected result that was evaluated. Results never reached have no entry. */
  outcomes: ReadonlyArray<{ expected_ref: string; outcome: Outcome }>;
  runState: {
    /** A description when infrastructure made the evidence unreliable, otherwise null. */
    infrastructureFailure: string | null;
    /** True when the tool layer refused an undeclared mutation or an off-allowlist request. */
    guardrailBlock: boolean;
    actorStopReason: ActorStopReason | null;
    runnerStopReason: RunnerStopReason | null;
  };
}

export interface VerdictResult {
  verdict: Verdict;
  /** The row of the precedence table that decided it, 1 to 7. */
  row: number;
}

export function calculateVerdict(input: VerdictInput): VerdictResult {
  if (input.expectedCount < 1) throw new Error("a case needs at least one expected result");
  const { runState, outcomes } = input;

  // 1. Infrastructure made the evidence unreliable (build changed, health check failed, host unreachable, crash).
  if (runState.infrastructureFailure !== null || runState.runnerStopReason === "crash") return { verdict: "INCONCLUSIVE", row: 1 };
  // 2. A guardrail block fired.
  if (runState.guardrailBlock) return { verdict: "INCONCLUSIVE", row: 2 };
  // 3. Any expected result was observed and did not match.
  if (outcomes.some((o) => o.outcome === "MISMATCH")) return { verdict: "FAIL", row: 3 };
  // 4. The run stopped because a step could not be performed.
  if (runState.actorStopReason !== null) return { verdict: "BLOCKED", row: 4 };
  // 5. The run stopped on a budget or a timeout.
  if (runState.runnerStopReason === "budget" || runState.runnerStopReason === "timeout") return { verdict: "INCOMPLETE", row: 5 };
  // 6. Evidence is missing, or an expected result was never reached.
  const matched = outcomes.filter((o) => o.outcome === "MATCH").length;
  if (outcomes.some((o) => o.outcome === "NO_EVIDENCE") || outcomes.length < input.expectedCount) return { verdict: "INCONCLUSIVE", row: 6 };
  // 7. Every expected result matched.
  if (matched === input.expectedCount) return { verdict: "PASS", row: 7 };
  return { verdict: "INCONCLUSIVE", row: 6 };
}
