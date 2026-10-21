// Hardening for the freezer: what a hostile or damaged file, a hung proposer or a changed case can and cannot do.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import type { Config } from "../../src/config.ts";
import { exportScript } from "../../src/frozen/export.ts";
import type { ProposalRequest, Proposer } from "../../src/frozen/propose.ts";
import { ScriptedProposer } from "../../src/frozen/propose.ts";
import { FrozenScriptModel } from "../../src/frozen/replay.ts";
import { hashText, ProposalSchema } from "../../src/frozen/schema.ts";
import { approveScript, FrozenError, loadApprovedScript, loadFrozenRegister, readFrozenScript, readProposal, scriptPath, scriptsDirectory, writeDraft, type ApprovedScript } from "../../src/frozen/store.ts";
import type { PauseSource } from "../../src/ops/kill-switch.ts";
import { runCase, type RunResult } from "../../src/runner/run-case.ts";
import type { RunRecord } from "../../src/schemas/run-record.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted, testConfig } from "./helpers/run.ts";

let site: FixtureSite;
const secrets = new StaticSecretStore(FIXTURE_SECRETS);
const FORM = "cases/TC-FORM-001.yaml";
const FORM_SCRIPT = "tests/ci/scripts/TC-FORM-001.json";
const T = { "x-fixture-test": "1", "content-type": "application/json" };

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});
beforeEach(async () => {
  site.setDefects([]);
  await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
});

function frozenConfig(change: (c: Config) => void = () => undefined): Config {
  const dir = mkdtempSync(join(tmpdir(), "qa-bot-frozen-"));
  return testConfig((c) => {
    c.frozen.directory = dir;
    c.frozen.registerFile = join(dir, "register.json");
    c.release.approvers = ["Odin"];
    change(c);
  });
}

async function agentRuns(config: Config, n = 3): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
    records.push((await runScripted({ site, testCase: loadCase(FORM), script: FORM_SCRIPT, config, secrets })).record);
  }
  return records;
}

async function freezeAndApprove(config: Config): Promise<ApprovedScript> {
  const testCase = loadCase(FORM);
  const caseText = readFileSync(FORM, "utf8");
  const exported = exportScript({ runs: await agentRuns(config), testCase, caseHash: hashText(caseText), minPassingRuns: 3, version: 1, now: "2026-10-21T10:00:00.000Z" });
  if (!exported.ok) throw new Error(exported.reasons.join("; "));
  approveScript({ config, script: exported.script, caseText, by: "Odin", today: "2026-10-21", reason: "test" });
  return load(config);
}

function load(config: Config, caseText = readFileSync(FORM, "utf8")): ApprovedScript {
  return loadApprovedScript({ register: loadFrozenRegister(config.frozen.registerFile), caseId: "TC-FORM-001", caseText, stepsInCase: 3, scriptsDirectory: scriptsDirectory(config) });
}

function replay(approved: ApprovedScript, config: Config, extra: { proposer?: Proposer; pause?: PauseSource; scriptHash?: string } = {}): Promise<RunResult> {
  return runCase({
    testCase: loadCase(FORM),
    caseSource: "test",
    targetOrigin: site.origin,
    model: new FrozenScriptModel(approved.script),
    config,
    secrets,
    ...(extra.pause ? { pause: extra.pause } : {}),
    frozen: { script: approved.script, scriptHash: extra.scriptHash ?? approved.scriptHash, caseHash: approved.caseHash, ...(extra.proposer ? { proposer: extra.proposer } : {}) },
  });
}

/** A proposer that never answers, as a live one can when its provider hangs. */
class HungProposer implements Proposer {
  readonly name = "hung-proposer";
  readonly modelId = "hung";
  readonly live = false;
  asked = 0;
  propose(_request: ProposalRequest): Promise<unknown> {
    this.asked += 1;
    return new Promise(() => undefined);
  }
}

describe("a proposer that hangs cannot keep the runner busy", () => {
  it("the kill switch ends the wait at once", async () => {
    const config = frozenConfig((c) => void (c.tools.actionTimeoutMs = 300));
    const approved = await freezeAndApprove(config);
    site.setDefects(["subscribe-button=Send"]);
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });

    let paused = false;
    const proposer = new HungProposer();
    const started = Date.now();
    // Engage the switch once the proposer has been asked.
    const watcher = setInterval(() => {
      if (proposer.asked > 0) paused = true;
    }, 20);
    const { record } = await replay(approved, config, { proposer, pause: { isPaused: () => paused } });
    clearInterval(watcher);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(proposer.asked).toBe(1);
    expect(record.run_state.runner_stop_reason).toBe("killed");
    expect(record.frozen).toMatchObject({ reengagement: "proposal_invalid", proposal_file: null });
    // The step still could not run, and nothing the proposer might have said reached the verdict.
    expect(record.verdict).toBe("BLOCKED");
    expect(record.model_output.attempts).toBe(0); // no final report was asked for after the kill
  });

  it("the time budget ends the wait", async () => {
    const config = frozenConfig((c) => {
      c.tools.actionTimeoutMs = 300;
      c.budgets.maxWallMs = 6000;
    });
    const approved = await freezeAndApprove(config);
    site.setDefects(["subscribe-button=Send"]);
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
    const started = Date.now();
    const { record } = await replay(approved, config, { proposer: new HungProposer() });
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(record.run_state.runner_stop_reason).toBe("timeout");
    expect(record.budget.stop?.detail).toContain("waiting for a proposal");
    expect(record.frozen!.reengagement).toBe("proposal_invalid");
  });

  it("an already paused runner is not asked for a proposal at all", async () => {
    const config = frozenConfig((c) => void (c.tools.actionTimeoutMs = 300));
    const approved = await freezeAndApprove(config);
    site.setDefects(["subscribe-button=Send"]);
    const proposer = new HungProposer();
    // The switch is engaged while the run is going, after the step has stopped but before the proposal is asked for.
    let calls = 0;
    const pause: PauseSource = { isPaused: () => (calls += 1) > 40 };
    const { record } = await replay(approved, config, { proposer, pause });
    expect(record.run_state.runner_stop_reason).toBe("killed");
    expect(proposer.asked).toBeLessThanOrEqual(1);
  });
});

describe("the hash in the record is the hash of the script that ran", () => {
  it("refuses a script that is not the one the hash names, or one for another case", async () => {
    const config = frozenConfig();
    const approved = await freezeAndApprove(config);
    await expect(replay(approved, config, { scriptHash: "0".repeat(64) })).rejects.toThrow(/not the one that was approved/);
    const other = { ...approved, script: { ...approved.script, case_id: "TC-ACCT-001" } };
    await expect(replay(other, config)).rejects.toThrow(/not the one that was approved|is for TC-ACCT-001/);
  });
});

describe("freezing needs runs of the case as it is now", () => {
  it("refuses runs made with other step text, other expected results or another role", async () => {
    const config = frozenConfig();
    const runs = await agentRuns(config);
    const testCase = loadCase(FORM);
    const exportWith = (c: typeof testCase) => exportScript({ runs, testCase: c, caseHash: "c".repeat(64), minPassingRuns: 3, version: 1, now: "2026-10-21T10:00:00.000Z" });
    expect(exportWith(testCase).ok).toBe(true);
    const text = exportWith({ ...testCase, steps: ["open the form", ...testCase.steps.slice(1)] });
    expect(text.ok ? [] : text.reasons.join(" ")).toContain("another version of the case");
    const expected = exportWith({ ...testCase, expected: testCase.expected.map((e, i) => (i === 0 ? { ...e, description: "something else" } : e)) });
    expect(expected.ok ? [] : expected.reasons.join(" ")).toContain("another version of the case");
    const role = exportWith({ ...testCase, role: "member" });
    expect(role.ok ? [] : role.reasons.join(" ")).toContain("another version of the case");
  });
});

describe("files the freezer reads are not trusted", () => {
  it("a register that points outside the scripts folder does not run, even with a matching hash", async () => {
    const config = frozenConfig();
    const approved = await freezeAndApprove(config);
    const elsewhere = join(mkdtempSync(join(tmpdir(), "qa-bot-elsewhere-")), "copy.json");
    writeFileSync(elsewhere, readFileSync(approved.entry.file));
    const register = loadFrozenRegister(config.frozen.registerFile);
    writeFileSync(config.frozen.registerFile, JSON.stringify({ ...register, scripts: register.scripts.map((s) => ({ ...s, file: elsewhere })) }));
    expect(() => load(config)).toThrow(/is not inside/);
    const dotted = join(scriptsDirectory(config), "..", "..", "x.json");
    writeFileSync(config.frozen.registerFile, JSON.stringify({ ...register, scripts: register.scripts.map((s) => ({ ...s, file: dotted })) }));
    expect(() => load(config)).toThrow(/is not inside/);
  });

  it("a case id that is not a case id is refused wherever it is read, so it cannot become a path", () => {
    const base = {
      schema_version: 1,
      status: "proposed",
      script_version: 1,
      script_hash: "a".repeat(64),
      run_id: "r",
      proposed_by: { name: "p", model_id: "m", live: false },
      failed: { step: 1, step_text: "t", tool: "click", args: {}, error: "e" },
      proposal: { step: 1, actions: [{ tool: "goto", args: { url: "/form" } }], rationale: "r" },
    };
    expect(ProposalSchema.safeParse({ ...base, case_id: "TC-FORM-001" }).success).toBe(true);
    for (const bad of ["../../etc/passwd", "TC-FORM-001/../../x", "..\\..\\x", "TC-FORM-001.yaml", "tc-form-001", ""]) {
      expect(ProposalSchema.safeParse({ ...base, case_id: bad }).success, bad).toBe(false);
    }
  });

  it("a file that is too large, not JSON, or not valid gives a plain error, never a stack trace or a read of the whole file", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-big-"));
    const big = join(dir, "register.json");
    writeFileSync(big, `{"schema_version":1,"scripts":[],"pad":"${"x".repeat(1_100_000)}"}`);
    expect(() => loadFrozenRegister(big)).toThrow(/limit/);
    const junk = join(dir, "junk.json");
    writeFileSync(junk, "{ not json");
    expect(() => loadFrozenRegister(junk)).toThrow(FrozenError);
    expect(() => readFrozenScript(junk)).toThrow(/not valid JSON/);
    expect(() => readProposal(junk)).toThrow(FrozenError);
    writeFileSync(junk, JSON.stringify({ schema_version: 1 }));
    expect(() => readFrozenScript(junk)).toThrow(/is not valid/);
    expect(() => readFrozenScript(join(dir, "none.json"))).toThrow(/there is no script/);
  });
});

describe("approving is safe against a second approval and a crash", () => {
  async function draft(config: Config) {
    const testCase = loadCase(FORM);
    const caseText = readFileSync(FORM, "utf8");
    const exported = exportScript({ runs: await agentRuns(config), testCase, caseHash: hashText(caseText), minPassingRuns: 3, version: 1, now: "2026-10-21T10:00:00.000Z" });
    if (!exported.ok) throw new Error(exported.reasons.join("; "));
    return { script: exported.script, caseText };
  }

  it("refuses while another approval holds the lock, and releases the lock afterwards", async () => {
    const config = frozenConfig();
    const { script, caseText } = await draft(config);
    const lock = `${config.frozen.registerFile}.lock`;
    mkdirSync(join(config.frozen.registerFile, ".."), { recursive: true });
    writeFileSync(lock, "");
    expect(() => approveScript({ config, script, caseText, by: "Odin", today: "2026-10-21", reason: "t" })).toThrow(/another approval is in progress/);
    expect(loadFrozenRegister(config.frozen.registerFile).scripts).toHaveLength(0);
    writeFileSync(lock, "", { flag: "w" });
    // A person removes a stale lock.
    (await import("node:fs")).rmSync(lock);
    approveScript({ config, script, caseText, by: "Odin", today: "2026-10-21", reason: "t" });
    expect(existsSync(lock)).toBe(false);
  });

  it("finishes an approval that stopped half way when the leftover file is the same, and refuses a leftover that differs", async () => {
    const config = frozenConfig();
    const { script, caseText } = await draft(config);
    const file = scriptPath(config, script.case_id, script.version);
    // A script file with no register entry, as a crash between the two writes leaves it.
    writeDraft(config, script);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, readFileSync(join(config.frozen.directory, "drafts", `${script.case_id}.v1.json`)));
    const entry = approveScript({ config, script, caseText, by: "Odin", today: "2026-10-21", reason: "t" });
    expect(entry.script_hash).toBe(hashText(readFileSync(file, "utf8")));

    const config2 = frozenConfig();
    const again = await draft(config2);
    const file2 = scriptPath(config2, again.script.case_id, again.script.version);
    mkdirSync(join(file2, ".."), { recursive: true });
    writeFileSync(file2, "{ other content }");
    expect(() => approveScript({ config: config2, script: again.script, caseText: again.caseText, by: "Odin", today: "2026-10-21", reason: "t" })).toThrow(/already exists with other content/);
    expect(loadFrozenRegister(config2.frozen.registerFile).scripts).toHaveLength(0);
  });

  it("leaves no temporary files behind", async () => {
    const config = frozenConfig();
    const { script, caseText } = await draft(config);
    approveScript({ config, script, caseText, by: "Odin", today: "2026-10-21", reason: "t" });
    const all = [config.frozen.directory, join(config.frozen.directory, "scripts")].flatMap((d) => readdirSync(d));
    expect(all.filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"))).toEqual([]);
  });

  it("a proposal's case can be named with --case, and a wrong case file gets an honest message", async () => {
    const config = frozenConfig();
    const { script, caseText } = await draft(config);
    expect(() => approveScript({ config, script, caseText: caseText + "\n# edited", by: "Odin", today: "2026-10-21", reason: "t" })).toThrow(/is not the one TC-FORM-001 was frozen from.*--case/);
  });
});

describe("a replay of a script with a hostile page cannot go anywhere a case could not", () => {
  it("an off-allowlist goto in an approved script is still refused by the tool layer", async () => {
    const config = frozenConfig();
    const approved = await freezeAndApprove(config);
    // A script that a person approved, with a step that goes off the allowlist. The runner applies the same rules to it as to any run.
    const evil = JSON.parse(JSON.stringify(approved.script)) as typeof approved.script;
    evil.steps[0]!.actions = [{ tool: "goto", args: { url: "https://example.invalid/steal" } }];
    const { serializeScript } = await import("../../src/frozen/schema.ts");
    const hash = hashText(serializeScript(evil));
    const { record } = await replay({ ...approved, script: evil, scriptHash: hash }, config, { scriptHash: hash });
    expect(record.run_state.guardrail_block).toBe(true);
    expect(record.verdict).toBe("INCONCLUSIVE");
    expect(record.guardrail_events.some((e) => e.decision === "blocked" && e.url.includes("example.invalid"))).toBe(true);
  });

  it("a script cannot hold a tool a script may not use, or a call the tool layer would reject", () => {
    // The shell, file and network tools do not exist in the tool list at all, and a script can only name the six acting tools.
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-hostile-"));
    const file = join(dir, "script.json");
    for (const action of [{ tool: "run_shell", args: { command: "calc" } }, { tool: "snapshot", args: {} }, { tool: "goto", args: { url: "/x", extra: 1 } }]) {
      writeFileSync(file, JSON.stringify({ schema_version: 1, case_id: "TC-FORM-001", version: 1, case_hash: "b".repeat(64), frozen_at: "x", source: { runs: [{ run_id: "r", model_live: false }], live_model: false }, steps: [{ index: 1, actions: [action] }] }));
      expect(() => readFrozenScript(file), JSON.stringify(action)).toThrow(/is not valid/);
    }
  });
});

describe("the scripted proposer", () => {
  it("is for one case only", async () => {
    const proposer = new ScriptedProposer("TC-FORM-001", [{}]);
    await expect(proposer.propose({ testCase: loadCase("cases/TC-ACCT-001.yaml") } as unknown as ProposalRequest)).rejects.toThrow(/proposals are for TC-FORM-001/);
  });
});
