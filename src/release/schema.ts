import { z } from "zod";
import { VerdictSchema } from "../schemas/common.ts";

// The release report is a view over a run report and the register of quarantines and overrides. It shows the evidence
// for the release decision and never makes it: "A bot PASS is evidence for that decision, never the decision"
// (manual: Roles and decision rights). Quarantine and override rules are on the manual's Reading results page.

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use a date as YYYY-MM-DD");

/** The causes a person can record when triaging (manual: Reading results, cause categories). */
export const TRIAGE_RESULTS = ["tool_or_agent_error", "case_issue", "environment", "requirement_change", "flaky_or_unexplained", "app_defect"] as const;

export const QuarantineSchema = z.strictObject({
  case_id: z.string().min(1),
  owner: z.string().min(1),
  approver: z.string().min(1),
  reason: z.string().min(1),
  quarantined_on: Day,
  deadline: Day,
});
export type Quarantine = z.infer<typeof QuarantineSchema>;

export const OverrideSchema = z.strictObject({
  case_id: z.string().min(1),
  /** The run whose FAIL this overrides. An override never carries over to a later run. */
  run_id: z.string().min(1),
  approver: z.string().min(1),
  triage_result: z.enum(TRIAGE_RESULTS),
  /** Where the evidence is (paths or links). An override without evidence is refused. */
  evidence: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  recorded_on: Day,
});
export type Override = z.infer<typeof OverrideSchema>;

export const RegisterSchema = z.strictObject({
  quarantines: z.array(QuarantineSchema),
  overrides: z.array(OverrideSchema),
});
export type Register = z.infer<typeof RegisterSchema>;

const P1_STATES = ["verified", "quarantined", "overridden", "blocking", "not_in_run"] as const;

export const ReleaseReportSchema = z
  .strictObject({
    schema_version: z.literal(1),
    release_id: z.string().min(1),
    generated_at: z.string(),
    /** The day the deadlines were checked against. */
    today: Day,
    run_report_id: z.string().min(1),
    /** The one build every executed run saw, or null when the runs saw none or several. */
    candidate_build: z.string().nullable(),
    decision: z.strictObject({
      made_by_bot: z.literal(false),
      decision_maker: z.string().nullable(),
      note: z.string(),
    }),
    evidence: z.strictObject({
      /** complete: every P1 case is accounted for and nothing below is wrong. It is evidence, not a decision. */
      status: z.enum(["complete", "incomplete"]),
      reasons: z.array(z.string()),
      p1: z.strictObject({
        inventory: z.number().int(),
        verified: z.number().int(),
        quarantined: z.number().int(),
        overridden: z.number().int(),
        blocking: z.number().int(),
        not_in_run: z.number().int(),
      }),
    }),
    p1_cases: z.array(z.strictObject({ id: z.string(), title: z.string().nullable(), state: z.enum(P1_STATES), verdict: VerdictSchema.nullable(), note: z.string() })),
    quarantines: z.array(QuarantineSchema.extend({ status: z.enum(["active", "overdue", "invalid"]), problem: z.string().nullable(), verdict_in_run: VerdictSchema.nullable() })),
    overrides: z.array(OverrideSchema.extend({ status: z.enum(["applied", "invalid"]), problem: z.string().nullable() })),
    /** Faults in the inputs themselves (an unreadable case file). Each one keeps the evidence incomplete. */
    problems: z.array(z.string()),
  })
  .superRefine((r, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const count = (s: (typeof P1_STATES)[number]) => r.p1_cases.filter((c) => c.state === s).length;
    const p = r.evidence.p1;
    if (p.inventory !== r.p1_cases.length) fail("evidence.p1.inventory does not equal the P1 cases listed");
    for (const [name, state] of [["verified", "verified"], ["quarantined", "quarantined"], ["overridden", "overridden"], ["blocking", "blocking"], ["not_in_run", "not_in_run"]] as const) {
      if (p[name] !== count(state)) fail(`evidence.p1.${name} is inconsistent`);
    }
    // A report cannot call the evidence complete while a P1 case is blocking, missing, or a fault was found.
    if (r.evidence.status === "complete" && (p.blocking > 0 || p.not_in_run > 0 || r.problems.length > 0 || r.evidence.reasons.length > 0)) fail("the evidence is called complete although it is not");
    if (r.evidence.status === "incomplete" && r.evidence.reasons.length === 0) fail("incomplete evidence must say why");
  });
export type ReleaseReport = z.infer<typeof ReleaseReportSchema>;
