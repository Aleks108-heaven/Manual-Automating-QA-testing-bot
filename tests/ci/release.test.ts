// The release report: the evidence for the release decision, built from a run report, the register of quarantines and
// overrides, and the inventory of P1 cases. It never makes the decision (manual: Roles and decision rights).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { loadConfig } from "../../src/config.ts";
import { buildRelease, loadInventory, loadRegister, ReleaseError, type InventoryEntry, type ReleaseInput } from "../../src/release/build.ts";
import { formatRelease } from "../../src/release/format.ts";
import { ReleaseReportSchema, type Register } from "../../src/release/schema.ts";
import { buildReport, loadRun, type PlanEntry } from "../../src/report/build.ts";
import type { Report } from "../../src/report/schema.ts";
import { newReleaseId, writeRelease } from "../../src/report/write.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted } from "./helpers/run.ts";

let site: FixtureSite;
const T = { "x-fixture-test": "1", "content-type": "application/json" };
const dirs: Record<string, string> = {};

const INVENTORY: InventoryEntry[] = [
  { id: "TC-FORM-001", title: "Reject an invalid email", priority: "P1" },
  { id: "TC-AUTH-003", title: "Do not lock on the 4th failed login", priority: "P1" },
  { id: "TC-JUDGE-001", title: "Show a newsletter signup form", priority: "P2" },
];
const APPROVERS = ["Dana Approver"];

function plan(id: string): PlanEntry {
  const c = loadCase(`cases/${id}.yaml`);
  return { id, source: "test", title: c.title, priority: c.priority };
}

/** A run report from real runs. `live` switches off the scripted flag, as a report from a live model would have it. */
function runReport(ids: string[], live = false): Report {
  const r = buildReport({ reportId: "report-rel", generatedAt: "2026-10-21T00:00:00.000Z", plan: ids.map(plan), runs: ids.map((id) => loadRun(dirs[id]!)) });
  if (live) r.header.scripted = false;
  return r;
}

const EMPTY: Register = { quarantines: [], overrides: [] };

function release(report: Report, register: Register = EMPTY, extra: Partial<ReleaseInput> = {}) {
  return buildRelease({
    releaseId: "release-test",
    generatedAt: "2026-10-21T00:00:00.000Z",
    today: "2026-10-21",
    report,
    register,
    inventory: INVENTORY,
    inventoryProblems: [],
    approvers: APPROVERS,
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

describe("the evidence is not the decision", () => {
  it("names the decision-maker, says the bot did not decide, and never states go", () => {
    const r = release(runReport(["TC-FORM-001"], true), EMPTY, { inventory: [INVENTORY[0]!] });
    expect(r.decision).toMatchObject({ made_by_bot: false, decision_maker: "Rae Releaser" });
    const text = formatRelease(r);
    expect(text).toContain("not made by the bot");
    expect(text).toContain("never the decision");
    expect(text).not.toMatch(/\bGO\b|NO-GO|approved for release|ready to (ship|release)|safe to release/i);
  });

  it("says when no decision-maker is configured", () => {
    const r = release(runReport(["TC-FORM-001"], true), EMPTY, { inventory: [INVENTORY[0]!], decisionMaker: null });
    expect(formatRelease(r)).toContain("NOT CONFIGURED");
  });

  it("evidence from a scripted model is never complete", () => {
    const r = release(runReport(["TC-FORM-001"]), EMPTY, { inventory: [INVENTORY[0]!] });
    expect(r.evidence.status).toBe("incomplete");
    expect(r.evidence.reasons.join(" ")).toContain("scripted fake");
    expect(r.evidence.p1.verified).toBe(1);
  });

  it("is complete only when every P1 case is PASS, with a known build and full stamps", () => {
    const r = release(runReport(["TC-FORM-001"], true), EMPTY, { inventory: [INVENTORY[0]!, INVENTORY[2]!] });
    expect(r).toMatchObject({ candidate_build: "fixture-1", evidence: { status: "complete", reasons: [], p1: { inventory: 1, verified: 1, blocking: 0 } } });
  });
});

describe("P1 cases", () => {
  it("a P1 case that is not PASS blocks, and a P1 case missing from the run is named", () => {
    const failing = release(runReport(["TC-FORM-001", "TC-AUTH-003"], true));
    expect(failing.p1_cases.map((c) => [c.id, c.state])).toEqual([["TC-FORM-001", "verified"], ["TC-AUTH-003", "blocking"]]);
    expect(failing.evidence.status).toBe("incomplete");
    expect(failing.evidence.reasons).toContain("1 P1 case(s) are not PASS");

    const missing = release(runReport(["TC-FORM-001"], true));
    expect(missing.p1_cases.find((c) => c.id === "TC-AUTH-003")).toMatchObject({ state: "not_in_run", verdict: null });
    expect(missing.evidence.reasons).toContain("1 P1 case(s) are not in the run");
  });

  it("a P2 case in the run or outside it does not count", () => {
    const r = release(runReport(["TC-FORM-001"], true), EMPTY, { inventory: INVENTORY.filter((e) => e.id !== "TC-AUTH-003") });
    expect(r.p1_cases.map((c) => c.id)).toEqual(["TC-FORM-001"]);
  });

  it("an inventory with no P1 case is not evidence of anything", () => {
    const r = release(runReport(["TC-FORM-001"], true), EMPTY, { inventory: [INVENTORY[2]!] });
    expect(r.evidence.status).toBe("incomplete");
    expect(r.evidence.reasons.join(" ")).toContain("no P1 case");
  });

  it("an unreadable case file in the inventory keeps the evidence incomplete", () => {
    const r = release(runReport(["TC-FORM-001"], true), EMPTY, { inventory: [INVENTORY[0]!], inventoryProblems: ["cases/x.yaml is not a valid case, so its priority is unknown"] });
    expect(r.evidence.status).toBe("incomplete");
    expect(r.problems).toHaveLength(1);
  });

  it("a build that is missing or mixed leaves the candidate build unknown", () => {
    const report = runReport(["TC-FORM-001"], true);
    report.header.stamps.find((s) => s.name === "build")!.status = "mixed";
    const r = release(report, EMPTY, { inventory: [INVENTORY[0]!] });
    expect(r.candidate_build).toBeNull();
    expect(r.evidence.reasons.join(" ")).toContain("candidate build is unknown");
  });
});

describe("quarantine", () => {
  const quarantine = (over: Partial<Register["quarantines"][number]> = {}): Register => ({
    quarantines: [{ case_id: "TC-AUTH-003", owner: "Owen Owner", approver: "Dana Approver", reason: "flaky on staging", quarantined_on: "2026-10-01", deadline: "2026-11-01", ...over }],
    overrides: [],
  });

  it("an approver's quarantine takes the case out of gating, and it is listed", () => {
    const r = release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), quarantine());
    expect(r.p1_cases.find((c) => c.id === "TC-AUTH-003")).toMatchObject({ state: "quarantined", verdict: "FAIL" });
    expect(r.quarantines[0]).toMatchObject({ status: "active", problem: null, verdict_in_run: "FAIL", owner: "Owen Owner" });
    expect(r.evidence).toMatchObject({ status: "complete", p1: { quarantined: 1, blocking: 0 } });
    expect(formatRelease(r)).toContain("Quarantined cases (1)");
    expect(formatRelease(r)).toContain("owner Owen Owner, approved by Dana Approver");
  });

  it("is listed in every release report, even when nothing is quarantined", () => {
    expect(formatRelease(release(runReport(["TC-FORM-001"], true), EMPTY, { inventory: [INVENTORY[0]!] }))).toContain("Quarantined cases (0)");
  });

  it("someone who is not an approver cannot quarantine, and with no approver configured nobody can", () => {
    const stranger = release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), quarantine({ approver: "Sam Stranger" }));
    expect(stranger.quarantines[0]).toMatchObject({ status: "invalid", problem: "Sam Stranger is not a configured approver" });
    expect(stranger.p1_cases.find((c) => c.id === "TC-AUTH-003")!.state).toBe("blocking");
    expect(stranger.problems.join(" ")).toContain("quarantine of TC-AUTH-003");

    const nobody = release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), quarantine(), { approvers: [] });
    expect(nobody.quarantines[0]!.status).toBe("invalid");
    expect(nobody.evidence.status).toBe("incomplete");
  });

  it("a quarantine past its deadline puts the case back in gating", () => {
    const r = release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), quarantine({ deadline: "2026-10-20" }));
    expect(r.quarantines[0]!.status).toBe("overdue");
    expect(r.p1_cases.find((c) => c.id === "TC-AUTH-003")!.state).toBe("blocking");
    expect(r.evidence.reasons.join(" ")).toContain("past its deadline");
    // The deadline day itself is still inside the quarantine.
    expect(release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), quarantine({ deadline: "2026-10-21" })).quarantines[0]!.status).toBe("active");
  });

  it("refuses a quarantine with a deadline before it began, of an unknown case, or a second one for the same case", () => {
    expect(release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), quarantine({ deadline: "2026-09-01" })).quarantines[0]!.problem).toContain("before the day");
    expect(release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), quarantine({ case_id: "TC-NOPE-001" })).quarantines[0]!.problem).toContain("not a case in the inventory");
    const twice: Register = { quarantines: [...quarantine().quarantines, ...quarantine({ owner: "Other Owner" }).quarantines], overrides: [] };
    expect(release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), twice).quarantines.map((q) => q.status)).toEqual(["active", "invalid"]);
  });

  it("a quarantined case that passes is still verified", () => {
    const r = release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), quarantine({ case_id: "TC-FORM-001" }));
    expect(r.p1_cases.find((c) => c.id === "TC-FORM-001")!.state).toBe("verified");
  });
});

describe("overrides", () => {
  const failRun = () => runReport(["TC-FORM-001", "TC-AUTH-003"], true).cases.find((c) => c.id === "TC-AUTH-003")!.run!.run_id;
  const override = (over: Partial<Register["overrides"][number]> = {}): Register => ({
    quarantines: [],
    overrides: [{ case_id: "TC-AUTH-003", run_id: failRun(), approver: "Dana Approver", triage_result: "environment", evidence: ["runs/triage-note.md"], reason: "staging data collided", recorded_on: "2026-10-21", ...over }],
  });

  it("an approver's override of this run's FAIL is applied and shown, and the verdict stays FAIL", () => {
    const report = runReport(["TC-FORM-001", "TC-AUTH-003"], true);
    const r = release(report, override());
    expect(r.p1_cases.find((c) => c.id === "TC-AUTH-003")).toMatchObject({ state: "overridden", verdict: "FAIL" });
    expect(r.overrides[0]).toMatchObject({ status: "applied", triage_result: "environment" });
    expect(r.evidence.status).toBe("complete");
    expect(report.cases.find((c) => c.id === "TC-AUTH-003")!.verdict).toBe("FAIL");
    expect(formatRelease(r)).toContain("approved by Dana Approver, triage environment");
  });

  it("does not carry over to another run, another verdict, or a stranger", () => {
    const other = release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), override({ run_id: "20260101-000000-TC-AUTH-003-0000" }));
    expect(other.overrides[0]!.problem).toContain("does not carry over to another run");
    expect(other.p1_cases.find((c) => c.id === "TC-AUTH-003")!.state).toBe("blocking");

    const onPass = release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), override({ case_id: "TC-FORM-001", run_id: runReport(["TC-FORM-001"]).cases[0]!.run!.run_id }));
    expect(onPass.overrides[0]!.problem).toContain("only a FAIL can be overridden");

    const stranger = release(runReport(["TC-FORM-001", "TC-AUTH-003"], true), override({ approver: "Sam Stranger" }));
    expect(stranger.overrides[0]!.status).toBe("invalid");
    expect(stranger.evidence.status).toBe("incomplete");

    const notRun = release(runReport(["TC-FORM-001"], true), override());
    expect(notRun.overrides[0]!.problem).toContain("no executed run");
  });

  it("an override without evidence or a triage result is not a valid register", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-register-"));
    const write = (o: object) => {
      const file = join(dir, `r${Math.random()}.json`);
      writeFileSync(file, JSON.stringify({ quarantines: [], overrides: [o] }));
      return file;
    };
    const base = override().overrides[0]!;
    expect(() => loadRegister(write({ ...base, evidence: [] }))).toThrow(ReleaseError);
    const { triage_result: _t, ...noTriage } = base;
    expect(() => loadRegister(write(noTriage))).toThrow(/invalid/);
    expect(() => loadRegister(write({ ...base, triage_result: "made_up" }))).toThrow(ReleaseError);
  });
});

describe("inputs and the stored report", () => {
  it("a missing, malformed or invalid register stops the report", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-register-"));
    expect(() => loadRegister(join(dir, "nope.json"))).toThrow(/no register/);
    writeFileSync(join(dir, "bad.json"), "{");
    expect(() => loadRegister(join(dir, "bad.json"))).toThrow(/not valid JSON/);
    writeFileSync(join(dir, "extra.json"), JSON.stringify({ quarantines: [], overrides: [], approvals: [] }));
    expect(() => loadRegister(join(dir, "extra.json"))).toThrow(/invalid/);
    expect(loadRegister("release/register.json")).toEqual(EMPTY);
  });

  it("reads the real inventory, and a case file that does not validate is a problem", () => {
    const real = loadInventory("cases");
    expect(real.problems).toEqual([]);
    expect(real.entries.filter((e) => e.priority === "P1").map((e) => e.id)).toEqual(expect.arrayContaining(["TC-FORM-001", "TC-AUTH-003", "TC-ACCT-001"]));
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-inventory-"));
    writeFileSync(join(dir, "TC-BAD-001.yaml"), "id: TC-BAD-001\ntitle: no expected results\npriority: P1\nsteps:\n  - Open the form\nexpected: []\n");
    expect(loadInventory(dir).problems[0]).toContain("TC-BAD-001.yaml is not a valid case");
    expect(() => loadInventory(join(dir, "missing"))).toThrow(ReleaseError);
  });

  it("the default configuration lists no approver and no decision-maker, so nobody may quarantine or override yet", () => {
    expect(loadConfig().release).toMatchObject({ approvers: [], decisionMaker: null, registerFile: "release/register.json" });
  });

  it("a release report edited to call incomplete evidence complete no longer validates", () => {
    const r = release(runReport(["TC-FORM-001", "TC-AUTH-003"], true));
    expect(ReleaseReportSchema.safeParse(r).success).toBe(true);
    const flattering = structuredClone(r);
    flattering.evidence.status = "complete";
    expect(ReleaseReportSchema.safeParse(flattering).success).toBe(false);
    const decided = structuredClone(r) as unknown as { decision: { made_by_bot: boolean } };
    decided.decision.made_by_bot = true;
    expect(ReleaseReportSchema.safeParse(decided).success).toBe(false);
    const miscount = structuredClone(r);
    miscount.evidence.p1.verified += 1;
    expect(ReleaseReportSchema.safeParse(miscount).success).toBe(false);
  });

  it("stores release.json and release.txt", () => {
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-releases-"));
    const r = release(runReport(["TC-FORM-001"], true), EMPTY, { inventory: [INVENTORY[0]!], releaseId: newReleaseId() });
    const written = writeRelease(r, runs);
    expect(written.dir.startsWith(join(runs, "releases"))).toBe(true);
    expect(ReleaseReportSchema.parse(JSON.parse(readFileSync(written.json, "utf8")))).toEqual(r);
    expect(readFileSync(written.text, "utf8")).toBe(formatRelease(r));
    expect(existsSync(written.json)).toBe(true);
  });
});

function cli(args: string[], runs: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.ts", ...args], {
      env: { ...process.env, QA_RUNS_DIR: runs, QA_ASSERTION_TIMEOUT_MS: "1000", QA_CANARY_CASES: "", QA_REQUIRE_CANARIES: "0" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("the command line", () => {
  it("builds a release report from a stored report, and with nobody configured it refuses every quarantine", async () => {
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-cli-release-"));
    const batch = await cli(["run", "cases/TC-FORM-001.yaml"], runs);
    expect(batch.code).toBe(0);
    const reportJson = batch.out.match(/Report: +(.*report\.json)/)![1]!;

    const register = join(runs, "register.json");
    writeFileSync(register, JSON.stringify({ quarantines: [{ case_id: "TC-AUTH-003", owner: "Owen Owner", approver: "Dana Approver", reason: "flaky", quarantined_on: "2026-10-01", deadline: "2026-12-01" }], overrides: [] }));
    const r = await cli(["release", reportJson, "--register", register, "--today", "2026-10-21"], runs);
    expect(r.code).toBe(2); // the evidence is incomplete: P1 cases are missing from this run, and the model was scripted
    expect(r.out).toContain("Evidence for the decision: INCOMPLETE");
    expect(r.out).toContain("not made by the bot");
    expect(r.out).toContain("NOT CONFIGURED");
    expect(r.out).toContain("INVALID  owner Owen Owner");
    expect(r.out).toContain("Dana Approver is not a configured approver");
    expect(r.out).toMatch(/Release report: .*release\.json/);

    const noRegister = await cli(["release", reportJson, "--register", join(runs, "none.json")], runs);
    expect(noRegister.code).toBe(64);
    expect(noRegister.err).toContain("no register");

    mkdirSync(join(runs, "empty"));
    expect((await cli(["release", join(runs, "empty")], runs)).code).toBe(64);
  }, 120_000);
});
