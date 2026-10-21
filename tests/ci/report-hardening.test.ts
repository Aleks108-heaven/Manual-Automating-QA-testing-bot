// Hardening for the report and the release report: a stored report cannot be edited into a better verdict, a changed run
// record is noticed, evidence has to exist, and page content cannot reach the terminal as control codes.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { hashText } from "../../src/hash.ts";
import { buildRelease, checkRecordsOnDisk, type InventoryEntry, type ReleaseInput } from "../../src/release/build.ts";
import { formatRelease } from "../../src/release/format.ts";
import type { Register } from "../../src/release/schema.ts";
import { buildReport, loadRun, type PlanEntry } from "../../src/report/build.ts";
import { formatReport } from "../../src/report/format.ts";
import { cleanForTerminal } from "../../src/report/sanitize.ts";
import { ReportSchema, summaryLine, type Report } from "../../src/report/schema.ts";
import { newReportId, writeReport } from "../../src/report/write.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted } from "./helpers/run.ts";

let site: FixtureSite;
const T = { "x-fixture-test": "1", "content-type": "application/json" };
const dirs: Record<string, string> = {};
const INVENTORY: InventoryEntry[] = [
  { id: "TC-FORM-001", title: "Reject an invalid email", priority: "P1" },
  { id: "TC-AUTH-003", title: "Do not lock on the 4th failed login", priority: "P1" },
];

function plan(id: string, extra: Partial<PlanEntry> = {}): PlanEntry {
  const c = loadCase(`cases/${id}.yaml`);
  return { id, source: "test", title: c.title, priority: c.priority, ...extra };
}

function report(ids: string[]): Report {
  return buildReport({ reportId: "report-hard", generatedAt: "2026-10-21T00:00:00.000Z", plan: ids.map((i) => plan(i)), runs: ids.map((i) => loadRun(dirs[i]!)) });
}

function release(r: Report, extra: Partial<ReleaseInput> = {}, register: Register = { quarantines: [], overrides: [] }) {
  return buildRelease({
    releaseId: "release-hard",
    generatedAt: "2026-10-21T00:00:00.000Z",
    today: "2026-10-21",
    report: r,
    register,
    inventory: INVENTORY,
    inventoryProblems: [],
    approvers: ["Dana Approver"],
    decisionMaker: "Rae Releaser",
    ...extra,
  });
}

beforeAll(async () => {
  site = await startFixtureSite();
  const reset = () => fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
  await reset();
  dirs["TC-FORM-001"] = (await runScripted({ site, testCase: loadCase("cases/TC-FORM-001.yaml"), script: "tests/ci/scripts/TC-FORM-001.json" })).runDir;
  site.setDefects(["lockout-off-by-one"]);
  await reset();
  dirs["TC-AUTH-003"] = (await runScripted({ site, testCase: loadCase("cases/TC-AUTH-003.yaml"), script: "tests/ci/scripts/TC-AUTH-003.json" })).runDir;
  site.setDefects([]);
}, 120_000);
afterAll(async () => {
  await site.close();
});

describe("a stored report cannot be edited into a better verdict", () => {
  it("a FAIL changed to PASS, with the summary changed to match, no longer validates", () => {
    const r = report(["TC-FORM-001", "TC-AUTH-003"]);
    expect(ReportSchema.safeParse(r).success).toBe(true);
    const edited = structuredClone(r);
    const fail = edited.cases.find((c) => c.verdict === "FAIL")!;
    fail.verdict = "PASS";
    fail.verdict_row = 7;
    fail.verified = true;
    edited.summary.by_verdict.FAIL = 0;
    edited.summary.by_verdict.PASS = 2;
    edited.summary.verified = 2;
    edited.summary.not_verified = 0;
    edited.summary.line = summaryLine({ planned: 2, executed: 2, notVerified: 0 });
    // Everything adds up, so only the check against the outcomes can catch it.
    const result = ReportSchema.safeParse(edited);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues.map((i) => i.message).join(" ")).toContain("does not follow from the outcomes");
  });

  it("an outcome and verdict edited together, so that the report is consistent, are caught by the run record on disk", () => {
    const r = report(["TC-FORM-001", "TC-AUTH-003"]);
    const edited = structuredClone(r);
    const fail = edited.cases.find((c) => c.verdict === "FAIL")!;
    for (const o of fail.run!.outcomes) o.outcome = "MATCH";
    fail.verdict = "PASS";
    fail.verdict_row = 7;
    fail.verified = true;
    edited.summary.by_verdict.FAIL = 0;
    edited.summary.by_verdict.PASS = 2;
    edited.summary.verified = 2;
    edited.summary.not_verified = 0;
    edited.summary.line = summaryLine({ planned: 2, executed: 2, notVerified: 0 });
    // The edit is consistent with itself, so the schema accepts it. The run record the report was made from still says FAIL.
    expect(ReportSchema.safeParse(edited).success).toBe(true);
    expect(checkRecordsOnDisk(r)).toEqual([]);
    const problems = checkRecordsOnDisk(edited);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("the report says PASS");
    expect(problems[0]).toContain("the report was changed after it was made");
    expect(release(edited, { recordProblems: problems }).evidence.status).toBe("incomplete");
  });
  it("the report carries the hash of each run record, and it is the hash of run.json", () => {
    const r = report(["TC-FORM-001"]);
    expect(r.cases[0]!.run!.record_sha256).toBe(hashText(readFileSync(join(dirs["TC-FORM-001"]!, "run.json"), "utf8")));
  });
});

describe("the release report checks the report against the records on disk", () => {
  it("a record that is missing or changed keeps the evidence incomplete and is named", () => {
    const base = report(["TC-FORM-001", "TC-AUTH-003"]);
    expect(checkRecordsOnDisk(base)).toEqual([]);

    const moved = structuredClone(base);
    moved.cases[0]!.run!.run_dir = join(tmpdir(), "no-such-run-directory");
    const missing = checkRecordsOnDisk(moved);
    expect(missing[0]).toContain("is not on this machine");
    const r = release(moved, { recordProblems: missing });
    expect(r.evidence.status).toBe("incomplete");
    expect(r.problems.join(" ")).toContain("TC-FORM-001");
    expect(r.evidence.reasons.join(" ")).toContain("run records");

    const copy = mkdtempSync(join(tmpdir(), "qa-bot-changed-"));
    cpSync(dirs["TC-FORM-001"]!, copy, { recursive: true });
    writeFileSync(join(copy, "run.json"), readFileSync(join(copy, "run.json"), "utf8") + " ");
    const changed = structuredClone(base);
    changed.cases[0]!.run!.run_dir = copy;
    expect(checkRecordsOnDisk(changed)[0]).toContain("has changed since the report was made");
    rmSync(copy, { recursive: true, force: true });
  });
});

describe("decision records are checked against the date and the evidence", () => {
  const failRun = () => report(["TC-FORM-001", "TC-AUTH-003"]).cases.find((c) => c.id === "TC-AUTH-003")!.run!.run_id;

  it("a quarantine or an override dated after the day of the report is invalid", () => {
    const r = report(["TC-FORM-001", "TC-AUTH-003"]);
    const q = release(r, {}, { quarantines: [{ case_id: "TC-AUTH-003", owner: "Owen", approver: "Dana Approver", reason: "flaky", quarantined_on: "2026-10-22", deadline: "2026-12-01" }], overrides: [] });
    expect(q.quarantines[0]).toMatchObject({ status: "invalid" });
    expect(q.quarantines[0]!.problem).toContain("after 2026-10-21");
    const o = release(r, {}, { quarantines: [], overrides: [{ case_id: "TC-AUTH-003", run_id: failRun(), approver: "Dana Approver", triage_result: "environment", evidence: ["https://example.test/note"], reason: "x", recorded_on: "2026-10-30" }] });
    expect(o.overrides[0]!.status).toBe("invalid");
    expect(o.overrides[0]!.problem).toContain("after 2026-10-21");
  });

  it("an override needs evidence that exists: a link counts, a path must be there", () => {
    const r = report(["TC-FORM-001", "TC-AUTH-003"]);
    const make = (evidence: string[]) => ({ quarantines: [], overrides: [{ case_id: "TC-AUTH-003", run_id: failRun(), approver: "Dana Approver", triage_result: "environment" as const, evidence, reason: "x", recorded_on: "2026-10-21" }] });
    const exists = (p: string) => p === "docs/real-note.md";
    expect(release(r, { evidenceExists: exists }, make(["docs/real-note.md", "https://tracker.example/ISSUE-1"])).overrides[0]!.status).toBe("applied");
    const missing = release(r, { evidenceExists: exists }, make(["docs/real-note.md", "docs/forgotten.md"]));
    expect(missing.overrides[0]).toMatchObject({ status: "invalid" });
    expect(missing.overrides[0]!.problem).toContain("docs/forgotten.md was not found");
    expect(missing.p1_cases.find((c) => c.id === "TC-AUTH-003")!.state).toBe("blocking");
  });
});

describe("page content cannot reach the terminal as control codes", () => {
  // The control characters are made from code points here, so this file holds none of them itself.
  const ESC = String.fromCharCode(0x1b);
  const CR = String.fromCharCode(0x0d);
  const RLO = String.fromCharCode(0x202e);
  const NUL = String.fromCharCode(0);
  const CSI = String.fromCharCode(0x9b);

  it("cleanForTerminal keeps text, line feeds and tabs, and replaces everything that could steer a terminal", () => {
    expect(cleanForTerminal("a\nb\tc")).toBe("a\nb\tc");
    expect(cleanForTerminal(`${ESC}[2J${ESC}]0;title${String.fromCharCode(7)}x`)).toBe("?[2J?]0;title?x");
    expect(cleanForTerminal(`line${CR}overwritten`)).toBe("line?overwritten");
    expect(cleanForTerminal(`gnp.${RLO}exe`)).toBe("gnp.?exe");
    expect(cleanForTerminal(`${NUL}${CSI}`)).toBe("??");
    expect(cleanForTerminal("Zoë 李雷 😀")).toBe("Zoë 李雷 😀");
  });

  it("a report and a release report built from hostile text contain none of those characters", () => {
    const hostile = `refused${ESC}[2J${ESC}[1;1H FAKE: all tests passed${CR}${RLO}`;
    const r = buildReport({ reportId: "report-x", generatedAt: "2026-10-21T00:00:00.000Z", plan: [plan("TC-FORM-001", { notRunReason: hostile })], runs: [] });
    const text = formatReport(r);
    expect(text).toContain("refused?[2J?[1;1H FAKE");
    expect([...text].some((ch) => ch !== "\n" && ch !== "\t" && ((ch.codePointAt(0) ?? 0) <= 0x1f || ((ch.codePointAt(0) ?? 0) >= 0x7f && (ch.codePointAt(0) ?? 0) <= 0x9f)))).toBe(false);
    expect(text.includes(RLO)).toBe(false);
    const rel = release(report(["TC-FORM-001", "TC-AUTH-003"]), {}, { quarantines: [{ case_id: "TC-AUTH-003", owner: `Owen${ESC}[2J`, approver: "Dana Approver", reason: "flaky", quarantined_on: "2026-10-01", deadline: "2026-12-01" }], overrides: [] });
    expect(formatRelease(rel).includes(ESC)).toBe(false);
  });
});

describe("a stored report is never overwritten", () => {
  it("refuses a second report with the same id, and ids are not guessable by the second", () => {
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-write-"));
    const r = report(["TC-FORM-001"]);
    const written = writeReport(r, runs);
    expect(existsSync(written.json)).toBe(true);
    const before = readFileSync(written.json, "utf8");
    expect(() => writeReport({ ...r, generated_at: "2030-01-01T00:00:00.000Z" }, runs)).toThrow(/already exists/);
    expect(readFileSync(written.json, "utf8")).toBe(before);
    expect(newReportId()).toMatch(/^\d{8}-\d{6}-report-[0-9a-f]{8}$/);
  });
});
