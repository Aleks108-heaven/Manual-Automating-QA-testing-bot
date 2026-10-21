// T14: the summary line is honest. T15: every report is reproducible (it carries the version stamps).
// The reports here are built from real runs on the fixture site, and from edited copies of those run records to
// reach states a real run does not easily produce (every precedence row, a record that disagrees with itself).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reportJsonSchema, REPORT_SCHEMA_PATH, SCHEMA_FILES } from "../../scripts/emit-schemas.ts";
import { loadCase } from "../../src/cases/load.ts";
import { negativeControl } from "../../src/cases/mutate.ts";
import { configHash, loadConfig } from "../../src/config.ts";
import { ScriptedJudge } from "../../src/judge/scripted.ts";
import { buildReport, checkRecord, loadRun, ReportError, type LoadedRun, type PlanEntry } from "../../src/report/build.ts";
import { formatReport } from "../../src/report/format.ts";
import { ReportSchema, summaryLine, type Report } from "../../src/report/schema.ts";
import { newReportId, writeReport } from "../../src/report/write.ts";
import type { RunRecord } from "../../src/schemas/run-record.ts";
import { botSourceHash } from "../../src/version-stamp.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
import { PRECEDENCE_ROWS } from "../../src/verdict/calculate.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted, testConfig } from "./helpers/run.ts";

let site: FixtureSite;
const store = new StaticSecretStore(FIXTURE_SECRETS);
const T = { "x-fixture-test": "1", "content-type": "application/json" };

interface Made {
  runDir: string;
  record: RunRecord;
}
const made: Record<string, Made> = {};

function plan(id: string, extra: Partial<PlanEntry> = {}): PlanEntry {
  const c = loadCase(`cases/${id}.yaml`);
  return { id, source: "test", title: c.title, priority: c.priority, ...extra };
}

function report(entries: PlanEntry[] | null, runs: LoadedRun[]): Report {
  return buildReport({ reportId: "report-test", generatedAt: "2026-10-21T00:00:00.000Z", plan: entries, runs });
}

/** Copies a stored run, changes its record, and loads the copy, so a test can make a record say something a real run did not. */
function edited(runDir: string, edit: (r: RunRecord) => void): LoadedRun {
  const dir = mkdtempSync(join(tmpdir(), "qa-bot-edited-"));
  cpSync(runDir, dir, { recursive: true });
  const r = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunRecord;
  edit(r);
  writeFileSync(join(dir, "run.json"), JSON.stringify(r));
  return loadRun(dir);
}

async function runOne(key: string, id: string, options: { script?: string; judge?: ScriptedJudge; control?: boolean } = {}): Promise<void> {
  const base = loadCase(`cases/${id}.yaml`);
  const testCase = options.control ? negativeControl(base).testCase : base;
  const { record, runDir } = await runScripted({ site, testCase, script: options.script ?? `tests/ci/scripts/${id}.json`, secrets: store, ...(options.judge ? { judge: options.judge } : {}) });
  made[key] = { record, runDir };
}

beforeAll(async () => {
  site = await startFixtureSite();
  const reset = () => fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
  await reset();
  await runOne("pass", "TC-FORM-001");
  await runOne("control", "TC-FORM-001", { control: true });
  await runOne("member", "TC-ACCT-001");
  await runOne("login", "TC-AUTH-004");
  await reset();
  await runOne("judge-none", "TC-JUDGE-001"); // judged result, no judge: NO_EVIDENCE
  await runOne("judge", "TC-JUDGE-001", { judge: ScriptedJudge.fromFile("tests/ci/judge-scripts/TC-JUDGE-001.json") });
  site.setDefects(["lockout-off-by-one"]);
  await reset();
  await runOne("fail", "TC-AUTH-003");
  site.setDefects([]);
}, 180_000);

afterAll(async () => {
  await site.close();
});

describe("T14 the summary line is honest", () => {
  it("a mixed-verdict run says executed X of Y planned, Z not verified, and never all tests passed", () => {
    const r = report([plan("TC-FORM-001"), plan("TC-AUTH-003"), plan("TC-JUDGE-001"), plan("TC-ACCT-001", { notRunReason: "the runner is paused by the kill switch" })], [
      loadRun(made["pass"]!.runDir),
      loadRun(made["fail"]!.runDir),
      loadRun(made["judge-none"]!.runDir),
    ]);
    expect(r.summary.line).toBe("bot executed 3 of 4 planned cases, 3 not verified");
    expect(r.summary).toMatchObject({ planned: 4, executed: 3, not_executed: 1, verified: 1, not_verified: 3 });
    expect(r.summary.by_verdict).toEqual({ PASS: 1, FAIL: 1, BLOCKED: 0, INCONCLUSIVE: 1, INCOMPLETE: 0, NOT_EXECUTED: 1 });
    expect(r.cases.map((c) => c.verdict)).toEqual(["PASS", "FAIL", "INCONCLUSIVE", null]);
    const text = formatReport(r);
    expect(text).toContain("Summary: bot executed 3 of 4 planned cases, 3 not verified.");
    expect(text).toContain("Only PASS is verified.");
    expect(text.toLowerCase()).not.toMatch(/all (the )?tests? passed|all passed|everything passed/);
  });

  it("a case that did not run is not verified, and says why", () => {
    const r = report([plan("TC-FORM-001"), plan("TC-ACCT-001", { notRunReason: "the pre-flight check failed (canary cases behave)" })], [loadRun(made["pass"]!.runDir)]);
    expect(r.summary.line).toBe("bot executed 1 of 2 planned cases, 1 not verified");
    const skipped = r.cases[1]!;
    expect(skipped).toMatchObject({ status: "not_executed", verdict: null, verified: false });
    expect(skipped.not_executed_reason).toContain("pre-flight");
    // A P1 case that is not PASS needs a person, even when it never ran (manual: Definitions).
    expect(skipped.attention.map((a) => a.kind)).toContain("p1_not_pass");
    expect(formatReport(r)).toContain("Result:  NOT EXECUTED");
  });

  it("a single PASS reads 1 of 1, 0 not verified", () => {
    const r = report([plan("TC-FORM-001")], [loadRun(made["pass"]!.runDir)]);
    expect(r.summary.line).toBe("bot executed 1 of 1 planned cases, 0 not verified");
  });

  it("every row of the precedence table gives a report that is not verified unless it is row 7", () => {
    const edits: Record<number, (r: RunRecord) => void> = {
      1: (r) => void (r.run_state.infrastructure_failure = "the target did not answer: GET /form"),
      2: (r) => {
        r.run_state.guardrail_block = true;
        r.guardrail_events.push({ at: "t", type: "mutation", decision: "blocked", url: "http://127.0.0.1/form", detail: "undeclared POST /form" });
      },
      3: (r) => {
        r.outcomes[0]!.outcome = "MISMATCH";
        r.outcomes[0]!.actual = "a different message";
      },
      4: (r) => {
        r.run_state.actor_stop_reason = "element_missing";
        r.run_state.stop_source = "actor";
        r.blocked = { step: 2, step_text: "Click the missing button", reason: "element_missing", source: "actor", tool_error: null, evidence: [] };
      },
      5: (r) => {
        r.run_state.runner_stop_reason = "budget";
        r.budget.stop = { reason: "budget", detail: "the cost limit was reached" };
      },
      6: (r) => void (r.outcomes[0]!.outcome = "NO_EVIDENCE"),
      7: () => undefined,
    };
    for (const { row, verdict } of PRECEDENCE_ROWS) {
      const run = edited(made["pass"]!.runDir, (r) => {
        edits[row]!(r);
        r.verdict = verdict;
        r.verdict_row = row;
      });
      const r = report([plan("TC-FORM-001")], [run]);
      const c = r.cases[0]!;
      expect(c.status, `row ${row}`).toBe("executed");
      expect(c.verdict, `row ${row}`).toBe(verdict);
      expect(c.verdict_row).toBe(row);
      expect(c.rationale.length).toBeGreaterThan(20);
      expect(r.summary.line, `row ${row}`).toBe(`bot executed 1 of 1 planned cases, ${row === 7 ? 0 : 1} not verified`);
      expect(formatReport(r).toLowerCase()).not.toContain("all tests passed");
    }
  });

  it("the rationale names the facts that decided the verdict", () => {
    const mismatch = edited(made["pass"]!.runDir, (r) => {
      r.outcomes[0]!.outcome = "MISMATCH";
      r.verdict = "FAIL";
      r.verdict_row = 3;
    });
    expect(report([plan("TC-FORM-001")], [mismatch]).cases[0]!.rationale).toContain(made["pass"]!.record.outcomes[0]!.expected_ref);
    const budget = edited(made["pass"]!.runDir, (r) => {
      r.run_state.runner_stop_reason = "budget";
      r.budget.stop = { reason: "budget", detail: "the cost limit was reached" };
      r.verdict = "INCOMPLETE";
      r.verdict_row = 5;
    });
    expect(report([plan("TC-FORM-001")], [budget]).cases[0]!.rationale).toContain("the cost limit was reached");
  });

  it("a record that claims PASS against its own outcomes is not reported as executed", () => {
    const lie = edited(made["pass"]!.runDir, (r) => void (r.outcomes[0]!.outcome = "MISMATCH")); // the verdict still says PASS
    expect(checkRecord(JSON.parse(readFileSync(join(lie.runDir, "run.json"), "utf8")) as RunRecord).join(" ")).toContain("does not follow");
    const r = report([plan("TC-FORM-001")], [lie]);
    expect(r.cases[0]).toMatchObject({ status: "not_executed", verdict: null, verified: false });
    expect(r.cases[0]!.not_executed_reason).toContain("was rejected");
    expect(r.cases[0]!.attention.map((a) => a.kind)).toContain("run_record_rejected");
    expect(r.summary.line).toBe("bot executed 0 of 1 planned cases, 1 not verified");
  });

  it("a PASS with no evidence for an expected result is rejected, and so is a PASS citing evidence that was never stored", () => {
    const none = edited(made["pass"]!.runDir, (r) => void (r.outcomes[0]!.evidence = []));
    expect(report([plan("TC-FORM-001")], [none]).cases[0]!.not_executed_reason).toContain("has no evidence");
    const ghost = edited(made["pass"]!.runDir, (r) => void (r.outcomes[0]!.evidence = ["ev-never-stored"]));
    expect(report([plan("TC-FORM-001")], [ghost]).cases[0]!.not_executed_reason).toContain("evidence the run did not store");
  });

  it("refuses input that would flatter the run", () => {
    const pass = loadRun(made["pass"]!.runDir);
    expect(() => report([], [pass])).toThrow(ReportError);
    expect(() => report(null, [])).toThrow(/plan is empty/);
    expect(() => report([plan("TC-AUTH-003")], [pass])).toThrow(/not in the plan/);
    expect(() => report([plan("TC-FORM-001")], [pass, loadRun(made["control"]!.runDir)])).toThrow(/two runs/);
    expect(() => report([plan("TC-FORM-001"), plan("TC-FORM-001")], [pass])).toThrow(/twice/);
    expect(() => report([plan("TC-FORM-001", { notRunReason: "skipped" })], [pass])).toThrow(/also a reason/);
  });

  it("a report edited to claim more than its cases show no longer validates", () => {
    const r = report([plan("TC-FORM-001"), plan("TC-AUTH-003")], [loadRun(made["pass"]!.runDir), loadRun(made["fail"]!.runDir)]);
    expect(ReportSchema.safeParse(r).success).toBe(true);
    const flattering = structuredClone(r);
    flattering.summary.not_verified = 0;
    flattering.summary.line = summaryLine({ planned: 2, executed: 2, notVerified: 0 });
    expect(ReportSchema.safeParse(flattering).success).toBe(false);
    const wrongForm = structuredClone(r);
    wrongForm.summary.line = "all tests passed";
    expect(ReportSchema.safeParse(wrongForm).success).toBe(false);
    const verifiedFail = structuredClone(r);
    verifiedFail.cases[1]!.verified = true;
    expect(ReportSchema.safeParse(verifiedFail).success).toBe(false);
  });

  it("a plan taken from the records says so, because it cannot count a case that never ran", () => {
    const r = report(null, [loadRun(made["pass"]!.runDir)]);
    expect(r.plan.source).toBe("from_records");
    expect(formatReport(r)).toContain("taken from the run records given");
    expect(formatReport(report([plan("TC-FORM-001")], [loadRun(made["pass"]!.runDir)]))).toContain("declared before the run");
  });
});

describe("the per-case detail", () => {
  it("a FAIL carries expected vs actual and a draft bug report that a person finishes", () => {
    const r = report([plan("TC-AUTH-003")], [loadRun(made["fail"]!.runDir)]);
    const c = r.cases[0]!;
    expect(c.verdict).toBe("FAIL");
    expect(c.attention.map((a) => a.kind)).toContain("p1_not_pass");
    const d = c.bug_draft!;
    expect(d).toMatchObject({ draft: true, cause_category: "untriaged", suggested_severity: null, severity_and_priority: "to be set by a person", build: "fixture-1" });
    expect(d.title).toContain("TC-AUTH-003");
    expect(d.steps_to_reproduce.length).toBeGreaterThan(0);
    expect(d.preconditions.length).toBeGreaterThan(0);
    expect(d.expected_vs_actual.length).toBeGreaterThan(0);
    for (const e of d.expected_vs_actual) {
      expect(e.expected.length).toBeGreaterThan(0);
      expect(e.evidence.length).toBeGreaterThan(0);
      for (const path of e.evidence) expect(existsSync(path), path).toBe(true);
    }
    const text = formatReport(r);
    expect(text).toContain("Draft bug report");
    expect(text).toContain("Scrub evidence before attaching it to a ticket");
  });

  it("a PASS has no bug draft, and a negative control gets one that is marked as a control", () => {
    const r = report([plan("TC-FORM-001")], [loadRun(made["pass"]!.runDir)]);
    expect(r.cases[0]!.bug_draft).toBeNull();
    const control = report([plan("TC-FORM-001", { control: "negative control: e1 made wrong, expect FAIL" })], [loadRun(made["control"]!.runDir)]);
    expect(control.cases[0]).toMatchObject({ verdict: "FAIL", control: "negative control: e1 made wrong, expect FAIL" });
    // The draft is there for a person to use or discard. It says the FAIL was expected, and it does not decide anything.
    expect(control.cases[0]!.bug_draft).toMatchObject({ draft: true, control: "negative control: e1 made wrong, expect FAIL", cause_category: "untriaged", suggested_severity: null });
    expect(formatReport(control)).toContain("[negative control: e1 made wrong, expect FAIL]");
    expect(formatReport(control)).toContain("this case was changed on purpose");
    // A real FAIL carries no such note.
    expect(report([plan("TC-AUTH-003")], [loadRun(made["fail"]!.runDir)]).cases[0]!.bug_draft!.control).toBeNull();
  });

  it("the summary names what is not verified, so a FAIL is not lost behind the count of cases that ran", () => {
    const r = report([plan("TC-FORM-001"), plan("TC-AUTH-003"), plan("TC-JUDGE-001"), plan("TC-ACCT-001", { notRunReason: "skipped" })], [
      loadRun(made["pass"]!.runDir),
      loadRun(made["fail"]!.runDir),
      loadRun(made["judge-none"]!.runDir),
    ]);
    expect(formatReport(r)).toContain("Verified (PASS): 1. Not verified: FAIL 1, INCONCLUSIVE 1, not executed 1.");
    expect(formatReport(report([plan("TC-FORM-001")], [loadRun(made["pass"]!.runDir)]))).toContain("Not verified: none.");
  });

  it("lists steps with their screenshots, and says no trace is kept", () => {
    const r = report([plan("TC-FORM-001")], [loadRun(made["pass"]!.runDir)]);
    const run = r.cases[0]!.run!;
    expect(run.steps.length).toBe(made["pass"]!.record.steps.length);
    expect(run.steps.some((s) => s.screenshots.length > 0)).toBe(true);
    for (const s of run.steps) for (const p of s.screenshots) expect(existsSync(p), p).toBe(true);
    expect(run.trace).toBe("not recorded");
    expect(existsSync(run.har!)).toBe(true);
    expect(formatReport(r)).toContain("Trace: not recorded");
  });

  it("lists implicit findings as reported only, and names the expected results a run never reached", () => {
    const partial = edited(made["pass"]!.runDir, (r) => {
      r.outcomes = r.outcomes.slice(0, 1);
      r.verdict = "INCONCLUSIVE";
      r.verdict_row = 6;
    });
    const r = report([plan("TC-FORM-001")], [partial]);
    const unreached = r.cases[0]!.run!.not_reached;
    expect(unreached.map((u) => u.id)).toEqual(["e2", "e3"]);
    expect(r.cases[0]!.rationale).toContain("e2, e3 were never reached");
    expect(formatReport(r)).toContain("NOT REACHED");
    expect(formatReport(report([plan("TC-FORM-001")], [loadRun(made["pass"]!.runDir)]))).toContain("they do not change the verdict");
  });

  it("flags a guardrail block and an injection report for the security reviewer, and a P1 that is not PASS", () => {
    const run = edited(made["pass"]!.runDir, (r) => {
      r.run_state.guardrail_block = true;
      r.run_state.injection_suspected = true;
      r.guardrail_events.push({ at: "t", type: "navigation", decision: "blocked", url: "https://outside.example/", detail: "not on the allowlist" });
      r.verdict = "INCONCLUSIVE";
      r.verdict_row = 2;
    });
    const kinds = report([plan("TC-FORM-001")], [run]).cases[0]!.attention.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["p1_not_pass", "guardrail_block", "injection_suspected"]));
  });

  it("keeps secrets out of the report, for a run that logs in and a run with a stored session", () => {
    const r = report([plan("TC-AUTH-004"), plan("TC-ACCT-001")], [loadRun(made["login"]!.runDir), loadRun(made["member"]!.runDir)]);
    const everything = JSON.stringify(r) + formatReport(r);
    // Passwords and the API key are credentials. User names are not tracked as secrets, and the page shows them.
    const credentials = Object.entries(FIXTURE_SECRETS).filter(([name]) => !name.endsWith(".username"));
    expect(credentials.length).toBeGreaterThan(0);
    for (const [name, value] of credentials) expect(everything.includes(value), name).toBe(false);
    expect(everything).not.toMatch(/set-cookie|authorization:/i);
  });
});

describe("T15 every report is reproducible", () => {
  const stamp = (r: Report, name: string) => r.header.stamps.find((s) => s.name === name)!;

  it("carries the model ID, prompt hashes, tool and browser versions, and the build", () => {
    const r = report([plan("TC-FORM-001")], [loadRun(made["pass"]!.runDir)]);
    expect(r.header.complete_stamps).toBe(true);
    expect(r.header.stamps.every((s) => s.status === "same")).toBe(true);
    expect(stamp(r, "model_id").values).toEqual(["scripted"]);
    expect(stamp(r, "model_live").values).toEqual(["false"]);
    expect(stamp(r, "judge_model_id").values).toEqual(["none"]);
    const sha = (f: string) => createHash("sha256").update(readFileSync(join("prompts", f))).digest("hex");
    expect(stamp(r, "actor_prompt_hash").values).toEqual([sha("actor.v1.md")]);
    expect(stamp(r, "judge_prompt_hash").values).toEqual([sha("judge.v1.md")]);
    const version = (p: string) => (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version;
    expect(stamp(r, "bot").values).toEqual([version("package.json")]);
    expect(stamp(r, "bot_source_hash").values).toEqual([botSourceHash()]);
    expect(stamp(r, "playwright").values).toEqual([version("node_modules/playwright/package.json")]);
    expect(stamp(r, "axe_core").values).toEqual([version("node_modules/axe-core/package.json")]);
    expect(stamp(r, "node").values).toEqual([process.version]);
    expect(stamp(r, "browser").values[0]).toMatch(/\d/);
    expect(stamp(r, "build").values).toEqual(["fixture-1"]);
    expect(stamp(r, "config_hash").values[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(r.header.scripted).toBe(true);
  });

  it("shows the stamps in the text, and says a scripted fake is not a language model", () => {
    const text = formatReport(report([plan("TC-FORM-001")], [loadRun(made["pass"]!.runDir)]));
    const hash = createHash("sha256").update(readFileSync("prompts/actor.v1.md")).digest("hex").slice(0, 12);
    expect(text).toContain("Model    scripted (a scripted fake, not a language model)");
    expect(text).toContain(`actor.v1.md ${hash}`);
    expect(text).toMatch(/Playwright \d+\.\d+\.\d+, axe-core \d+\.\d+\.\d+/);
    expect(text).toContain("build fixture-1");
    expect(text).toContain("never fill a pilot gate");
  });

  it("stamps the judge when a case used one", () => {
    const r = report([plan("TC-JUDGE-001")], [loadRun(made["judge"]!.runDir)]);
    expect(stamp(r, "judge_model_id").values).toEqual(["scripted-judge"]);
    expect(stamp(r, "judge_live").values).toEqual(["false"]);
    expect(r.cases[0]!.run!.judge).toMatchObject({ configured: true, model_id: "scripted-judge", live: false });
  });

  it("a stamp a run could not record is reported as missing, not filled in", () => {
    const noBuild = edited(made["pass"]!.runDir, (r) => void (r.versions.build = null));
    const noPrompt = edited(made["member"]!.runDir, (r) => void delete r.versions.prompt_hashes["actor.v1.md"]);
    const noBrowser = edited(made["login"]!.runDir, (r) => void (r.versions.browser = "not started"));
    for (const [run, id, name] of [
      [noBuild, "TC-FORM-001", "build"],
      [noPrompt, "TC-ACCT-001", "actor_prompt_hash"],
      [noBrowser, "TC-AUTH-004", "browser"],
    ] as const) {
      const r = report([plan(id)], [run]);
      expect(stamp(r, name).status, name).toBe("missing");
      expect(r.header.complete_stamps).toBe(false);
      expect(formatReport(r)).toMatch(new RegExp(`WARNING  these stamps are missing .*${name}`));
    }
  });

  it("runs that disagree on a stamp are shown as mixed, with each value", () => {
    const other = edited(made["member"]!.runDir, (r) => {
      r.versions.model_id = "model-b";
      r.versions.model_live = true;
    });
    const r = report([plan("TC-FORM-001"), plan("TC-ACCT-001")], [loadRun(made["pass"]!.runDir), other]);
    expect(stamp(r, "model_id")).toMatchObject({ status: "mixed", values: ["scripted", "model-b"] });
    expect(r.cases[1]!.run!.versions.model_id).toBe("model-b"); // each case keeps its own
    expect(formatReport(r)).toContain("MIXED (scripted | model-b)");
    expect(formatReport(r)).toContain("the runs disagree on");
  });

  it("a report with no executed run has no stamps, and says so", () => {
    const r = report([plan("TC-FORM-001", { notRunReason: "the runner is paused by the kill switch" })], []);
    expect(r.header.complete_stamps).toBe(false);
    expect(r.header.stamps.every((s) => s.status === "missing")).toBe(true);
  });

  it("a record from an older schema is not trusted for its stamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-old-"));
    writeFileSync(join(dir, "run.json"), JSON.stringify({ ...made["pass"]!.record, schema_version: 3 }));
    const old = loadRun(dir);
    expect("error" in old && old.error).toContain("schema version 3 is not supported");
    const r = report(null, [old]);
    expect(r.cases[0]).toMatchObject({ status: "not_executed", verdict: null });
    expect(r.summary.line).toBe("bot executed 0 of 1 planned cases, 1 not verified");
    expect(() => report([plan("TC-FORM-001")], [old])).toThrow(ReportError);
  });

  it("the configuration hash ignores machine paths and notices every other change", () => {
    const base = loadConfig();
    const moved = loadConfig();
    moved.runs.directory = "somewhere-else";
    moved.sessions.directory = "another-place";
    moved.killSwitch.stateFile = "x.json";
    expect(configHash(moved)).toBe(configHash(base));
    const changed = loadConfig();
    changed.budgets.maxCostUsd += 1;
    expect(configHash(changed)).not.toBe(configHash(base));
    const sandbox = loadConfig();
    sandbox.browser.sandbox = !sandbox.browser.sandbox;
    expect(configHash(sandbox)).not.toBe(configHash(base));
  });

  it("the source hash changes with any edit to the bot, ignores line endings, and needs no git", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-bot-src-"));
    mkdirSync(join(root, "src", "sub"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(root, "src", "sub", "c.ts"), "export const c = 3;\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const first = botSourceHash(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const crlf = mkdtempSync(join(tmpdir(), "qa-bot-src-"));
    cpSync(root, crlf, { recursive: true });
    writeFileSync(join(crlf, "src", "a.ts"), "export const a = 1;\r\nexport const b = 2;\r\n");
    expect(botSourceHash(crlf)).toBe(first);

    for (const [file, text] of [["src/a.ts", "export const a = 9;\nexport const b = 2;\n"], ["src/sub/c.ts", "export const c = 4;\n"], ["package-lock.json", '{"x":1}\n'], ["src/new.ts", "export {};\n"]] as const) {
      const changed = mkdtempSync(join(tmpdir(), "qa-bot-src-"));
      cpSync(root, changed, { recursive: true });
      writeFileSync(join(changed, file), text);
      expect(botSourceHash(changed), file).not.toBe(first);
    }
  });

  it("a record with no source hash is not accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-nohash-"));
    const { bot_source_hash: _dropped, ...versions } = made["pass"]!.record.versions;
    writeFileSync(join(dir, "run.json"), JSON.stringify({ ...made["pass"]!.record, versions }));
    const loaded = loadRun(dir);
    expect("error" in loaded && loaded.error).toContain("does not match the run record schema");
  });

  it("the stored run record carries the stamps, and the hash is the one of the configuration the run used", () => {
    const v = made["pass"]!.record.versions;
    expect(v).toMatchObject({ model_id: "scripted", model_live: false });
    expect(v.config_hash).toBe(configHash(testConfig()));
  });
});

describe("the stored report and its contract", () => {
  it("writes report.json and report.txt, and the JSON validates against the schema", () => {
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-reports-"));
    const r = buildReport({ reportId: newReportId(), generatedAt: new Date().toISOString(), plan: [plan("TC-FORM-001")], runs: [loadRun(made["pass"]!.runDir)] });
    const written = writeReport(r, runs);
    expect(written.dir.startsWith(join(runs, "reports"))).toBe(true);
    expect(ReportSchema.parse(JSON.parse(readFileSync(written.json, "utf8")))).toEqual(r);
    expect(readFileSync(written.text, "utf8")).toBe(formatReport(r));
  });

  it("does not store a report that holds a credential header", () => {
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-reports-"));
    const r = report([plan("TC-FORM-001", { notRunReason: "refused\nCookie: session=abc123" })], []);
    expect(() => writeReport(r, runs)).toThrow(/credential header/);
    expect(existsSync(join(runs, "reports", r.report_id))).toBe(false);
  });

  it("the committed JSON schemas (case, run record, report) are the ones the code produces", () => {
    expect(SCHEMA_FILES.map((f) => f.path)).toEqual(["schemas/case.schema.json", "schemas/run-record.schema.json", REPORT_SCHEMA_PATH]);
    for (const file of SCHEMA_FILES) {
      // Git may check the file out with CRLF line endings on Windows. The content is what has to match.
      expect(readFileSync(file.path, "utf8").replaceAll("\r\n", "\n"), file.path).toBe(file.build());
    }
    expect(readFileSync(REPORT_SCHEMA_PATH, "utf8").replaceAll("\r\n", "\n")).toBe(reportJsonSchema());
  });

  it("the schemas describe real files: a stored run record's fields are all in the run record schema, and a case file's are in the case schema", () => {
    const props = (path: string) => Object.keys((JSON.parse(readFileSync(path, "utf8")) as { properties: Record<string, unknown> }).properties);
    const record = JSON.parse(readFileSync(join(made["pass"]!.runDir, "run.json"), "utf8")) as Record<string, unknown>;
    expect(props("schemas/run-record.schema.json").sort()).toEqual(Object.keys(record).sort());
    const caseKeys = props("schemas/case.schema.json");
    for (const key of ["id", "title", "priority", "steps", "expected", "allowed_mutations"]) expect(caseKeys).toContain(key);
    const required = (JSON.parse(readFileSync("schemas/case.schema.json", "utf8")) as { required: string[] }).required;
    expect(required.sort()).toEqual(["expected", "id", "priority", "steps", "title"]);
  });
});

// The command line, as a person uses it. These start their own fixture site through the CLI.
function cli(args: string[], runs: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.ts", ...args], {
      env: { ...process.env, QA_RUNS_DIR: runs, QA_ASSERTION_TIMEOUT_MS: "1000", QA_CANARY_CASES: "", QA_REQUIRE_CANARIES: "0", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("the command line ends every run with a report", () => {
  it("several cases make one report, and the exit code follows the report", async () => {
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-cli-report-"));
    const clean = await cli(["run", "cases/TC-FORM-001.yaml", "cases/TC-FORM-002.yaml"], runs);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("Summary: bot executed 2 of 2 planned cases, 0 not verified.");
    expect(clean.out).toMatch(/Report: .*report\.json/);

    const mixed = await cli(["run", "cases/TC-FORM-001.yaml", "cases/TC-AUTH-003.yaml", "--defects", "lockout-off-by-one"], runs);
    expect(mixed.code).toBe(1);
    expect(mixed.out).toContain("Summary: bot executed 2 of 2 planned cases, 1 not verified.");
    expect(mixed.out).toContain("Draft bug report");

    const control = await cli(["run", "cases/TC-FORM-001.yaml", "--negative-control"], runs);
    expect(control.code).toBe(1);
    expect(control.out).toContain("[negative control:");
    expect(control.out).toContain("this case was changed on purpose");
  }, 180_000);

  it("a refused batch reports every planned case as not executed", async () => {
    const site = await startFixtureSite();
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-cli-report-"));
    const target = ["--target", site.origin];
    try {
      expect((await cli(["kill-switch", "engage", "--by", "alex", "--reason", "an incident", ...target], runs)).code).toBe(0);
      const refused = await cli(["run", "cases/TC-FORM-001.yaml", "cases/TC-FORM-002.yaml", ...target], runs);
      expect(refused.code).toBe(3);
      expect(refused.err).toContain("paused by the kill switch");
      expect(refused.out).toContain("Summary: bot executed 0 of 2 planned cases, 2 not verified.");
      expect(refused.out).not.toContain("Verdict:");
      expect(refused.out).toContain("not started, because the runner is paused by the kill switch");
    } finally {
      await site.close();
    }
  }, 120_000);

  it("an invalid case file is rejected before its run and counted as not executed, and the rest of the batch still runs", async () => {
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-cli-report-"));
    const bad = join(runs, "TC-BAD-001.yaml");
    writeFileSync(bad, "id: TC-BAD-001\ntitle: no expected results\npriority: P1\nsteps:\n  - Open the form\nexpected: []\n");
    const r = await cli(["run", "cases/TC-FORM-001.yaml", bad], runs);
    expect(r.code).toBe(2);
    expect(r.err).toContain("a case needs at least one expected result");
    expect(r.out).toContain("Summary: bot executed 1 of 2 planned cases, 1 not verified.");
    expect(r.out).toContain("the case file is invalid and was rejected before its run");
    expect(r.out).toContain("Not verified: not executed 1.");
  }, 60_000);

  it("when every case file is invalid nothing starts, and it is a usage error", async () => {
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-cli-report-"));
    const bad = join(runs, "TC-BAD-001.yaml");
    writeFileSync(bad, "id: TC-BAD-001\ntitle: no expected results\npriority: P1\nsteps:\n  - Open the form\nexpected: []\n");
    const r = await cli(["run", bad], runs);
    expect(r.code).toBe(64);
    expect(r.out).toContain("Summary: bot executed 0 of 1 planned cases, 1 not verified.");
    expect(r.out).not.toContain("Verdict:");
  }, 60_000);

  it("the report command rebuilds a report from stored runs, and counts a planned case that has no run as not executed", async () => {
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-cli-report-"));
    expect((await cli(["run", "cases/TC-FORM-001.yaml", "cases/TC-FORM-002.yaml"], runs)).code).toBe(0);
    const stored = readdirSync(runs).filter((n) => /TC-FORM-00[12]/.test(n)).map((n) => join(runs, n));
    expect(stored.length).toBe(2);

    const withPlan = await cli(["report", ...stored, "--plan", "cases/TC-FORM-001.yaml,cases/TC-FORM-002.yaml,cases/TC-ACCT-001.yaml"], runs);
    expect(withPlan.code).toBe(2);
    expect(withPlan.out).toContain("Summary: bot executed 2 of 3 planned cases, 1 not verified.");
    expect(withPlan.out).toContain("no run record was given for this case");

    const noPlan = await cli(["report", ...stored], runs);
    expect(noPlan.code).toBe(0);
    expect(noPlan.out).toContain("taken from the run records given");

    const unplanned = await cli(["report", ...stored, "--plan", "cases/TC-FORM-001.yaml"], runs);
    expect(unplanned.code).toBe(64);
    expect(unplanned.err).toContain("not in the plan");
  }, 180_000);
});
