// Builds a report from stored run records. The reporter adds nothing the records do not hold, and it does not take a
// record's word for its own verdict: it recomputes the verdict from the stored outcomes and run state with the same
// calculator the runner used, and it refuses a record that disagrees with itself.
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hashText } from "../hash.ts";
import { READ_LIMITS, readTextCapped, TooLargeError } from "../safe-read.ts";
import { RunRecordSchema, type RunRecord } from "../schemas/run-record.ts";
import type { Verdict } from "../schemas/common.ts";
import { calculateVerdict } from "../verdict/calculate.ts";
import { ReportSchema, STAMP_NAMES, summaryLine, type Attention, type BugDraft, type CaseEntry, type Report, type RunView, type Stamp, type StampName } from "./schema.ts";

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

/** A case the caller planned to run. The title and priority are what the caller knows when no run exists. */
export interface PlanEntry {
  id: string;
  source: string;
  title?: string;
  priority?: string;
  /** Why the case has no run, when the caller knows (the kill switch was engaged, the pre-flight check failed, the case was invalid). */
  notRunReason?: string;
  /** Set when the case was changed on purpose, for example "negative control: e1 was made wrong". */
  control?: string;
}

/** A run record read from disk, with the hash of the file it came from. The report carries the hash, so a later reader can tell if the file changed. */
export type LoadedRun = { path: string; runDir: string } & ({ record: RunRecord; recordHash: string } | { error: string });

const SUPPORTED_VERSION = 6;

/** Reads one run record from a run directory or a run.json path. A record it cannot read becomes an error, never a guess. */
export function loadRun(path: string): LoadedRun {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "run.json") : path;
  const runDir = dirname(file);
  if (!existsSync(file)) return { path, runDir, error: "there is no run.json there" };
  let text: string;
  try {
    text = readTextCapped(file, READ_LIMITS.runRecord, "run.json");
  } catch (error) {
    return { path, runDir, error: error instanceof TooLargeError ? error.message : "run.json could not be read" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { path, runDir, error: "run.json is not valid JSON" };
  }
  const version = (raw as { schema_version?: unknown } | null)?.schema_version;
  if (version !== SUPPORTED_VERSION) {
    return { path, runDir, error: `run record schema version ${typeof version === "number" ? version : "unknown"} is not supported (this reporter reads version ${SUPPORTED_VERSION}), so its version stamps cannot be trusted` };
  }
  const parsed = RunRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { path, runDir, error: `run.json does not match the run record schema (${issues.join("; ")})` };
  }
  return { path, runDir, record: parsed.data, recordHash: hashText(text) };
}

/**
 * Checks that a record agrees with itself. Returns the problems found, or an empty list. A record with a problem is
 * not reported as executed, because the report could not vouch for its verdict.
 */
export function checkRecord(record: RunRecord): string[] {
  const problems: string[] = [];
  const expectedIds = new Set(record.case.expected.map((e) => e.id));
  if (expectedIds.size !== record.case.expected.length) problems.push("the case lists the same expected result id twice");
  const seen = new Set<string>();
  for (const o of record.outcomes) {
    if (!expectedIds.has(o.expected_ref)) problems.push(`an outcome names ${o.expected_ref}, which is not an expected result of the case`);
    if (seen.has(o.expected_ref)) problems.push(`two outcomes name ${o.expected_ref}`);
    seen.add(o.expected_ref);
  }
  const recomputed = calculateVerdict({
    expectedCount: record.case.expected.length,
    outcomes: record.outcomes.map((o) => ({ expected_ref: o.expected_ref, outcome: o.outcome })),
    runState: {
      infrastructureFailure: record.run_state.infrastructure_failure,
      guardrailBlock: record.run_state.guardrail_block,
      actorStopReason: record.run_state.actor_stop_reason,
      runnerStopReason: record.run_state.runner_stop_reason,
    },
  });
  if (recomputed.verdict !== record.verdict || recomputed.row !== record.verdict_row) {
    problems.push(`the stored verdict ${record.verdict} (row ${record.verdict_row}) does not follow from the stored outcomes and run state, which give ${recomputed.verdict} (row ${recomputed.row})`);
  }
  if (record.verdict === "PASS") {
    // A PASS needs runner-captured evidence for every expected result (CLAUDE.md, non-negotiable rules).
    const evidenceIds = new Set(record.evidence.map((e) => e.id));
    for (const o of record.outcomes) {
      if (o.evidence.length === 0) problems.push(`PASS, but ${o.expected_ref} has no evidence`);
      else if (o.evidence.some((id) => !evidenceIds.has(id))) problems.push(`PASS, but ${o.expected_ref} cites evidence the run did not store`);
    }
  }
  return problems;
}

function distinct(values: Array<string | null>): { values: string[]; anyMissing: boolean } {
  return { values: [...new Set(values.filter((v): v is string => v !== null))], anyMissing: values.some((v) => v === null) };
}

function stampValue(record: RunRecord, name: StampName): string | null {
  const v = record.versions;
  switch (name) {
    case "target": return record.target;
    case "build": return v.build;
    case "config_hash": return v.config_hash;
    case "model_id": return v.model_id;
    case "model_live": return String(v.model_live);
    // A run with no judge says so, which is a value, not a gap.
    case "judge_model_id": return record.judge.model_id ?? "none";
    case "judge_live": return record.judge.live === null ? "none" : String(record.judge.live);
    case "actor_prompt_hash": return v.prompt_hashes["actor.v1.md"] ?? null;
    case "judge_prompt_hash": return v.prompt_hashes["judge.v1.md"] ?? null;
    case "bot": return v.bot;
    case "bot_source_hash": return v.bot_source_hash;
    case "node": return v.node;
    case "playwright": return v.playwright;
    case "axe_core": return v.axe_core;
    // A run that never started a browser has no browser version to report.
    case "browser": return v.browser === "not started" ? null : v.browser;
    case "browser_sandbox": return String(v.browser_sandbox);
  }
}

function buildStamps(records: readonly RunRecord[]): Stamp[] {
  return STAMP_NAMES.map((name) => {
    const { values, anyMissing } = distinct(records.map((r) => stampValue(r, name)));
    // With no executed run there is nothing to stamp, and that is a gap, not an agreement.
    const status = records.length === 0 || anyMissing ? "missing" : values.length > 1 ? "mixed" : "same";
    return { name, status, values };
  });
}

function ids(list: readonly string[]): string {
  return list.join(", ");
}

/** One sentence on why the run ended as it did, from the run's own facts. The rules themselves live in the manual's Definitions page. */
export function rationale(record: RunRecord): string {
  const mismatched = record.outcomes.filter((o) => o.outcome === "MISMATCH").map((o) => o.expected_ref);
  const noEvidence = record.outcomes.filter((o) => o.outcome === "NO_EVIDENCE").map((o) => o.expected_ref);
  const reached = new Set(record.outcomes.map((o) => o.expected_ref));
  const notReached = record.case.expected.filter((e) => !reached.has(e.id)).map((e) => e.id);
  const s = record.run_state;
  switch (record.verdict_row) {
    case 1:
      return `Infrastructure made the evidence unreliable: ${s.infrastructure_failure ?? "the runner or a tool crashed"}.`;
    case 2: {
      const block = record.guardrail_events.find((g) => g.decision === "blocked");
      return `A guardrail refused ${block ? `a ${block.type} (${block.url}): ${block.detail}` : "a request"}, so no verdict is safe.`;
    }
    case 3:
      return `Expected result${mismatched.length > 1 ? "s" : ""} ${ids(mismatched)} did not match what the runner observed.${record.blocked ? ` Step ${record.blocked.step} was also blocked (${record.blocked.reason}).` : ""}`;
    case 4: {
      const b = record.blocked;
      return b ? `Step ${b.step} could not be performed (${b.reason}, decided by the ${b.source}): ${b.step_text}` : `The run stopped because a step could not be performed (${s.actor_stop_reason ?? "unknown"}).`;
    }
    case 5:
      return `The run stopped early (${s.runner_stop_reason ?? "unknown"}${record.budget.stop ? `: ${record.budget.stop.detail}` : ""}) after ${record.steps.length} of ${record.case.steps_total} steps were started.`;
    case 6: {
      const parts = [noEvidence.length > 0 ? `${ids(noEvidence)} had no evidence` : "", notReached.length > 0 ? `${ids(notReached)} ${notReached.length > 1 ? "were" : "was"} never reached` : ""].filter(Boolean);
      return `Not every expected result could be decided: ${parts.join(" and ")}.`;
    }
    default:
      return `All ${record.case.expected.length} expected result${record.case.expected.length > 1 ? "s" : ""} matched, each with evidence the runner captured.`;
  }
}

function attentionFor(priority: string | null, verdict: Verdict | null, record: RunRecord | null): Attention[] {
  const list: Attention[] = [];
  if (priority === "P1" && verdict !== "PASS") list.push({ kind: "p1_not_pass", message: "A P1 case that is not PASS needs human execution before release (manual: Definitions)." });
  if (!record) return list;
  if (record.run_state.guardrail_block) list.push({ kind: "guardrail_block", message: "A guardrail block fired. The security reviewer also reviews it (manual: Reading results)." });
  if (record.run_state.injection_suspected) list.push({ kind: "injection_suspected", message: "An attempt to influence the bot was reported. The security reviewer should look at this run." });
  if (record.artifact_scan.findings > 0) list.push({ kind: "scrubber_finding", message: "A credential was found in stored files. That is a defect in the scrubber, and a maintainer must look at it." });
  if (record.cleanup_errors.length > 0) list.push({ kind: "cleanup_failed", message: "Cleanup failed. It does not change the verdict, and the staging owner removes the leftovers." });
  if (!record.model_output.valid && record.model_output.attempts > 0) list.push({ kind: "model_report_invalid", message: "The model's final report stayed invalid, so a maintainer should check the bot's output." });
  if (!record.versions.browser_sandbox) list.push({ kind: "sandbox_off", message: "The browser sandbox was off. That is acceptable only inside an isolating container." });
  if (record.frozen && record.frozen.reengagement !== "not_needed") {
    list.push({
      kind: "frozen_step_could_not_run",
      message:
        record.frozen.reengagement === "proposal_written"
          ? "A step of the frozen script could not run. The agent was asked only to propose a change, and it wrote one. A person decides whether to approve it. It did not change this verdict."
          : record.frozen.reengagement === "proposal_invalid"
            ? "A step of the frozen script could not run. The agent was asked to propose a change and gave no valid proposal. A person must look at the script. It did not change this verdict."
            : "A step of the frozen script could not run, and no proposer was configured. A person must look at the script.",
    });
  }
  return list;
}

function bugDraft(record: RunRecord, runDir: string, control: string | null): BugDraft {
  const mismatched = record.outcomes.filter((o) => o.outcome === "MISMATCH");
  const pathOf = (id: string): string | null => {
    const e = record.evidence.find((x) => x.id === id);
    return e ? join(runDir, e.path) : null;
  };
  return {
    draft: true,
    control,
    title: `${record.case.id}: ${record.case.title} (${mismatched.length} expected result${mismatched.length > 1 ? "s" : ""} did not match: ${ids(mismatched.map((o) => o.expected_ref))})`,
    build: record.versions.build,
    configuration: record.versions.config_hash,
    target: record.target,
    role: record.session.role,
    preconditions: record.case.preconditions,
    steps_to_reproduce: record.steps.map((s) => s.text),
    expected_vs_actual: mismatched.map((o) => ({
      id: o.expected_ref,
      expected: o.expected,
      actual: o.actual,
      detail: o.detail,
      evidence: o.evidence.map(pathOf).filter((p): p is string => p !== null),
    })),
    also_blocked: record.blocked ? `step ${record.blocked.step} (${record.blocked.reason}): ${record.blocked.step_text}` : null,
    cause_category: "untriaged",
    suggested_severity: null,
    severity_and_priority: "to be set by a person",
    evidence_warning: "Scrub evidence before attaching it to a ticket, because traces and HAR files can hold cookies, auth headers and request bodies.",
  };
}

function runView(record: RunRecord, runDir: string, recordHash: string): RunView {
  const pathOf = (id: string): string | null => {
    const e = record.evidence.find((x) => x.id === id);
    return e ? join(runDir, e.path) : null;
  };
  const reached = new Set(record.outcomes.map((o) => o.expected_ref));
  const blockedShot = record.blocked?.evidence.find((id) => record.evidence.find((e) => e.id === id)?.kind === "screenshot");
  return {
    run_id: record.run_id,
    run_dir: runDir,
    record_sha256: recordHash,
    started_at: record.started_at,
    finished_at: record.finished_at,
    target: record.target,
    build: record.versions.build,
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
    frozen: record.frozen,
    steps_total: record.case.steps_total,
    steps: record.steps.map((s) => ({
      index: s.index,
      text: s.text,
      actions: s.actions.map((a) => ({ tool: a.tool, args: a.args, ok: a.ok, ...(a.error !== undefined ? { error: a.error } : {}) })),
      screenshots: record.evidence.filter((e) => e.kind === "screenshot" && e.step === s.index).map((e) => join(runDir, e.path)),
      evaluated: record.outcomes.filter((o) => o.after_step === s.index).map((o) => o.expected_ref),
    })),
    outcomes: record.outcomes,
    not_reached: record.case.expected.filter((e) => !reached.has(e.id)).map((e) => ({ id: e.id, after_step: e.after_step, description: e.description })),
    blocked: record.blocked
      ? { step: record.blocked.step, step_text: record.blocked.step_text, reason: record.blocked.reason, source: record.blocked.source, tool_error: record.blocked.tool_error, screenshot: blockedShot ? pathOf(blockedShot) : null }
      : null,
    guardrail_blocks: record.guardrail_events.filter((g) => g.decision === "blocked"),
    cleanup_errors: record.cleanup_errors,
    har: record.artifacts.har ? join(runDir, record.artifacts.har) : null,
    trace: "not recorded",
  };
}

export interface ReportInput {
  reportId: string;
  generatedAt: string;
  /** The cases that were planned. null means the plan is only the runs given, and the report says so. */
  plan: readonly PlanEntry[] | null;
  runs: readonly LoadedRun[];
}

/**
 * Builds and validates a report. It throws ReportError when the input would let the summary flatter the run: an empty
 * plan, a run that is not in the plan, or two runs for the same case.
 */
export function buildReport(input: ReportInput): Report {
  const declared = input.plan !== null;
  const plan: PlanEntry[] = declared
    ? [...input.plan!]
    : input.runs.map((r) =>
        "record" in r
          ? { id: r.record.case.id, source: r.record.case.source, title: r.record.case.title, priority: r.record.case.priority }
          : { id: `unreadable run: ${basename(r.runDir)}`, source: r.path, notRunReason: r.error },
      );
  if (plan.length === 0) throw new ReportError("the plan is empty, so there is nothing to report. A report of no cases would read as a clean run.");
  const planIds = new Set<string>();
  for (const p of plan) {
    if (planIds.has(p.id)) throw new ReportError(`the case ${p.id} is in the plan twice`);
    planIds.add(p.id);
  }

  const byCase = new Map<string, LoadedRun & { record: RunRecord; recordHash: string }>();
  for (const r of input.runs) {
    if (!("record" in r)) {
      if (declared) throw new ReportError(`the run at ${r.path} could not be read: ${r.error}`);
      continue;
    }
    if (!planIds.has(r.record.case.id)) throw new ReportError(`the run at ${r.path} is for ${r.record.case.id}, which is not in the plan`);
    if (byCase.has(r.record.case.id)) throw new ReportError(`two runs were given for ${r.record.case.id} (${byCase.get(r.record.case.id)!.path} and ${r.path}). Choose one.`);
    byCase.set(r.record.case.id, r as LoadedRun & { record: RunRecord; recordHash: string });
  }

  const cases: CaseEntry[] = plan.map((p) => {
    const run = byCase.get(p.id);
    if (run && p.notRunReason !== undefined) throw new ReportError(`${p.id} has a run record and also a reason for not running (${p.notRunReason})`);
    if (run) {
      const problems = checkRecord(run.record);
      if (problems.length === 0) {
        const r = run.record;
        return {
          id: r.case.id,
          title: r.case.title,
          priority: r.case.priority,
          source: r.case.source,
          control: p.control ?? null,
          status: "executed",
          not_executed_reason: null,
          verdict: r.verdict,
          verdict_row: r.verdict_row,
          verified: r.verdict === "PASS",
          rationale: rationale(r),
          attention: attentionFor(r.case.priority, r.verdict, r),
          run: runView(r, run.runDir, run.recordHash),
          // A negative control fails on purpose. Its draft is marked as a control, and a person decides what to do with it.
          bug_draft: r.verdict === "FAIL" ? bugDraft(r, run.runDir, p.control ?? null) : null,
        };
      }
      return notExecuted(p, `the run record at ${run.path} was rejected: ${problems.join("; ")}`, true);
    }
    return notExecuted(p, p.notRunReason ?? "no run record was given for this case");
  });

  const executedRecords = cases.flatMap((c) => (c.run ? [byCase.get(c.id)!.record] : []));
  const stamps = buildStamps(executedRecords);
  const count = (v: Verdict) => cases.filter((c) => c.verdict === v).length;
  const executed = cases.filter((c) => c.status === "executed").length;
  const verified = count("PASS");
  const notVerified = cases.length - verified;

  return ReportSchema.parse({
    schema_version: 1,
    report_id: input.reportId,
    generated_at: input.generatedAt,
    plan: { source: declared ? "declared" : "from_records", cases: plan.map((p) => ({ id: p.id, source: p.source })) },
    header: {
      stamps,
      complete_stamps: stamps.every((s) => s.status !== "missing"),
      preflight: { runs_after_passed_preflight: executedRecords.filter((r) => r.preflight?.ok === true).length, executed },
      scripted: executedRecords.some((r) => !r.versions.model_live || r.judge.live === false),
    },
    summary: {
      planned: cases.length,
      executed,
      not_executed: cases.length - executed,
      verified,
      not_verified: notVerified,
      by_verdict: { PASS: count("PASS"), FAIL: count("FAIL"), BLOCKED: count("BLOCKED"), INCONCLUSIVE: count("INCONCLUSIVE"), INCOMPLETE: count("INCOMPLETE"), NOT_EXECUTED: cases.length - executed },
      line: summaryLine({ planned: cases.length, executed, notVerified }),
    },
    cases,
  });
}

function notExecuted(p: PlanEntry, reason: string, rejected = false): CaseEntry {
  return {
    id: p.id,
    title: p.title ?? null,
    priority: p.priority ?? null,
    source: p.source,
    control: p.control ?? null,
    status: "not_executed",
    not_executed_reason: reason,
    verdict: null,
    verdict_row: null,
    verified: false,
    rationale: `Not executed: ${reason}`,
    attention: [
      ...attentionFor(p.priority ?? null, null, null),
      ...(rejected ? [{ kind: "run_record_rejected" as const, message: "A run record contradicts itself or lacks evidence for its verdict. A maintainer must look at it, and its verdict is not reported." }] : []),
    ],
    run: null,
    bug_draft: null,
  };
}
