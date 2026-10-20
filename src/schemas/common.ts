import { z } from "zod";

// Verdict and outcome names are defined on the manual's Definitions page
// (docs/manual/05-definitions.md). Change them there first, then here.
export const VERDICTS = ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "INCOMPLETE"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VerdictSchema = z.enum(VERDICTS);

export const OUTCOMES = ["MATCH", "MISMATCH", "NO_EVIDENCE"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OutcomeSchema = z.enum(OUTCOMES);

// Stop reasons the actor may report (prompts/actor.v1.md). Budget, timeout and crash
// stops are decided by the runner, not by the actor.
export const ACTOR_STOP_REASONS = ["element_missing", "step_ambiguous", "loop"] as const;
export type ActorStopReason = (typeof ACTOR_STOP_REASONS)[number];

export const RUNNER_STOP_REASONS = ["budget", "timeout", "crash"] as const;
export type RunnerStopReason = (typeof RUNNER_STOP_REASONS)[number];

/** How a case or a tool names an element: by accessible role and name, or by selector. */
export const WhereSchema = z.union([
  z.strictObject({ role: z.string().min(1), name: z.string().min(1).optional() }),
  z.strictObject({ selector: z.string().min(1) }),
]);
export type Where = z.infer<typeof WhereSchema>;

export function describeWhere(where: Where): string {
  if ("selector" in where) return `selector ${where.selector}`;
  return where.name === undefined ? `role ${where.role}` : `role ${where.role}, name "${where.name}"`;
}
