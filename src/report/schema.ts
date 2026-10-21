import { z } from "zod";
import { VERDICTS, VerdictSchema } from "../schemas/common.ts";
import { GuardrailEventSchema, OutcomeRecordSchema, RunRecordSchema } from "../schemas/run-record.ts";

// The report is a view over the run records (build brief: Run record). Everything in it comes from stored run
// records and the declared plan; nothing is asked of a model. The anatomy is on the manual's page "Reading results
// and triage": header, summary line, per-case detail, and for a FAIL the expected vs actual and a draft bug report.

const record = RunRecordSchema.shape;

/** The one form of the summary line (manual: Reading results). It is built in exactly one place. */
export function summaryLine(counts: { planned: number; executed: number; notVerified: number }): string {
  return `bot executed ${counts.executed} of ${counts.planned} planned cases, ${counts.notVerified} not verified`;
}

export const STAMP_NAMES = [
  "target",
  "build",
  "config_hash",
  "model_id",
  "model_live",
  "judge_model_id",
  "judge_live",
  "actor_prompt_hash",
  "judge_prompt_hash",
  "bot",
  "bot_source_hash",
  "node",
  "playwright",
  "axe_core",
  "browser",
  "browser_sandbox",
] as const;
export type StampName = (typeof STAMP_NAMES)[number];

/**
 * One version stamp across all the runs in a report. same: every run agrees. mixed: the runs disagree, and each
 * case carries its own value. missing: at least one run could not record it, so the report is not fully reproducible.
 */
const StampSchema = z.strictObject({
  name: z.enum(STAMP_NAMES),
  status: z.enum(["same", "mixed", "missing"]),
  values: z.array(z.string()),
});
export type Stamp = z.infer<typeof StampSchema>;

const StepViewSchema = z.strictObject({
  index: z.number().int().min(1),
  text: z.string(),
  actions: z.array(z.strictObject({ tool: z.string(), args: z.record(z.string(), z.unknown()), ok: z.boolean(), error: z.string().optional() })),
  /** Screenshots the runner took at this step, as paths. */
  screenshots: z.array(z.string()),
  /** The expected results evaluated after this step. */
  evaluated: z.array(z.string()),
});

const AttentionSchema = z.strictObject({
  kind: z.enum(["p1_not_pass", "guardrail_block", "injection_suspected", "scrubber_finding", "cleanup_failed", "model_report_invalid", "sandbox_off", "frozen_step_could_not_run", "run_record_rejected"]),
  /** Who the manual says should look at it, and why. */
  message: z.string(),
});
export type Attention = z.infer<typeof AttentionSchema>;

const BugDraftSchema = z.strictObject({
  draft: z.literal(true),
  /** Set when the case was changed on purpose. The FAIL is then expected, and the draft is probably not a defect. */
  control: z.string().nullable(),
  title: z.string(),
  build: z.string().nullable(),
  configuration: z.string(),
  target: z.string(),
  role: z.string(),
  preconditions: z.array(z.string()),
  steps_to_reproduce: z.array(z.string()),
  expected_vs_actual: z.array(z.strictObject({ id: z.string(), expected: z.string(), actual: z.string().nullable(), detail: z.string(), evidence: z.array(z.string()) })),
  /** Set when a step was also blocked after the mismatch. The manual says the report lists it. */
  also_blocked: z.string().nullable(),
  /** A person sets this when triaging (manual: cause categories). The bot never guesses it. */
  cause_category: z.literal("untriaged"),
  /** The manual allows a suggestion, as a draft only. The bot makes none, so no rule can pass for judgment. */
  suggested_severity: z.null(),
  severity_and_priority: z.literal("to be set by a person"),
  evidence_warning: z.string(),
});
export type BugDraft = z.infer<typeof BugDraftSchema>;

const RunViewSchema = z.strictObject({
  run_id: z.string(),
  run_dir: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  target: z.string(),
  build: z.string().nullable(),
  /** This run's own stamps, because a report may mix runs. */
  versions: record.versions,
  preflight: record.preflight,
  session: record.session,
  budget: record.budget,
  redaction: record.redaction,
  artifact_scan: record.artifact_scan,
  judge: record.judge,
  model_output: record.model_output,
  run_state: record.run_state,
  implicit: record.implicit,
  /** Set when the run replayed an approved frozen script: which one (version and hash) and whether a step could not run. */
  frozen: record.frozen,
  steps_total: z.number().int().min(1),
  steps: z.array(StepViewSchema),
  outcomes: z.array(OutcomeRecordSchema),
  /** Expected results the run never reached (they have no outcome). */
  not_reached: z.array(z.strictObject({ id: z.string(), after_step: z.number().int(), description: z.string() })),
  blocked: z.strictObject({ step: z.number().int(), step_text: z.string(), reason: z.string(), source: z.enum(["actor", "runner"]), tool_error: z.string().nullable(), screenshot: z.string().nullable() }).nullable(),
  guardrail_blocks: z.array(GuardrailEventSchema),
  cleanup_errors: z.array(z.string()),
  /** The scrubbed HAR. A Playwright trace is never recorded, because it cannot be scrubbed. */
  har: z.string().nullable(),
  trace: z.literal("not recorded"),
});
export type RunView = z.infer<typeof RunViewSchema>;

const CaseEntrySchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().nullable(),
  priority: z.string().nullable(),
  source: z.string(),
  /** Set when the case was changed on purpose (a negative control). Its FAIL is expected. */
  control: z.string().nullable(),
  /** executed: the run produced a run record that passed the reporter's checks. */
  status: z.enum(["executed", "not_executed"]),
  /** Why there is no accepted run, or null when the case was executed. */
  not_executed_reason: z.string().nullable(),
  verdict: VerdictSchema.nullable(),
  verdict_row: z.number().int().min(1).max(7).nullable(),
  /** Only PASS is verified (manual: Definitions). */
  verified: z.boolean(),
  rationale: z.string(),
  attention: z.array(AttentionSchema),
  run: RunViewSchema.nullable(),
  bug_draft: BugDraftSchema.nullable(),
});
export type CaseEntry = z.infer<typeof CaseEntrySchema>;

const SummarySchema = z.strictObject({
  planned: z.number().int().min(1),
  executed: z.number().int().min(0),
  not_executed: z.number().int().min(0),
  verified: z.number().int().min(0),
  not_verified: z.number().int().min(0),
  by_verdict: z.strictObject({
    PASS: z.number().int(),
    FAIL: z.number().int(),
    BLOCKED: z.number().int(),
    INCONCLUSIVE: z.number().int(),
    INCOMPLETE: z.number().int(),
    NOT_EXECUTED: z.number().int(),
  }),
  line: z.string(),
});

export const ReportSchema = z
  .strictObject({
    schema_version: z.literal(1),
    report_id: z.string().min(1),
    generated_at: z.string(),
    plan: z.strictObject({
      /** declared: the caller named the planned cases. from_records: the plan is only the runs that were given, so Y cannot count a case that never ran. */
      source: z.enum(["declared", "from_records"]),
      cases: z.array(z.strictObject({ id: z.string(), source: z.string() })).min(1),
    }),
    header: z.strictObject({
      stamps: z.array(StampSchema),
      /** False when any stamp is missing: the report then cannot show what produced it. */
      complete_stamps: z.boolean(),
      /** The pre-flight check that allowed each executed run: how many ran after a passed one. */
      preflight: z.strictObject({ runs_after_passed_preflight: z.number().int(), executed: z.number().int() }),
      /** True when any actor or judge was a scripted fake rather than a language model. */
      scripted: z.boolean(),
    }),
    summary: SummarySchema,
    cases: z.array(CaseEntrySchema).min(1),
  })
  .superRefine((report, ctx) => {
    // A stored report is checked against itself, so a hand-edited summary cannot claim more than the cases show.
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const s = report.summary;
    if (s.planned !== report.cases.length) fail("summary.planned does not equal the number of cases");
    if (s.executed !== report.cases.filter((c) => c.status === "executed").length) fail("summary.executed does not equal the executed cases");
    if (s.not_executed !== s.planned - s.executed) fail("summary.not_executed is inconsistent");
    if (s.verified !== report.cases.filter((c) => c.verdict === "PASS").length) fail("summary.verified does not equal the PASS cases");
    if (s.not_verified !== s.planned - s.verified) fail("summary.not_verified must be every planned case that is not PASS");
    for (const v of VERDICTS) {
      if (s.by_verdict[v] !== report.cases.filter((c) => c.verdict === v).length) fail(`summary.by_verdict.${v} is inconsistent`);
    }
    if (s.by_verdict.NOT_EXECUTED !== s.not_executed) fail("summary.by_verdict.NOT_EXECUTED is inconsistent");
    if (s.line !== summaryLine({ planned: s.planned, executed: s.executed, notVerified: s.not_verified })) fail("summary.line is not the required form");
    for (const c of report.cases) {
      if ((c.status === "executed") !== (c.run !== null)) fail(`${c.id}: status and run disagree`);
      if ((c.status === "executed") !== (c.verdict !== null)) fail(`${c.id}: status and verdict disagree`);
      if (c.verified !== (c.verdict === "PASS")) fail(`${c.id}: only PASS is verified`);
    }
  });
export type Report = z.infer<typeof ReportSchema>;
