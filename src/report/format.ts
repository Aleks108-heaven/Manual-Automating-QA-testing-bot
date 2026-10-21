// Renders a report as text for the terminal and for the stored report.txt. It reads the report only, never the
// run records, so what a person reads is what the report's JSON says.
import { join } from "node:path";
import { cleanForTerminal } from "./sanitize.ts";
import type { Report, CaseEntry, Stamp, StampName } from "./schema.ts";

function stamp(report: Report, name: StampName): Stamp {
  const s = report.header.stamps.find((x) => x.name === name);
  if (!s) throw new Error(`the report has no stamp ${name}`);
  return s;
}

const HASHES: ReadonlySet<StampName> = new Set(["config_hash", "actor_prompt_hash", "judge_prompt_hash", "bot_source_hash"]);

/** A stamp as text: the value, or every value when the runs disagree, or UNKNOWN when a run could not record it. */
function stampText(report: Report, name: StampName): string {
  const s = stamp(report, name);
  const show = (v: string) => (HASHES.has(name) ? v.slice(0, 12) : v);
  if (s.status === "same") return show(s.values[0] ?? "unknown");
  if (s.status === "mixed") return `MIXED (${s.values.map(show).join(" | ")})`;
  return s.values.length > 0 ? `UNKNOWN for some runs (${s.values.map(show).join(" | ")} for the others)` : "UNKNOWN (no run recorded it)";
}

function live(report: Report, name: "model_live" | "judge_live"): string {
  const s = stamp(report, name);
  if (s.status === "missing" || s.values.length === 0) return "";
  if (s.values.length > 1) return " (some scripted, some live)";
  if (s.values[0] === "false") return " (a scripted fake, not a language model)";
  if (s.values[0] === "true") return " (live)";
  return "";
}

export function formatHeader(report: Report): string[] {
  const out: string[] = [];
  const h = report.header;
  out.push(`Report   ${report.report_id}  generated ${report.generated_at}`);
  out.push(
    report.plan.source === "declared"
      ? `Plan     ${report.plan.cases.length} planned case(s), declared before the run`
      : `Plan     ${report.plan.cases.length} case(s) taken from the run records given. A case that was planned and never ran is not counted here.`,
  );
  out.push(`Target   ${stampText(report, "target")}  build ${stampText(report, "build")}`);
  out.push(`Config   sha256 ${stampText(report, "config_hash")}`);
  out.push(`Model    ${stampText(report, "model_id")}${live(report, "model_live")}`);
  out.push(`Judge    ${stampText(report, "judge_model_id")}${live(report, "judge_live")}`);
  out.push(`Prompts  actor.v1.md ${stampText(report, "actor_prompt_hash")}, judge.v1.md ${stampText(report, "judge_prompt_hash")}`);
  out.push(`Tools    bot ${stampText(report, "bot")} (source sha256 ${stampText(report, "bot_source_hash")}), Node ${stampText(report, "node")}, Playwright ${stampText(report, "playwright")}, axe-core ${stampText(report, "axe_core")}`);
  out.push(`Browser  ${stampText(report, "browser")}, sandbox ${stampText(report, "browser_sandbox") === "true" ? "on" : stampText(report, "browser_sandbox") === "false" ? "OFF" : stampText(report, "browser_sandbox")}`);
  out.push(`Pre-flight  a passed check came before ${h.preflight.runs_after_passed_preflight} of ${h.preflight.executed} executed run(s)`);
  const missing = h.stamps.filter((s) => s.status === "missing").map((s) => s.name);
  const mixed = h.stamps.filter((s) => s.status === "mixed").map((s) => s.name);
  if (missing.length > 0) out.push(`WARNING  these stamps are missing for at least one run: ${missing.join(", ")}. This report cannot show everything that produced it.`);
  if (mixed.length > 0) out.push(`NOTE     the runs disagree on: ${mixed.join(", ")}. Each case below lists its own values in the report's JSON.`);
  if (h.scripted) out.push("NOTE     a scripted fake stood in for the model or the judge. Scripted results test the machinery. They are not a language model's judgment and never fill a pilot gate.");
  return out;
}

export function formatCase(c: CaseEntry): string[] {
  const out: string[] = [];
  const line = (text = "") => out.push(text);
  const r = c.run;
  line(`Case     ${c.id}  ${c.title ?? "(title unknown)"}  (${c.priority ?? "priority unknown"})${c.control ? `  [${c.control}]` : ""}`);
  if (!r) {
    line("Result:  NOT EXECUTED (no verdict was produced, and a case that did not run is not verified)");
    line(`  ${c.rationale}`);
    for (const a of c.attention) line(`  ATTENTION ${a.message}`);
    return out;
  }
  line(`Run      ${r.run_id}  record ${join(r.run_dir, "run.json")}`);
  line(`Target   ${r.target}  build ${r.build ?? "unknown"}`);
  line(`Versions model ${r.versions.model_id}${r.versions.model_live ? "" : " (scripted)"} via client ${r.versions.model_client}, Playwright ${r.versions.playwright}, browser ${r.versions.browser}`);
  if (!r.versions.browser_sandbox) line("WARNING  the browser sandbox was OFF for this run. Use that only inside an isolating container.");
  if (r.frozen) {
    const f = r.frozen;
    const again = {
      not_needed: "every script step ran",
      not_requested: "a script step could not run and no proposer was configured",
      proposal_written: `a script step could not run, so the agent was asked only to propose a change (${f.proposal_file ?? "no file"}); a person decides, and the verdict does not depend on it`,
      proposal_invalid: `a script step could not run and the agent gave no valid proposal after ${f.proposal_attempts} attempt(s)`,
    }[f.reengagement];
    line(`Script   frozen script ${f.case_id} version ${f.script_version}, hash ${f.script_hash.slice(0, 12)}, case hash ${f.case_hash.slice(0, 12)}; no model was called; ${again}`);
  }
  const b = r.budget;
  line(`Budget   ${b.used.tool_calls} of ${b.limits.max_tool_calls_per_run} tool calls, ${(b.used.wall_ms / 1000).toFixed(1)} s of ${b.limits.max_wall_ms / 1000} s, cost ${b.used.cost_usd.toFixed(4)} of ${b.limits.max_cost_usd} USD`);
  line(`Session  role ${r.session.role}${r.session.role === "none" ? " (no login)" : ", signed in by the runner"}`);
  line(`Secrets  ${r.redaction.secrets_tracked} tracked, ${r.redaction.replacements} replacements, artifact scan ${r.artifact_scan.findings === 0 ? "clean" : `FOUND ${r.artifact_scan.findings} (cleaned)`} over ${r.artifact_scan.files_scanned} files`);
  line();
  line(`Verdict: ${c.verdict}  (precedence row ${c.verdict_row})`);
  line(`  ${c.rationale}`);
  for (const o of r.outcomes) {
    line(`  ${o.expected_ref.padEnd(4)} ${o.outcome.padEnd(11)} ${o.expected}${o.outcome === "MATCH" ? "" : `   actual: ${o.actual ?? "n/a"}`}`);
  }
  for (const n of r.not_reached) line(`  ${n.id.padEnd(4)} NOT REACHED ${n.description}   (after step ${n.after_step})`);
  line(`  Steps (${r.steps.length} of ${r.steps_total} started)`);
  for (const s of r.steps) {
    const failed = s.actions.filter((a) => !a.ok).length;
    line(`    ${s.index}. ${s.text}  [${s.actions.length} action(s)${failed ? `, ${failed} failed` : ""}${s.evaluated.length ? `; checked ${s.evaluated.join(", ")}` : ""}]`);
    for (const p of s.screenshots) line(`       screenshots: ${p}`);
  }
  if (r.blocked) {
    line(`  Blocked at step ${r.blocked.step} (${r.blocked.reason}): ${r.blocked.step_text}`);
    if (r.blocked.tool_error) line(`    last tool error: ${r.blocked.tool_error}`);
    if (r.blocked.screenshot) line(`    screenshot: ${r.blocked.screenshot}`);
  }
  if (r.run_state.actor_stop_reason) line(`  Stopped: ${r.run_state.stop_source === "runner" ? "the runner's loop detection" : "the actor"} reported ${r.run_state.actor_stop_reason}`);
  if (r.run_state.runner_stop_reason) line(`  Stopped: the runner reported ${r.run_state.runner_stop_reason}${r.budget.stop ? ` (${r.budget.stop.detail})` : ""}`);
  if (r.run_state.infrastructure_failure) line(`  Infrastructure: ${r.run_state.infrastructure_failure}`);
  for (const e of r.guardrail_blocks) line(`  Guardrail blocked ${e.type}: ${e.url} (${e.detail})`);
  for (const e of r.cleanup_errors) line(`  Cleanup: ${e}`);
  if (r.model_output.attempts > 1 || !r.model_output.valid) {
    line(`  Model report: ${r.model_output.valid ? "accepted" : "rejected"} after ${r.model_output.attempts} attempt(s)${r.model_output.errors.length ? ` (${r.model_output.errors[r.model_output.errors.length - 1]})` : ""}`);
  }
  if (r.judge.configured) {
    line(`  Judge: ${r.judge.name}, ${r.judge.calls} call(s), ${r.judge.attempts} attempt(s)${r.judge.injection_reports ? `, ${r.judge.injection_reports} injection report(s)` : ""}`);
  }
  if (r.run_state.injection_suspected) line("  ALERT: an attempt to influence the bot was reported. The security reviewer should look at this run.");
  const imp = r.implicit;
  if (imp.enabled) {
    const total = imp.findings.length;
    line(`  Implicit checks: ${total} finding(s)${total ? ` (console ${imp.counts.console_error}, HTTP ${imp.counts.http_error}, failed requests ${imp.counts.failed_request}, images ${imp.counts.broken_image}, accessibility ${imp.counts.accessibility})` : ""}. Reported only: they do not change the verdict.`);
    for (const f of imp.findings.slice(0, 8)) line(`    - [${f.kind}${f.rule ? ` ${f.rule}` : ""}${f.impact ? `, ${f.impact}` : ""}] ${f.detail}${f.count > 1 ? ` (x${f.count})` : ""}`);
    if (total > 8) line(`    ... and ${total - 8} more in the report's JSON${imp.truncated ? " (the list was capped)" : ""}`);
  }
  line(`  Network log: ${r.har ?? "none"}. Trace: ${r.trace} (a Playwright trace cannot be scrubbed, so none is kept).`);
  if (c.bug_draft) {
    const d = c.bug_draft;
    line();
    line("  Draft bug report (a draft: a person sets the cause category, severity and priority)");
    if (d.control) line(`    NOTE: this case was changed on purpose (${d.control}). The FAIL is expected, so this is probably not a defect. A person decides.`);
    line(`    Title:          ${d.title}`);
    line(`    Build:          ${d.build ?? "unknown"}   Configuration: sha256 ${d.configuration.slice(0, 12)}   Target: ${d.target}   Role: ${d.role}`);
    line(`    Preconditions:  ${d.preconditions.length ? d.preconditions.join("; ") : "none listed"}`);
    line("    Steps to reproduce:");
    d.steps_to_reproduce.forEach((s, i) => line(`      ${i + 1}. ${s}`));
    line("    Expected vs actual:");
    for (const e of d.expected_vs_actual) {
      line(`      ${e.id}: expected ${e.expected}`);
      line(`          actual   ${e.actual ?? "n/a"}${e.detail ? ` (${e.detail})` : ""}`);
      for (const p of e.evidence) line(`          evidence ${p}`);
    }
    if (d.also_blocked) line(`    Also blocked:   ${d.also_blocked}`);
    line(`    Cause category: ${d.cause_category}   Suggested severity: none   Severity and priority: ${d.severity_and_priority}`);
    line(`    ${d.evidence_warning}`);
  }
  return out;
}

export function formatSummary(report: Report): string[] {
  const s = report.summary;
  const v = s.by_verdict;
  const out: string[] = [];
  out.push(`Summary: ${s.line}.`);
  // Executed cases that are not PASS are not verified either, so they are named here next to the ones that never ran.
  const notVerified = ([["FAIL", v.FAIL], ["BLOCKED", v.BLOCKED], ["INCONCLUSIVE", v.INCONCLUSIVE], ["INCOMPLETE", v.INCOMPLETE], ["not executed", v.NOT_EXECUTED]] as const)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${n}`);
  out.push(`  Verified (PASS): ${v.PASS}. Not verified: ${notVerified.length > 0 ? notVerified.join(", ") : "none"}. Only PASS is verified.`);
  const flagged = report.cases.filter((c) => c.attention.length > 0);
  if (flagged.length > 0) {
    out.push("Needs a person:");
    for (const c of flagged) for (const a of c.attention) out.push(`  ${c.id}  ${a.message}`);
  }
  return out;
}

/** The whole report as lines of text. */
export function formatReport(report: Report): string {
  const lines: string[] = [...formatHeader(report), ""];
  if (report.cases.length > 1) {
    for (const c of report.cases) lines.push(`  ${c.id.padEnd(12)} ${(c.verdict ?? "NOT EXECUTED").padEnd(13)} ${c.title ?? ""}${c.control ? `  [${c.control}]` : ""}`);
    lines.push("");
  }
  for (const c of report.cases) lines.push(...formatCase(c), "");
  lines.push(...formatSummary(report));
  return cleanForTerminal(lines.join("\n"));
}
