// M7: the freezer (T20, T21). A case that proved stable is frozen into a script, a person approves it, and it replays with no
// model. A failed assertion stays FAIL. A step that cannot run is BLOCKED, and the agent may only write a proposal.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import type { Config } from "../../src/config.ts";
import { exportScript } from "../../src/frozen/export.ts";
import { ScriptedProposer } from "../../src/frozen/propose.ts";
import { FrozenScriptModel } from "../../src/frozen/replay.ts";
import { FrozenRegisterSchema, FrozenScriptSchema, hashText, ProposalSchema } from "../../src/frozen/schema.ts";
import { approveProposal, approveScript, FrozenError, loadApprovedScript, loadFrozenRegister, nextVersion, readProposal, writeDraft, type ApprovedScript } from "../../src/frozen/store.ts";
import { buildReport, loadRun } from "../../src/report/build.ts";
import { formatReport } from "../../src/report/format.ts";
import { runCase, type RunResult } from "../../src/runner/run-case.ts";
import type { TestCase } from "../../src/schemas/case.ts";
import type { RunRecord } from "../../src/schemas/run-record.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted, testConfig } from "./helpers/run.ts";

let site: FixtureSite;
const secrets = new StaticSecretStore(FIXTURE_SECRETS);
const FORM = "cases/TC-FORM-001.yaml";
const FORM_SCRIPT = "tests/ci/scripts/TC-FORM-001.json";
const ACCT = "cases/TC-ACCT-001.yaml";

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});
beforeEach(async () => {
  site.setDefects([]);
  await fetch(site.origin + "/__test/reset", { method: "POST", headers: { "x-fixture-test": "1" }, body: "{}" });
});

/** A configuration with its own frozen folder and register, and one approver, so a test never touches the repository's. */
function frozenConfig(change: (c: Config) => void = () => undefined): Config {
  const dir = mkdtempSync(join(tmpdir(), "qa-bot-frozen-"));
  return testConfig((c) => {
    c.frozen.directory = dir;
    c.frozen.registerFile = join(dir, "register.json");
    c.release.approvers = ["Odin"];
    change(c);
  });
}

async function agentRuns(casePath: string, scriptPath: string, config: Config, n = 3): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: { "x-fixture-test": "1" }, body: "{}" });
    records.push((await runScripted({ site, testCase: loadCase(casePath), script: scriptPath, config, secrets })).record);
  }
  return records;
}

/** Freezes a case from agent runs and has Odin approve it. Returns the approved script, ready to replay. */
async function freezeAndApprove(casePath: string, scriptPath: string, config: Config): Promise<{ approved: ApprovedScript; runs: RunRecord[] }> {
  const testCase = loadCase(casePath);
  const runs = await agentRuns(casePath, scriptPath, config);
  const caseText = readFileSync(casePath, "utf8");
  const exported = exportScript({ runs, testCase, caseHash: hashText(caseText), minPassingRuns: config.frozen.minPassingRuns, version: 1, now: "2026-10-21T10:00:00.000Z" });
  if (!exported.ok) throw new Error(`could not freeze: ${exported.reasons.join("; ")}`);
  writeDraft(config, exported.script);
  approveScript({ config, script: exported.script, caseText, by: "Odin", today: "2026-10-21", reason: "test" });
  const approved = loadApprovedScript({ register: loadFrozenRegister(config.frozen.registerFile), caseId: testCase.id, caseText, stepsInCase: testCase.steps.length });
  return { approved, runs };
}

function replay(testCase: TestCase, approved: ApprovedScript, config: Config, proposer?: ScriptedProposer): Promise<RunResult> {
  return runCase({
    testCase,
    caseSource: "test",
    targetOrigin: site.origin,
    model: new FrozenScriptModel(approved.script),
    config,
    secrets,
    frozen: { script: approved.script, scriptHash: approved.scriptHash, caseHash: approved.caseHash, ...(proposer ? { proposer } : {}) },
  });
}

describe("T20: a frozen script reproduces the verdict without a model", () => {
  it.each([
    [FORM, FORM_SCRIPT],
    [ACCT, "tests/ci/scripts/TC-ACCT-001.json"],
  ])("freezes %s, and the replay gives the verdict the agent runs gave, with no model call", async (casePath, scriptPath) => {
    const config = frozenConfig();
    const { approved, runs } = await freezeAndApprove(casePath, scriptPath, config);
    expect(runs.every((r) => r.verdict === "PASS")).toBe(true);
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: { "x-fixture-test": "1" }, body: "{}" });

    const { record } = await replay(loadCase(casePath), approved, config);
    expect(record.verdict).toBe(runs[0]!.verdict);
    expect(record.verdict_row).toBe(runs[0]!.verdict_row);
    expect(record.versions.model_client).toBe("frozen-script");
    expect(record.budget.used).toMatchObject({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    expect(record.judge.configured).toBe(false);
    // Every expected result was decided by the runner, with evidence it captured itself.
    expect(record.outcomes.every((o) => o.outcome === "MATCH" && o.evidence.length > 0)).toBe(true);
    expect(record.frozen).toMatchObject({ case_id: record.case.id, script_version: 1, script_hash: approved.scriptHash, case_hash: approved.caseHash, reengagement: "not_needed", proposal_file: null });
  });

  it("keeps the observation tools out of the script, and records where the proof came from", async () => {
    const config = frozenConfig();
    const { approved } = await freezeAndApprove(ACCT, "tests/ci/scripts/TC-ACCT-001.json", config);
    // The agent run also took a snapshot. The script holds only what acts.
    expect(approved.script.steps.flatMap((s) => s.actions.map((a) => a.tool))).toEqual(["goto"]);
    expect(approved.script.source.live_model).toBe(false);
    expect(approved.script.source.runs).toHaveLength(3);
  });

  it("the report names the script, its hash and the fact that no model was called", async () => {
    const config = frozenConfig();
    const { approved } = await freezeAndApprove(FORM, FORM_SCRIPT, config);
    const result = await replay(loadCase(FORM), approved, config);
    const report = buildReport({ reportId: "r1", generatedAt: "2026-10-21T10:00:00.000Z", plan: null, runs: [loadRun(result.runDir)] });
    expect(report.cases[0]!.run!.frozen).toMatchObject({ script_version: 1, script_hash: approved.scriptHash });
    expect(report.header.scripted).toBe(true); // a replay is not a language model, so it is never read as one
    expect(formatReport(report)).toContain(`frozen script TC-FORM-001 version 1, hash ${approved.scriptHash.slice(0, 12)}`);
  });
});

describe("T21: a frozen script cannot turn a FAIL into a PASS", () => {
  it("a failed assertion is FAIL on the same script that passes on the clean application, and nobody is asked", async () => {
    const config = frozenConfig();
    const { approved } = await freezeAndApprove(FORM, FORM_SCRIPT, config);
    const proposer = new ScriptedProposer("TC-FORM-001", [{ step: 3, actions: [{ tool: "click", args: { target: { role: "button", name: "Subscribe" } } }], rationale: "irrelevant" }]);

    const clean = await replay(loadCase(FORM), approved, config, proposer);
    expect(clean.record.verdict).toBe("PASS");

    site.setDefects(["email-validator=accepts-all"]);
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: { "x-fixture-test": "1" }, body: "{}" });
    const broken = await replay(loadCase(FORM), approved, config, proposer);
    expect(broken.record.verdict).toBe("FAIL");
    expect(broken.record.verdict_row).toBe(3);
    expect(broken.record.outcomes.some((o) => o.outcome === "MISMATCH")).toBe(true);
    // No agent re-run, no second chance: the proposer was never consulted, and nothing was written.
    expect(proposer.requests).toHaveLength(0);
    expect(broken.record.frozen!.reengagement).toBe("not_needed");
    expect(existsSync(join(broken.runDir, "proposal.json"))).toBe(false);
    expect(broken.record.model_output.attempts).toBe(1);
  });

  it("a step that cannot run is BLOCKED, the agent only proposes, and the script and the verdict are untouched", async () => {
    const config = frozenConfig((c) => {
      c.tools.actionTimeoutMs = 300;
    });
    const { approved } = await freezeAndApprove(FORM, FORM_SCRIPT, config);
    const fix = { step: 3, actions: [{ tool: "click", args: { target: { role: "button", name: "Send" } } }], rationale: "the button is now called Send" };
    const proposer = new ScriptedProposer("TC-FORM-001", [fix]);
    const scriptFile = approved.entry.file;
    const before = hashText(readFileSync(scriptFile, "utf8"));

    site.setDefects(["subscribe-button=Send"]);
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: { "x-fixture-test": "1" }, body: "{}" });
    const { record, runDir } = await replay(loadCase(FORM), approved, config, proposer);

    expect(record.verdict).toBe("BLOCKED");
    expect(record.blocked).toMatchObject({ step: 3, reason: "element_missing" });
    expect(record.frozen).toMatchObject({ reengagement: "proposal_written", proposal_file: "proposal.json", proposal_attempts: 1 });
    // The proposer saw the failing step and the page, as data. It was asked once.
    expect(proposer.requests).toHaveLength(1);
    expect(proposer.requests[0]!).toMatchObject({ step: 3, failed: { tool: "click" } });
    expect(proposer.requests[0]!.snapshot).toContain("Send");

    const proposal = ProposalSchema.parse(JSON.parse(readFileSync(join(runDir, "proposal.json"), "utf8")));
    expect(proposal).toMatchObject({ status: "proposed", case_id: "TC-FORM-001", script_version: 1, script_hash: approved.scriptHash, run_id: record.run_id });
    expect(proposal.proposed_by.live).toBe(false);
    // Nothing a model wrote has become part of the script.
    expect(hashText(readFileSync(scriptFile, "utf8"))).toBe(before);
    expect(loadFrozenRegister(config.frozen.registerFile).scripts).toHaveLength(1);

    const report = buildReport({ reportId: "r2", generatedAt: "2026-10-21T10:00:00.000Z", plan: null, runs: [loadRun(runDir)] });
    expect(report.cases[0]!.verified).toBe(false);
    expect(report.cases[0]!.attention.map((a) => a.kind)).toContain("frozen_step_could_not_run");
    expect(formatReport(report)).toContain("agent was asked only to propose a change");
  });

  it("a proposal that stays invalid is recorded as invalid, is never repaired, and the verdict is still BLOCKED", async () => {
    const config = frozenConfig((c) => {
      c.tools.actionTimeoutMs = 300;
    });
    const { approved } = await freezeAndApprove(FORM, FORM_SCRIPT, config);
    const proposer = new ScriptedProposer("TC-FORM-001", [
      { step: 3, actions: [{ tool: "click", args: { target: { role: "button", name: "Send" } } }] }, // no rationale
      { step: 2, actions: [{ tool: "click", args: { target: { role: "button", name: "Send" } } }], rationale: "wrong step" },
      { step: 3, actions: [{ tool: "run_shell", args: { command: "calc" } }], rationale: "not a tool a script may hold" },
    ]);
    site.setDefects(["subscribe-button=Send"]);
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: { "x-fixture-test": "1" }, body: "{}" });
    const { record, runDir } = await replay(loadCase(FORM), approved, config, proposer);
    expect(record.verdict).toBe("BLOCKED");
    expect(record.frozen).toMatchObject({ reengagement: "proposal_invalid", proposal_file: null, proposal_attempts: config.modelOutput.maxAttempts });
    expect(record.frozen!.proposal_errors).toHaveLength(config.modelOutput.maxAttempts);
    expect(record.frozen!.proposal_errors[1]).toContain("step: must be 3");
    expect(existsSync(join(runDir, "proposal.json"))).toBe(false);
    // The second attempt was told what was wrong with the first, in fields and rules.
    expect(proposer.requests[1]!.previousError).toContain("rationale");
  });

  it("with no proposer configured, a step that cannot run is BLOCKED and says nobody was asked", async () => {
    const config = frozenConfig((c) => {
      c.tools.actionTimeoutMs = 300;
    });
    const { approved } = await freezeAndApprove(FORM, FORM_SCRIPT, config);
    site.setDefects(["subscribe-button=Send"]);
    const { record } = await replay(loadCase(FORM), approved, config);
    expect(record.verdict).toBe("BLOCKED");
    expect(record.frozen).toMatchObject({ reengagement: "not_requested", proposal_file: null, proposal_attempts: 0 });
  });

  it("a person approves the proposal, the script gets a new version, and the next run uses it", async () => {
    const config = frozenConfig((c) => {
      c.tools.actionTimeoutMs = 300;
    });
    const { approved } = await freezeAndApprove(FORM, FORM_SCRIPT, config);
    const fix = { step: 3, actions: [{ tool: "click", args: { target: { role: "button", name: "Send" } } }], rationale: "the button is now called Send" };
    site.setDefects(["subscribe-button=Send"]);
    const first = await replay(loadCase(FORM), approved, config, new ScriptedProposer("TC-FORM-001", [fix]));
    const proposal = readProposal(join(first.runDir, "proposal.json"));
    const caseText = readFileSync(FORM, "utf8");
    const testCase = loadCase(FORM);

    // Nobody but a configured approver can approve it, and an empty approver list means nobody.
    expect(() => approveProposal({ config, proposal, caseText, stepsInCase: testCase.steps.length, by: "Mallory", today: "2026-10-22" })).toThrow(/not a configured approver/);
    expect(() => approveProposal({ config: frozenConfig((c) => void (c.release.approvers = [])), proposal, caseText, stepsInCase: testCase.steps.length, by: "Odin", today: "2026-10-22" })).toThrow(/No approver is configured/);
    expect(loadFrozenRegister(config.frozen.registerFile).scripts).toHaveLength(1);

    const entry = approveProposal({ config, proposal, caseText, stepsInCase: testCase.steps.length, by: "Odin", today: "2026-10-22" });
    expect(entry).toMatchObject({ case_id: "TC-FORM-001", version: 2, approved_by: "Odin", approved_on: "2026-10-22" });
    expect(entry.script_hash).not.toBe(approved.scriptHash);
    expect(nextVersion(loadFrozenRegister(config.frozen.registerFile), "TC-FORM-001")).toBe(3);
    // Version 1 is still on disk with the hash it was approved with.
    expect(hashText(readFileSync(approved.entry.file, "utf8"))).toBe(approved.scriptHash);

    const v2 = loadApprovedScript({ register: loadFrozenRegister(config.frozen.registerFile), caseId: "TC-FORM-001", caseText, stepsInCase: testCase.steps.length });
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: { "x-fixture-test": "1" }, body: "{}" });
    // The renamed button is in the page, so the approved change runs. The old proposal is now stale and cannot be approved again.
    const second = await replay(testCase, v2, config);
    expect(second.record.frozen).toMatchObject({ script_version: 2, reengagement: "not_needed" });
    expect(second.record.outcomes.some((o) => o.outcome === "MISMATCH")).toBe(false); // the message and status are what the case expects
    expect(() => approveProposal({ config, proposal, caseText, stepsInCase: testCase.steps.length, by: "Odin", today: "2026-10-23" })).toThrow(/stale/);
  });
});

describe("a script that was not approved, or has changed, does not run", () => {
  it("refuses a case with no approved script, even if a draft exists", async () => {
    const config = frozenConfig();
    const runs = await agentRuns(FORM, FORM_SCRIPT, config);
    const testCase = loadCase(FORM);
    const exported = exportScript({ runs, testCase, caseHash: hashText(readFileSync(FORM, "utf8")), minPassingRuns: 3, version: 1, now: "2026-10-21T10:00:00.000Z" });
    if (!exported.ok) throw new Error(exported.reasons.join("; "));
    writeDraft(config, exported.script);
    expect(() => loadApprovedScript({ register: loadFrozenRegister(config.frozen.registerFile), caseId: "TC-FORM-001", caseText: readFileSync(FORM, "utf8"), stepsInCase: 3 })).toThrow(/no approved frozen script/);
  });

  it("refuses a script whose file changed after it was approved", async () => {
    const config = frozenConfig();
    const { approved } = await freezeAndApprove(FORM, FORM_SCRIPT, config);
    const edited = readFileSync(approved.entry.file, "utf8").replace("not-an-email", "someone@example.com");
    expect(edited).not.toBe(readFileSync(approved.entry.file, "utf8"));
    writeFileSync(approved.entry.file, edited);
    expect(() => loadApprovedScript({ register: loadFrozenRegister(config.frozen.registerFile), caseId: "TC-FORM-001", caseText: readFileSync(FORM, "utf8"), stepsInCase: 3 })).toThrow(/has changed since Odin approved it/);
  });

  it("refuses a script when the case has changed since it was approved", async () => {
    const config = frozenConfig();
    await freezeAndApprove(FORM, FORM_SCRIPT, config);
    const loosened = readFileSync(FORM, "utf8").replace("exact: true", "exact: false");
    expect(loosened).not.toBe(readFileSync(FORM, "utf8"));
    expect(() => loadApprovedScript({ register: loadFrozenRegister(config.frozen.registerFile), caseId: "TC-FORM-001", caseText: loosened, stepsInCase: 3 })).toThrow(/case TC-FORM-001 has changed/);
  });

  it("only a configured approver can approve, and a draft for a changed case cannot be approved", async () => {
    const config = frozenConfig();
    const runs = await agentRuns(FORM, FORM_SCRIPT, config);
    const testCase = loadCase(FORM);
    const caseText = readFileSync(FORM, "utf8");
    const exported = exportScript({ runs, testCase, caseHash: hashText(caseText), minPassingRuns: 3, version: 1, now: "2026-10-21T10:00:00.000Z" });
    if (!exported.ok) throw new Error(exported.reasons.join("; "));
    const approve = (by: string, text = caseText, cfg = config) => approveScript({ config: cfg, script: exported.script, caseText: text, by, today: "2026-10-21", reason: "test" });
    expect(() => approve("")).toThrow(/--by <name> is required/);
    expect(() => approve("Mallory")).toThrow(/not a configured approver/);
    expect(() => approve("Odin", caseText, frozenConfig((c) => void (c.release.approvers = [])))).toThrow(/No approver is configured/);
    expect(() => approve("Odin", caseText.replace("exact: true", "exact: false"))).toThrow(/has changed since this script was frozen/);
    expect(loadFrozenRegister(config.frozen.registerFile).scripts).toHaveLength(0);
    approve("Odin");
    expect(() => approve("Odin")).toThrow(/next script must be version 2/);
  });

  it("the register refuses the same version twice, and a script file refuses a call the tool layer would reject", () => {
    const entry = { case_id: "TC-FORM-001", version: 1, file: "f.json", script_hash: "a".repeat(64), case_hash: "b".repeat(64), approved_by: "Odin", approved_on: "2026-10-21", reason: "x" };
    expect(FrozenRegisterSchema.safeParse({ schema_version: 1, scripts: [entry, entry] }).success).toBe(false);
    const base = { schema_version: 1, case_id: "TC-FORM-001", version: 1, case_hash: "b".repeat(64), frozen_at: "x", source: { runs: [{ run_id: "r", model_live: false }], live_model: false } };
    expect(FrozenScriptSchema.safeParse({ ...base, steps: [{ index: 1, actions: [{ tool: "goto", args: { url: "/form" } }] }] }).success).toBe(true);
    expect(FrozenScriptSchema.safeParse({ ...base, steps: [{ index: 1, actions: [{ tool: "goto", args: {} }] }] }).success).toBe(false);
    expect(FrozenScriptSchema.safeParse({ ...base, steps: [{ index: 1, actions: [{ tool: "snapshot", args: {} }] }] }).success).toBe(false);
    expect(FrozenScriptSchema.safeParse({ ...base, steps: [{ index: 1, actions: [{ tool: "fill_secret", args: { target: { role: "textbox" }, data_key: "password123" } }] }] }).success).toBe(false);
  });

  it("a hash does not depend on the line endings of a checkout", () => {
    expect(hashText("a\r\nb\r\n")).toBe(hashText("a\nb\n"));
    expect(hashText("a\nb\n")).not.toBe(hashText("a\nb\nc\n"));
  });
});

describe("freeze criteria: a case must have proved itself", () => {
  const exportWith = (runs: RunRecord[], testCase: TestCase, min = 3) => exportScript({ runs, testCase, caseHash: "c".repeat(64), minPassingRuns: min, version: 1, now: "2026-10-21T10:00:00.000Z" });

  it("refuses too few runs, a run that is not PASS, and runs of another case", async () => {
    const config = frozenConfig();
    const runs = await agentRuns(FORM, FORM_SCRIPT, config, 3);
    const testCase = loadCase(FORM);
    expect(exportWith(runs, testCase).ok).toBe(true);
    const few = exportWith(runs.slice(0, 2), testCase);
    expect(few.ok ? [] : few.reasons).toEqual([expect.stringContaining("needs 3 identical passing runs")]);

    site.setDefects(["email-validator=accepts-all"]);
    const failing = (await runScripted({ site, testCase, script: FORM_SCRIPT, config })).record;
    expect(failing.verdict).toBe("FAIL");
    const withFail = exportWith([...runs.slice(0, 2), failing], testCase);
    expect(withFail.ok ? [] : withFail.reasons.join(" ")).toContain("is FAIL, and only a PASS run can be frozen");

    const other = exportWith([...runs.slice(0, 2), (await agentRuns(ACCT, "tests/ci/scripts/TC-ACCT-001.json", config, 1))[0]!], testCase);
    expect(other.ok ? [] : other.reasons.join(" ")).toContain("is a run of TC-ACCT-001");
  });

  it("refuses runs that did different things, and a run with a failed tool call", async () => {
    const config = frozenConfig((c) => {
      c.tools.actionTimeoutMs = 300;
    });
    const runs = await agentRuns(FORM, FORM_SCRIPT, config, 2);
    const testCase = loadCase(FORM);
    const script = JSON.parse(readFileSync(FORM_SCRIPT, "utf8")) as { steps: Array<Array<{ tool: string; args: Record<string, unknown> }>> };

    // A third run that typed something else and still passed (the case only checks the message).
    const variant = structuredClone(script);
    variant.steps[1]![0]!.args["value"] = "also-not-an-email";
    const different = (await runScripted({ site, testCase, script: variant as never, config })).record;
    expect(different.verdict).toBe("PASS");
    const mixed = exportWith([...runs, different], testCase);
    expect(mixed.ok ? [] : mixed.reasons.join(" ")).toContain("did not do the same actions");

    // A run that clicked something that is not there first, then did the right thing. It passed, but it is not stable.
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: { "x-fixture-test": "1" }, body: "{}" });
    const stumble = structuredClone(script);
    stumble.steps[2]!.unshift({ tool: "click", args: { target: { role: "button", name: "Nope" } } });
    const stumbled = (await runScripted({ site, testCase, script: stumble as never, config })).record;
    expect(stumbled.verdict).toBe("PASS");
    const unstable = exportWith([stumbled, ...runs], testCase);
    expect(unstable.ok ? [] : unstable.reasons.join(" ")).toContain("had a tool call that failed");
  });

  it("refuses a case with a judged result, a run that replayed a script, and a typed secret", async () => {
    const config = frozenConfig();
    const runs = await agentRuns(FORM, FORM_SCRIPT, config, 3);
    const testCase = loadCase(FORM);

    const judged = { ...testCase, expected: [...testCase.expected, { id: "e9", after_step: 3, kind: "judged" as const, description: "the page looks right" }] };
    const withJudged = exportWith(runs, judged);
    expect(withJudged.ok ? [] : withJudged.reasons.join(" ")).toContain("judged expected result");

    const { approved } = await freezeAndApprove(FORM, FORM_SCRIPT, config);
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: { "x-fixture-test": "1" }, body: "{}" });
    const replayed = (await replay(testCase, approved, config)).record;
    const fromReplay = exportWith([replayed, replayed, replayed], testCase);
    expect(fromReplay.ok ? [] : fromReplay.reasons.join(" ")).toContain("replayed a frozen script");

    const scrubbed = structuredClone(runs);
    for (const r of scrubbed) r.steps[1]!.actions[0]!.args["value"] = "[REDACTED:data.password]";
    const secret = exportWith(scrubbed, testCase);
    expect(secret.ok ? [] : secret.reasons.join(" ")).toContain("fill_secret");
  });
});

describe("the replay client", () => {
  it("refuses a script for another case", async () => {
    const config = frozenConfig();
    const { approved } = await freezeAndApprove(FORM, FORM_SCRIPT, config);
    const model = new FrozenScriptModel(approved.script);
    await expect(model.nextAction({ testCase: loadCase(ACCT), stepIndex: 1, stepText: "x", actionsInStep: [] })).rejects.toThrow(/frozen script is for TC-FORM-001/);
  });

  it("stops at the first failed action and never carries on, and reports the right reason", async () => {
    const config = frozenConfig();
    const { approved } = await freezeAndApprove(FORM, FORM_SCRIPT, config);
    const model = new FrozenScriptModel(approved.script);
    const testCase = loadCase(FORM);
    const ask = (code: string) => model.nextAction({ testCase, stepIndex: 3, stepText: "x", actionsInStep: [{ tool: "click", args: {}, result: { ok: false, code, message: "m" } }] });
    expect(await ask("element_missing")).toMatchObject({ type: "stop", reason: "element_missing" });
    expect(await ask("ambiguous")).toMatchObject({ type: "stop", reason: "step_ambiguous" });
    expect(await ask("timeout")).toMatchObject({ type: "stop", reason: "element_missing" });
    expect(await model.nextAction({ testCase, stepIndex: 3, stepText: "x", actionsInStep: [] })).toMatchObject({ type: "tool_call", tool: "click" });
    expect(await model.nextAction({ testCase, stepIndex: 3, stepText: "x", actionsInStep: [{ tool: "click", args: {}, result: { ok: true } }] })).toEqual({ type: "step_done" });
  });
});
