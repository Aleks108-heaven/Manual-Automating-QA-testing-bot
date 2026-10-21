import { cleanForTerminal } from "../report/sanitize.ts";
import type { ReleaseReport } from "./schema.ts";

/** The release report as text. It names the decision-maker and never states a decision. */
export function formatRelease(r: ReleaseReport): string {
  const out: string[] = [];
  const e = r.evidence;
  out.push(`Release  ${r.release_id}  generated ${r.generated_at}  deadlines checked against ${r.today}`);
  out.push(`Run report ${r.run_report_id}  candidate build ${r.candidate_build ?? "UNKNOWN"}`);
  out.push(`Decision  not made by the bot. Decision-maker: ${r.decision.decision_maker ?? "NOT CONFIGURED (release.decisionMaker)"}. ${r.decision.note}`);
  out.push("");
  out.push(`Evidence for the decision: ${e.status.toUpperCase()}`);
  for (const reason of e.reasons) out.push(`  - ${reason}`);
  out.push(`  P1 cases: ${e.p1.inventory} in the inventory. Verified ${e.p1.verified}, quarantined ${e.p1.quarantined}, overridden ${e.p1.overridden}, blocking ${e.p1.blocking}, not in the run ${e.p1.not_in_run}.`);
  out.push("");
  for (const c of r.p1_cases) out.push(`  ${c.id.padEnd(12)} ${c.state.toUpperCase().padEnd(12)} ${c.title ?? ""}  ${c.note}`);
  out.push("");
  out.push(`Quarantined cases (${r.quarantines.length}). They are listed in every release report.`);
  for (const q of r.quarantines) {
    out.push(`  ${q.case_id}  ${q.status.toUpperCase()}  owner ${q.owner}, approved by ${q.approver}, since ${q.quarantined_on}, deadline ${q.deadline}. ${q.reason}. Verdict in this run: ${q.verdict_in_run ?? "not in the run"}.${q.problem ? ` PROBLEM: ${q.problem}.` : ""}`);
  }
  if (r.quarantines.length === 0) out.push("  none");
  out.push(`Overrides (${r.overrides.length}). Each one is reviewed monthly.`);
  for (const o of r.overrides) {
    out.push(`  ${o.case_id}  ${o.status.toUpperCase()}  run ${o.run_id}, approved by ${o.approver}, triage ${o.triage_result}, on ${o.recorded_on}. ${o.reason}. Evidence: ${o.evidence.join(", ")}.${o.problem ? ` PROBLEM: ${o.problem}.` : ""}`);
  }
  if (r.overrides.length === 0) out.push("  none");
  if (r.problems.length > 0) {
    out.push("Faults a person must fix:");
    for (const p of r.problems) out.push(`  - ${p}`);
  }
  return cleanForTerminal(out.join("\n"));
}
