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
  // Who decided the stop: the model reported it, or the runner's loop detection did.
  stop_source: z.enum(["actor", "runner"]).nullable(),
  runner_stop_reason: z.enum(RUNNER_STOP_REASONS).nullable(),
  infrastructure_failure: z.string().nullable(), // a description, or null
  guardrail_block: z.boolean(),
  injection_suspected: z.boolean(),
});
export type RunState = z.infer<typeof RunStateSchema>;

export const BudgetRecordSchema = z.strictObject({
  limits: z.strictObject({
    max_tool_calls_per_run: z.number(),
    max_tool_calls_per_step: z.number(),
    max_wall_ms: z.number(),
    max_cost_usd: z.number(),
  }),
  used: z.strictObject({
    tool_calls: z.number(),
    wall_ms: z.number(),
    cost_usd: z.number(),
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
  stop: z.strictObject({ reason: z.enum(["budget", "timeout"]), detail: z.string() }).nullable(),
});
export type BudgetRecord = z.infer<typeof BudgetRecordSchema>;

// Run record, schema version 2 (M3). Version 0 (M1) had no session, budget, redaction or scan sections (added in
// version 1, M2). Version 2 adds how the model's final report fared, and the judge, implicit-check and
// blocked-step sections.
export const RunRecordSchema = z.strictObject({
  schema_version: z.literal(2),
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
    // false means the Chromium sandbox was off for this run. It is only acceptable inside an isolating container.
    browser_sandbox: z.boolean(),
    model_client: z.string(),
    prompt_hashes: z.record(z.string(), z.string()),
    build: z.string().nullable(),
  }),
  steps: z.array(StepRecordSchema),
  observations: z.array(z.strictObject({ expected_ref: z.string(), observed: z.string().nullable(), evidence: z.array(z.string()) })),
  outcomes: z.array(OutcomeRecordSchema),
  evidence: z.array(EvidenceRefSchema),
  guardrail_events: z.array(GuardrailEventSchema),
  // A failed cleanup does not change the verdict. It is reported here for the staging owner.
  cleanup_errors: z.array(z.string()),
  // The role the case ran as and how its session was made. Never the session file or any token.
  session: z.strictObject({ role: z.string(), mode: z.literal("per-case"), established: z.boolean() }),
  budget: BudgetRecordSchema,
  // Set when the run stopped because a step could not be performed (BLOCKED). The manual requires the step, the
  // reason and a screenshot. The runner captures the screenshot itself, at the moment of the stop.
  blocked: z
    .strictObject({
      step: z.number().int().min(1),
      step_text: z.string(),
      reason: z.enum(ACTOR_STOP_REASONS),
      source: z.enum(["actor", "runner"]),
      tool_error: z.string().nullable(),
      evidence: z.array(z.string()),
    })
    .nullable(),
  // Implicit findings: reported with the verdict, never part of it (manual: Definitions).
  implicit: z.strictObject({
    enabled: z.boolean(),
    findings: z.array(
      z.strictObject({
        kind: z.enum(["console_error", "http_error", "failed_request", "broken_image", "accessibility"]),
        step: z.number().int().min(1),
        page: z.string(),
        detail: z.string(),
        rule: z.string().optional(),
        impact: z.string().optional(),
        count: z.number().int(),
      }),
    ),
    counts: z.strictObject({
      console_error: z.number().int(),
      http_error: z.number().int(),
      failed_request: z.number().int(),
      broken_image: z.number().int(),
      accessibility: z.number().int(),
    }),
    truncated: z.boolean(),
  }),
  // How the judge was used for the judged expected results. The judge sees only runner-captured evidence.
  judge: z.strictObject({
    configured: z.boolean(),
    name: z.string().nullable(),
    calls: z.number().int(),
    attempts: z.number().int(),
    errors: z.array(z.string()),
    injection_reports: z.number().int(),
  }),
  // How the model's final report fared: how many times it was requested, and why each rejected one was rejected.
  model_output: z.strictObject({ attempts: z.number().int(), valid: z.boolean(), errors: z.array(z.string()) }),
  // How much was scrubbed. Counts only, never values.
  redaction: z.strictObject({ secrets_tracked: z.number().int(), replacements: z.number().int() }),
  // The final scan of everything stored. findings above 0 means the scrubber has a defect.
  artifact_scan: z.strictObject({ files_scanned: z.number().int(), findings: z.number().int(), cleaned: z.boolean() }),
  artifacts: z.strictObject({ har: z.string().nullable(), model_context: z.string().nullable() }),
  run_state: RunStateSchema,
  verdict: VerdictSchema,
  verdict_row: z.number().int().min(1).max(7),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
