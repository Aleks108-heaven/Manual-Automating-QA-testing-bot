import { z } from "zod";
import { OutcomeSchema, RUNNER_STOP_REASONS, ACTOR_STOP_REASONS, VerdictSchema } from "./common.ts";

// Run record, schema version 0 (M1). The final schema arrives in M2. The evidence store,
// the reporter and, later, the freezer are views over this record.

export const EvidenceRefSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["screenshot", "snapshot", "network"]),
  path: z.string().min(1), // relative to the run directory
  step: z.number().int().min(0),
  expected_ref: z.string().min(1).optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ActionRecordSchema = z.strictObject({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  ok: z.boolean(),
  error: z.string().optional(),
  // Filled from M2 on, so that the freezer can replay actions with stable locators.
  resolved_locator: z.string().optional(),
});
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

export const StepRecordSchema = z.strictObject({
  index: z.number().int().min(1),
  text: z.string(),
  actions: z.array(ActionRecordSchema),
});
export type StepRecord = z.infer<typeof StepRecordSchema>;

export const OutcomeRecordSchema = z.strictObject({
  expected_ref: z.string().min(1),
  kind: z.string().min(1),
  outcome: OutcomeSchema,
  after_step: z.number().int().min(1),
  expected: z.string(),
  actual: z.string().nullable(),
  detail: z.string(),
  evidence: z.array(z.string()),
});
export type OutcomeRecord = z.infer<typeof OutcomeRecordSchema>;

export const GuardrailEventSchema = z.strictObject({
  at: z.string(),
  type: z.enum(["navigation", "request", "popup", "frame", "websocket", "scheme"]),
  decision: z.enum(["allowed", "blocked"]),
  url: z.string(),
  detail: z.string(),
});
export type GuardrailEvent = z.infer<typeof GuardrailEventSchema>;

export const RunStateSchema = z.strictObject({
  actor_stop_reason: z.enum(ACTOR_STOP_REASONS).nullable(),
  runner_stop_reason: z.enum(RUNNER_STOP_REASONS).nullable(),
  infrastructure_failure: z.string().nullable(), // a description, or null
  guardrail_block: z.boolean(),
  injection_suspected: z.boolean(),
});
export type RunState = z.infer<typeof RunStateSchema>;

export const RunRecordSchema = z.strictObject({
  schema_version: z.literal(0),
  run_id: z.string().min(1),
  case: z.strictObject({ id: z.string(), title: z.string(), priority: z.string(), source: z.string() }),
  started_at: z.string(),
  finished_at: z.string(),
  target: z.string(),
  versions: z.strictObject({
    bot: z.string(),
    node: z.string(),
    playwright: z.string(),
    browser: z.string(),
    model_client: z.string(),
    prompt_hashes: z.record(z.string(), z.string()),
    build: z.string().nullable(),
  }),
  steps: z.array(StepRecordSchema),
  observations: z.array(z.strictObject({ expected_ref: z.string(), observed: z.string().nullable(), evidence: z.array(z.string()) })),
  outcomes: z.array(OutcomeRecordSchema),
  evidence: z.array(EvidenceRefSchema),
  guardrail_events: z.array(GuardrailEventSchema),
  run_state: RunStateSchema,
  verdict: VerdictSchema,
  verdict_row: z.number().int().min(1).max(7),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
