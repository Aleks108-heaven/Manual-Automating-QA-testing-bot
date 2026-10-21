// Builds the release report. It adds the register of quarantines and overrides and the inventory of P1 cases to a run
// report, and says whether the evidence for the release decision is complete. It never says go or no-go.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CaseValidationError, loadCase } from "../cases/load.ts";
import { stableJson } from "../hash.ts";
import { loadRun } from "../report/build.ts";
import type { Report } from "../report/schema.ts";
import { READ_LIMITS, readTextCapped, TooLargeError } from "../safe-read.ts";
import { RegisterSchema, ReleaseReportSchema, type Override, type Quarantine, type Register, type ReleaseReport } from "./schema.ts";

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

export interface InventoryEntry {
  id: string;
  title: string;
  priority: string;
}

/** Reads the register. A register that does not validate stops the report, because a decision record cannot be half-trusted. */
export function loadRegister(path: string): Register {
  if (!existsSync(path)) throw new ReleaseError(`there is no register at ${path}. Create it, even when it is empty.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readTextCapped(path, READ_LIMITS.small, "the register"));
  } catch (error) {
    if (error instanceof TooLargeError) throw new ReleaseError(error.message);
    throw new ReleaseError(`the register at ${path} is not valid JSON`);
  }
  const parsed = RegisterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReleaseError(`the register at ${path} is invalid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Every case file in the directory. A file that does not validate is a problem, because it may be a P1 case the check cannot see. */
export function loadInventory(dir: string): { entries: InventoryEntry[]; problems: string[] } {
  if (!existsSync(dir)) throw new ReleaseError(`there is no case directory at ${dir}`);
  const entries: InventoryEntry[] = [];
  const problems: string[] = [];
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
    try {
      const c = loadCase(join(dir, name));
      entries.push({ id: c.id, title: c.title, priority: c.priority });
    } catch (error) {
      if (!(error instanceof CaseValidationError)) throw error;
      problems.push(`${join(dir, name)} is not a valid case, so its priority is unknown`);
    }
  }
  return { entries, problems };
}

/**
 * Checks each run record named in a report against the file on this machine: it has to be there, and it has to be the file the
 * report was made from. A report that says PASS about a record that has since changed, or that cannot be found, is not evidence.
 * Returns one problem per case that fails the check.
 */
export function checkRecordsOnDisk(report: Report): string[] {
  const problems: string[] = [];
  for (const c of report.cases) {
    if (!c.run) continue;
    const file = join(c.run.run_dir, "run.json");
    if (!existsSync(file)) {
      problems.push(`${c.id}: the run record ${file} is not on this machine, so the report's verdict could not be checked against it`);
      continue;
    }
    const loaded = loadRun(c.run.run_dir);
    if (!("record" in loaded)) {
      problems.push(`${c.id}: the run record ${file} could not be read (${loaded.error})`);
    } else if (loaded.recordHash !== c.run.record_sha256) {
      problems.push(`${c.id}: the run record ${file} has changed since the report was made (its hash is not the one in the report)`);
    } else if (loaded.record.verdict !== c.verdict || loaded.record.verdict_row !== c.verdict_row || stableJson(loaded.record.outcomes) !== stableJson(c.run.outcomes)) {
      // The record is the one the report was made from, so the report was edited afterwards.
      problems.push(`${c.id}: the report says ${c.verdict} (row ${c.verdict_row}) but the run record ${file} says ${loaded.record.verdict} (row ${loaded.record.verdict_row}), or its outcomes differ, so the report was changed after it was made`);
    }
  }
  return problems;
}

export interface ReleaseInput {
  releaseId: string;
  generatedAt: string;
  /** The day the deadlines are checked against, as YYYY-MM-DD. */
  today: string;
  report: Report;
  register: Register;
  inventory: readonly InventoryEntry[];
  inventoryProblems: readonly string[];
  approvers: readonly string[];
  decisionMaker: string | null;
  /** Problems found when the report's run records were checked against the files on disk (checkRecordsOnDisk). Each keeps the evidence incomplete. */
  recordProblems?: readonly string[];
  /** Says whether a piece of evidence named in an override exists. A link always counts. Defaults to "yes", for callers that cannot look. */
  evidenceExists?: (path: string) => boolean;
}

const IS_LINK = /^https?:\/\//i;

export function buildRelease(input: ReleaseInput): ReleaseReport {
  const { report, register, approvers, today } = input;
  const evidenceExists = input.evidenceExists ?? (() => true);
  const inRun = new Map(report.cases.map((c) => [c.id, c]));
  const inventoryIds = new Set(input.inventory.map((e) => e.id));

  // Quarantines. Only the approver may quarantine, with a named owner and a deadline. A past deadline puts the case back in gating.
  const seenQuarantine = new Set<string>();
  const quarantines = register.quarantines.map((q: Quarantine) => {
    let problem: string | null = null;
    if (!approvers.includes(q.approver)) problem = `${q.approver} is not a configured approver`;
    else if (!inventoryIds.has(q.case_id)) problem = `${q.case_id} is not a case in the inventory`;
    else if (q.quarantined_on > today) problem = `the quarantine is dated ${q.quarantined_on}, which is after ${today}`;
    else if (q.deadline < q.quarantined_on) problem = "the deadline is before the day it was quarantined";
    else if (seenQuarantine.has(q.case_id)) problem = `${q.case_id} is quarantined twice`;
    if (problem === null) seenQuarantine.add(q.case_id);
    const status = problem !== null ? ("invalid" as const) : q.deadline < today ? ("overdue" as const) : ("active" as const);
    return { ...q, status, problem, verdict_in_run: inRun.get(q.case_id)?.verdict ?? null };
  });
  const activeQuarantine = new Set(quarantines.filter((q) => q.status === "active").map((q) => q.case_id));

  // Overrides. Only a FAIL can be overridden, only by the approver, only for the run named, and only with evidence (the schema needs it).
  const overrides = register.overrides.map((o: Override) => {
    const c = inRun.get(o.case_id);
    let problem: string | null = null;
    if (!approvers.includes(o.approver)) problem = `${o.approver} is not a configured approver`;
    else if (!c || !c.run) problem = `${o.case_id} has no executed run in this report`;
    else if (c.run.run_id !== o.run_id) problem = `the override is for run ${o.run_id}, not run ${c.run.run_id}. An override does not carry over to another run.`;
    else if (c.verdict !== "FAIL") problem = `only a FAIL can be overridden, and this run is ${c.verdict}`;
    else if (o.recorded_on > today) problem = `the override is dated ${o.recorded_on}, which is after ${today}`;
    else {
      const missing = o.evidence.filter((e) => !IS_LINK.test(e) && !evidenceExists(e));
      if (missing.length > 0) problem = `the evidence ${missing.join(", ")} was not found, and an override needs its evidence attached`;
    }
    return { ...o, status: problem === null ? ("applied" as const) : ("invalid" as const), problem };
  });
  const overriddenCases = new Set(overrides.filter((o) => o.status === "applied").map((o) => o.case_id));

  const p1_cases = input.inventory
    .filter((e) => e.priority === "P1")
    .map((e) => {
      const c = inRun.get(e.id);
      const verdict = c?.verdict ?? null;
      if (!c) return { id: e.id, title: e.title, state: "not_in_run" as const, verdict, note: "This P1 case is not in the run, so nothing was verified for it." };
      if (verdict === "PASS") return { id: e.id, title: e.title, state: "verified" as const, verdict, note: "Verified." };
      if (activeQuarantine.has(e.id)) return { id: e.id, title: e.title, state: "quarantined" as const, verdict, note: "Quarantined by an approver, so it is out of gating until the deadline." };
      if (overriddenCases.has(e.id)) return { id: e.id, title: e.title, state: "overridden" as const, verdict, note: "FAIL, overridden by an approver for this run." };
      return { id: e.id, title: e.title, state: "blocking" as const, verdict, note: `${verdict ?? "Not executed"}: a P1 case that is not PASS needs human execution before release (manual: Definitions).` };
    });
  const count = (s: ReleaseReport["p1_cases"][number]["state"]) => p1_cases.filter((c) => c.state === s).length;

  const build = report.header.stamps.find((s) => s.name === "build");
  const candidateBuild = build && build.status === "same" ? (build.values[0] ?? null) : null;

  const problems = [
    ...input.inventoryProblems,
    ...(input.recordProblems ?? []),
    ...quarantines.filter((q) => q.status === "invalid").map((q) => `quarantine of ${q.case_id}: ${q.problem}`),
    ...overrides.filter((o) => o.status === "invalid").map((o) => `override of ${o.case_id}: ${o.problem}`),
  ];
  const reasons: string[] = [];
  if (report.header.scripted) reasons.push("a scripted fake stood in for the model or the judge, so these results test the machinery and cannot support a release decision");
  if (!report.header.complete_stamps) reasons.push("the report is missing version stamps, so it cannot show everything that produced it");
  if (candidateBuild === null) reasons.push("the executed runs did not all see one build, so the candidate build is unknown");
  if (count("blocking") > 0) reasons.push(`${count("blocking")} P1 case(s) are not PASS`);
  if (count("not_in_run") > 0) reasons.push(`${count("not_in_run")} P1 case(s) are not in the run`);
  if (p1_cases.length === 0) reasons.push("the inventory holds no P1 case, so there is nothing to verify");
  if (problems.length > 0) reasons.push(`${problems.length} fault(s) in the register, the case inventory or the run records`);
  if (quarantines.some((q) => q.status === "overdue")) reasons.push("a quarantine is past its deadline, and that case is back in gating");

  return ReleaseReportSchema.parse({
    schema_version: 1,
    release_id: input.releaseId,
    generated_at: input.generatedAt,
    today,
    run_report_id: report.report_id,
    candidate_build: candidateBuild,
    decision: {
      made_by_bot: false,
      decision_maker: input.decisionMaker,
      note: "A bot PASS is evidence for the release decision, never the decision (manual: Roles and decision rights).",
    },
    evidence: {
      status: reasons.length === 0 ? "complete" : "incomplete",
      reasons,
      p1: {
        inventory: p1_cases.length,
        verified: count("verified"),
        quarantined: count("quarantined"),
        overridden: count("overridden"),
        blocking: count("blocking"),
        not_in_run: count("not_in_run"),
      },
    },
    p1_cases,
    quarantines,
    overrides,
    problems,
  });
}
