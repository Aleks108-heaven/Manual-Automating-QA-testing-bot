// T11: the kill switch works. Pausing stops runs and revokes the runner's credentials, and resuming follows
// the documented steps.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import type { Config } from "../../src/config.ts";
import { KillSwitch, KillSwitchError, RunnerPausedError } from "../../src/ops/kill-switch.ts";
import type { FinalContext, ModelAction, ModelClient, ModelContext } from "../../src/model/client.ts";
import type { PreflightReport } from "../../src/preflight/report.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
import { establishSession } from "../../src/sessions/session-setup.ts";
import { Redactor } from "../../src/redact/redactor.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted, testConfig } from "./helpers/run.ts";

let site: FixtureSite;
const T = { "x-fixture-test": "1", "content-type": "application/json" };
const store = new StaticSecretStore(FIXTURE_SECRETS);

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});
beforeEach(async () => {
  await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
});

const login = () =>
  fetch(site.origin + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "fixture_member", password: FIXTURE_SECRETS["fixture_member.password"] }),
  });

const auditActions = (config: Config) =>
  existsSync(config.killSwitch.auditLog)
    ? readFileSync(config.killSwitch.auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

function goodReport(at: Date, overrides: Partial<PreflightReport> = {}): PreflightReport {
  return { schema_version: 1, purpose: "resume", at: at.toISOString(), target: site.origin, ok: true, checks: [{ name: "target healthy", status: "passed", detail: "ok", ms: 1 }], ...overrides };
}
function saveReport(config: Config, report: unknown): string {
  const path = join(dirname(config.killSwitch.stateFile), `report-${Math.random().toString(36).slice(2)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof report === "string" ? report : JSON.stringify(report));
  return path;
}
const later = (ms = 2000) => new Date(Date.now() + ms);

describe("T11 engaging the kill switch", () => {
  it("is not engaged to begin with", () => {
    const ks = new KillSwitch({ config: testConfig(), targetOrigin: site.origin });
    expect(ks.status()).toEqual({ paused: false });
    expect(ks.isPaused()).toBe(false);
  });

  it("pauses the runner and records who and why", async () => {
    const config = testConfig();
    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    const state = await ks.engage({ by: "alex", reason: "the bot clicked something it should not have" });
    expect(state).toMatchObject({ paused: true, engaged_by: "alex", reason: "the bot clicked something it should not have" });
    expect(ks.isPaused()).toBe(true);
    // A second process reads the same file.
    expect(new KillSwitch({ config, targetOrigin: site.origin }).isPaused()).toBe(true);
    expect(readdirSync(dirname(config.killSwitch.stateFile)).filter((f) => f.includes(".tmp-"))).toEqual([]); // the write was atomic
  });

  it("revokes the runner's credentials: private session files are deleted and the target refuses the bot accounts", async () => {
    const config = testConfig();
    const session = await establishSession({ role: "member", config, secrets: store, targetOrigin: site.origin, runId: "r1", runDir: join(config.runs.directory, "r1"), redactor: new Redactor() });
    expect(existsSync(session.storageStatePath as string)).toBe(true);
    expect((await login()).status).toBe(200);

    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    const state = await ks.engage({ by: "alex", reason: "test" });
    expect(state.revoked?.session_files_removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(session.storageStatePath as string)).toBe(false);
    expect(state.revoked?.calls).toEqual([{ call: "POST /__test/revoke", ok: true, detail: "answered 200" }]);
    expect((await login()).status).toBe(403); // the account is disabled
    // Every server-side session was ended as well, so a copy of the session file would be useless.
    expect((await fetch(site.origin + "/__test/sessions", { headers: T }).then((r) => r.json())) as { tokens: string[] }).toEqual({ tokens: [] });
  });

  it("is safe to engage twice: the second call changes nothing and is recorded", async () => {
    const config = testConfig();
    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    const first = await ks.engage({ by: "alex", reason: "first" });
    const second = await ks.engage({ by: "sam", reason: "second" });
    expect(second.engaged_at).toBe(first.engaged_at);
    expect(second.engaged_by).toBe("alex");
    expect(auditActions(config).map((a) => a["action"])).toEqual(["engage", "revoke", "engage-ignored"]);
  });

  it("needs a name and a reason", async () => {
    const ks = new KillSwitch({ config: testConfig(), targetOrigin: site.origin });
    await expect(ks.engage({ by: "", reason: "x" })).rejects.toThrow(KillSwitchError);
    await expect(ks.engage({ by: "alex", reason: "  " })).rejects.toThrow(/why/i);
    expect(ks.isPaused()).toBe(false);
  });

  it("only the configured holders can engage it, and a refusal is recorded", async () => {
    const config = testConfig((c) => {
      c.killSwitch.holders = ["alex"];
    });
    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    await expect(ks.engage({ by: "mallory", reason: "because" })).rejects.toThrow(/not a kill-switch holder/);
    expect(ks.isPaused()).toBe(false);
    await ks.engage({ by: "alex", reason: "because" });
    expect(ks.isPaused()).toBe(true);
    expect(auditActions(config).map((a) => a["action"])).toEqual(["engage-refused", "engage", "revoke"]);
  });

  it("fails closed: a state file that cannot be read counts as engaged", () => {
    const config = testConfig();
    mkdirSync(dirname(config.killSwitch.stateFile), { recursive: true });
    writeFileSync(config.killSwitch.stateFile, "{ this is not json");
    expect(new KillSwitch({ config, targetOrigin: site.origin }).isPaused()).toBe(true);
  });

  it("still pauses when a revoke call fails, and says so", async () => {
    const config = testConfig((c) => {
      c.killSwitch.revokeCalls = [{ call: "POST /__test/no-such-revoke" }];
    });
    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    const state = await ks.engage({ by: "alex", reason: "test" });
    expect(ks.isPaused()).toBe(true);
    expect(state.revoked?.calls[0]).toMatchObject({ ok: false });
  });
});

describe("T11 pausing stops runs", () => {
  const form = () => loadCase("cases/TC-FORM-001.yaml");

  it("a paused runner refuses to start a run, and creates nothing", async () => {
    const config = testConfig();
    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    await ks.engage({ by: "alex", reason: "test" });
    await expect(runScripted({ site, testCase: form(), script: "tests/ci/scripts/TC-FORM-001.json", config, pause: ks })).rejects.toBeInstanceOf(RunnerPausedError);
    expect(existsSync(config.runs.directory) ? readdirSync(config.runs.directory) : []).toEqual([]);
  });

  it("a run in progress stops at once when the switch is engaged, and ends INCOMPLETE", async () => {
    const config = testConfig();
    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    const slow = {
      case_id: "TC-FORM-001",
      steps: [[{ tool: "goto", args: { url: "/form" } }], [{ tool: "snapshot", args: {}, delay_ms: 20_000 }]] as never,
      observations: [],
      injection_suspected: false,
      notes: "",
    };
    const started = Date.now();
    const running = runScripted({ site, testCase: form(), script: slow, config, pause: ks });
    await new Promise((r) => setTimeout(r, 2500)); // the run is inside the slow step by now
    const engagedAt = Date.now();
    await ks.engage({ by: "alex", reason: "stop everything" });
    const { record } = await running;
    expect(record.verdict).toBe("INCOMPLETE");
    expect(record.verdict_row).toBe(5);
    expect(record.run_state.runner_stop_reason).toBe("killed");
    expect(Date.now() - engagedAt).toBeLessThan(8000);
    expect(Date.now() - started).toBeLessThan(15_000); // it did not wait for the 20 second step
  });

  it("a model that never answers cannot keep a paused runner busy", async () => {
    class HungModel implements ModelClient {
      readonly name = "hung";
      nextAction(_context: ModelContext): Promise<ModelAction> {
        return new Promise(() => undefined);
      }
      async finalOutput(_context: FinalContext): Promise<unknown> {
        throw new Error("not reached");
      }
    }
    const config = testConfig();
    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    const running = runScripted({ site, testCase: form(), script: "", model: new HungModel(), config, pause: ks });
    await new Promise((r) => setTimeout(r, 1500));
    await ks.engage({ by: "alex", reason: "hung" });
    const { record } = await running;
    expect(record.run_state.runner_stop_reason).toBe("killed");
    expect(record.verdict).toBe("INCOMPLETE");
  });
});

describe("T11 resuming follows the documented steps", () => {
  async function engaged() {
    const config = testConfig();
    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    await ks.engage({ by: "alex", reason: "an incident" });
    return { config, ks };
  }
  const good = { by: "sam", review: "REVIEW-12", fix: "PR-34" };

  it("is refused when the switch is not engaged", async () => {
    const config = testConfig();
    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    await expect(ks.resume({ ...good, preflightReport: saveReport(config, goodReport(later())) })).rejects.toThrow(/not engaged/);
  });

  it.each([
    ["no name", { by: "" }, /who is resuming/],
    ["no completed review", { review: "" }, /completed review/],
    ["no verified fix", { fix: " " }, /verified fix/],
  ])("is refused with %s", async (_name, change, pattern) => {
    const { config, ks } = await engaged();
    await expect(ks.resume({ ...good, ...change, preflightReport: saveReport(config, goodReport(later())) })).rejects.toThrow(pattern);
    expect(ks.isPaused()).toBe(true);
  });

  it("is refused without a pre-flight report, or with one that is unreadable", async () => {
    const { config, ks } = await engaged();
    await expect(ks.resume({ ...good, preflightReport: "" })).rejects.toThrow(/pre-flight report is required/);
    await expect(ks.resume({ ...good, preflightReport: join(config.runs.directory, "nope.json") })).rejects.toThrow(/does not exist/);
    await expect(ks.resume({ ...good, preflightReport: saveReport(config, "not json") })).rejects.toThrow(/not a valid report/);
    await expect(ks.resume({ ...good, preflightReport: saveReport(config, { ok: true }) })).rejects.toThrow(/not a valid report/);
    expect(ks.isPaused()).toBe(true);
  });

  it("is refused when the report is not clean: a failed check, ok false, or a skipped check", async () => {
    const { config, ks } = await engaged();
    const at = later();
    const failed = goodReport(at, { ok: false, checks: [{ name: "canary", status: "failed", detail: "the negative control passed", ms: 1 }] });
    const skipped = goodReport(at, { checks: [{ name: "canary", status: "skipped", detail: "skipped", ms: 0 }] });
    const lying = goodReport(at, { ok: true, checks: [{ name: "canary", status: "failed", detail: "", ms: 1 }] });
    for (const report of [failed, skipped, lying]) await expect(ks.resume({ ...good, preflightReport: saveReport(config, report) })).rejects.toThrow(/not clean/);
    expect(ks.isPaused()).toBe(true);
  });

  it("is refused when the report was made for a run, not for resuming", async () => {
    const { config, ks } = await engaged();
    await expect(ks.resume({ ...good, preflightReport: saveReport(config, goodReport(later(), { purpose: "run" })) })).rejects.toThrow(/not made for resuming/);
    expect(ks.isPaused()).toBe(true);
  });

  it("is refused when the report is older than the engagement", async () => {
    const { config, ks } = await engaged();
    await expect(ks.resume({ ...good, preflightReport: saveReport(config, goodReport(new Date(Date.now() - 60_000))) })).rejects.toThrow(/older than the engagement/);
    expect(ks.isPaused()).toBe(true);
  });

  it("stays paused when restoring access fails", async () => {
    const config = testConfig((c) => {
      c.killSwitch.restoreCalls = [{ call: "POST /__test/no-such-restore" }];
    });
    const ks = new KillSwitch({ config, targetOrigin: site.origin });
    await ks.engage({ by: "alex", reason: "x" });
    await expect(ks.resume({ ...good, preflightReport: saveReport(config, goodReport(later())) })).rejects.toThrow(/restoring access failed/);
    expect(ks.isPaused()).toBe(true);
  });

  it("with a named reviewer, a fix, and a clean report it restores access and allows a run again", async () => {
    const { config, ks } = await engaged();
    expect((await login()).status).toBe(403);
    const state = await ks.resume({ ...good, preflightReport: saveReport(config, goodReport(later())) });
    expect(state).toMatchObject({ paused: false, resumed_by: "sam" });
    expect(ks.isPaused()).toBe(false);
    expect((await login()).status).toBe(200); // the account works again
    const { record } = await runScripted({ site, testCase: loadCase("cases/TC-FORM-001.yaml"), script: "tests/ci/scripts/TC-FORM-001.json", config, pause: ks });
    expect(record.verdict).toBe("PASS");
  });

  it("every action is in the audit log, in order, with who and why, including the refusals", async () => {
    const { config, ks } = await engaged();
    await expect(ks.resume({ by: "sam", review: "", fix: "PR-34", preflightReport: saveReport(config, goodReport(later())) })).rejects.toThrow();
    await ks.resume({ ...good, preflightReport: saveReport(config, goodReport(later())) });
    const log = auditActions(config);
    expect(log.map((a) => a["action"])).toEqual(["engage", "revoke", "resume-refused", "restore", "resume"]);
    expect(log[0]).toMatchObject({ by: "alex", reason: "an incident" });
    expect(log[2]).toMatchObject({ by: "sam", why: expect.stringContaining("completed review") });
    expect(log[4]).toMatchObject({ by: "sam", review: "REVIEW-12", fix: "PR-34" });
    for (const entry of log) expect(typeof entry["at"]).toBe("string");
  });
});
