// T2: credentials never reach the model or the artifacts.
// After runs that use a stored session and fill_secret, the model context, logs, HAR files, evidence and
// run record contain no password, token, API key or session cookie value. Cookie, Authorization and
// Set-Cookie headers are redacted, tracing is not used, and the session file is unreachable from the
// model's tools and the artifact store.
//
// The scan uses its OWN redactor, fed with the real server-side session tokens, so it does not depend
// on what the run's scrubber happened to learn.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase, validateCase } from "../../src/cases/load.ts";
import { Redactor } from "../../src/redact/redactor.ts";
import { scanArtifacts } from "../../src/redact/scan.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
import { ScriptedModelClient } from "../../src/model/scripted.ts";
import type { FinalContext } from "../../src/model/client.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { RecordingModel, runScripted, testConfig } from "./helpers/run.ts";

const store = new StaticSecretStore(FIXTURE_SECRETS);
const T = { "x-fixture-test": "1", "content-type": "application/json" };
let site: FixtureSite;

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

async function liveTokens(): Promise<string[]> {
  const res = await fetch(site.origin + "/__test/sessions", { headers: T });
  return ((await res.json()) as { tokens: string[] }).tokens;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? allFiles(join(dir, n)) : [join(dir, n)]));
}

/** Everything a credential could hide in. Each assertion explains what it proves. */
function assertNoCredentials(args: { runDir: string; sessionsDir: string; seen: string[]; secrets: string[]; tokens: string[] }): void {
  const independent = new Redactor();
  args.secrets.forEach((s, i) => independent.add(s, `secret${i}`));
  args.tokens.forEach((t, i) => independent.add(t, `token${i}`));

  // 1. Nothing the run stored contains a secret or a live session token, and no credential header is unredacted.
  const scan = scanArtifacts(args.runDir, independent);
  expect(scan.findings, "stored artifacts").toEqual([]);
  expect(scan.filesScanned).toBeGreaterThan(3);

  // 2. Nothing the model was shown contains one.
  for (const text of args.seen) {
    for (const { variant, label } of independent.trackedVariants()) expect(text.includes(variant), `model context contains ${label}`).toBe(false);
  }

  // 3. The session file is gone, and was never inside the run directory.
  expect(existsSync(args.sessionsDir) ? allFiles(args.sessionsDir) : [], "leftover private files").toEqual([]);
  expect(relative(args.runDir, args.sessionsDir).startsWith("..")).toBe(true);

  // 4. No Playwright trace was recorded.
  expect(allFiles(args.runDir).filter((f) => /trace/i.test(f))).toEqual([]);
}

const MEMBER_PASSWORD = FIXTURE_SECRETS["fixture_member.password"] as string;
const LOCK_PASSWORD = FIXTURE_SECRETS["lock_test_01.password"] as string;
const API_KEY = FIXTURE_SECRETS["fixture_apikey.value"] as string;
const ALL_SECRETS = [MEMBER_PASSWORD, LOCK_PASSWORD, API_KEY];

describe("T2 credentials never reach the model or the artifacts", () => {
  it("a login case that uses fill_secret", async () => {
    const config = testConfig();
    const model = new RecordingModel(ScriptedModelClient.fromFile("tests/ci/scripts/TC-AUTH-004.json"));
    const { record, runDir } = await runScripted({ site, testCase: loadCase("cases/TC-AUTH-004.yaml"), script: "", model, config, secrets: store });
    expect(record.verdict).toBe("PASS"); // the credentials were really used: the correct password was rejected only because the account is locked
    expect(record.steps[4]?.actions[0]).toMatchObject({ tool: "fill_secret", ok: true });
    assertNoCredentials({ runDir, sessionsDir: config.sessions.directory, seen: model.seen, secrets: ALL_SECRETS, tokens: [] });
  });

  it("a case that starts from a stored session", async () => {
    const config = testConfig();
    const model = new RecordingModel(ScriptedModelClient.fromFile("tests/ci/scripts/TC-ACCT-001.json"));
    const { record, runDir } = await runScripted({ site, testCase: loadCase("cases/TC-ACCT-001.yaml"), script: "", model, config, secrets: store });
    expect(record.verdict).toBe("PASS"); // the browser really was signed in
    const tokens = await liveTokens();
    expect(tokens.length, "there is a real session token to look for").toBeGreaterThan(0);
    assertNoCredentials({ runDir, sessionsDir: config.sessions.directory, seen: model.seen, secrets: ALL_SECRETS, tokens });

    // The HAR exists, shows that requests carried the cookie, and has it redacted.
    const har = readFileSync(join(runDir, "network.har"), "utf8");
    expect(har).toMatch(/"name": "Cookie"/i);
    expect(har).toContain('"value": "[REDACTED]"');
    expect(readFileSync(join(runDir, "model-context.jsonl"), "utf8").length).toBeGreaterThan(0);
  });

  it("an application that leaks the cookie into its page and the password into its console", async () => {
    const config = testConfig();
    const leakCase = validateCase({
      id: "TC-TEST-010",
      title: "Visit pages that leak secrets",
      priority: "P2",
      role: "member",
      steps: ["open /debug/session", "read the page", "open /debug/console-leak", "read the console", "read the page"],
      expected: [{ id: "l1", after_step: 5, kind: "url", matches: "console-leak", description: "The leak page is open" }],
    });
    const model = new RecordingModel(
      new ScriptedModelClient({
        case_id: "TC-TEST-010",
        steps: [
          [{ tool: "goto", args: { url: "/debug/session" } }],
          [{ tool: "snapshot", args: {} }, { tool: "network_errors", args: {} }],
          [{ tool: "goto", args: { url: "/debug/console-leak" } }],
          [{ tool: "console_errors", args: {} }],
          [{ tool: "snapshot", args: {} }, { tool: "screenshot", args: { label: "leak" } }],
        ],
        observations: [],
        injection_suspected: false,
        notes: "",
      }),
    );
    const { record, runDir } = await runScripted({ site, testCase: leakCase, script: "", model, config, secrets: store });
    expect(record.verdict).toBe("PASS");
    const tokens = await liveTokens();
    expect(tokens.length).toBeGreaterThan(0);
    // The trap really did put the cookie on the page: the model's view of it must be redacted, not just empty.
    const shown = model.seen.join("\n");
    expect(shown).toContain("[REDACTED:member.cookie.fx_session]");
    expect(shown).toContain("[REDACTED:member.password]");
    assertNoCredentials({ runDir, sessionsDir: config.sessions.directory, seen: model.seen, secrets: ALL_SECRETS, tokens });
  });

  it("fails closed: a credential that slips into a stored file makes the run INCONCLUSIVE and is cleaned", async () => {
    const config = testConfig();
    class PlantingModel extends RecordingModel {
      override async finalOutput(context: FinalContext): Promise<unknown> {
        // Simulates a defect in the scrubber: a stored text file and a stored binary file hold the password.
        const runId = readdirSync(config.runs.directory)[0] as string;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(join(config.runs.directory, runId, "planted.txt"), `leaked: ${MEMBER_PASSWORD}`);
        writeFileSync(join(config.runs.directory, runId, "planted.bin"), Buffer.concat([Buffer.from([1, 2, 3]), Buffer.from(MEMBER_PASSWORD)]));
        return super.finalOutput(context);
      }
    }
    const model = new PlantingModel(ScriptedModelClient.fromFile("tests/ci/scripts/TC-ACCT-001.json"));
    const { record, runDir } = await runScripted({ site, testCase: loadCase("cases/TC-ACCT-001.yaml"), script: "", model, config, secrets: store });
    expect(record.verdict).toBe("INCONCLUSIVE");
    expect(record.verdict_row).toBe(1);
    expect(record.run_state.infrastructure_failure).toMatch(/credential was found in stored artifacts \(member\.password\)/);
    expect(readFileSync(join(runDir, "planted.txt"), "utf8")).toBe("leaked: [REDACTED:member.password]");
    expect(existsSync(join(runDir, "planted.bin"))).toBe(false);
    const independent = new Redactor();
    independent.add(MEMBER_PASSWORD, "member.password");
    expect(scanArtifacts(runDir, independent).findings).toEqual([]);
  });

  it("a failed login reports no credential", async () => {
    const config = testConfig();
    const bad = new StaticSecretStore({ ...FIXTURE_SECRETS, "fixture_member.password": "Wrong-Secret-4455" });
    const testCase = { ...loadCase("cases/TC-ACCT-001.yaml") };
    const { record, runDir } = await runScripted({ site, testCase, script: "tests/ci/scripts/TC-ACCT-001.json", config, secrets: bad });
    expect(record.verdict).toBe("INCONCLUSIVE");
    for (const f of allFiles(runDir)) expect(readFileSync(f, "utf8")).not.toContain("Wrong-Secret-4455");
    expect(existsSync(config.sessions.directory) ? allFiles(config.sessions.directory) : []).toEqual([]);
  });

  it("the session directory is private and not under the runs directory", () => {
    const config = testConfig();
    expect(relative(config.runs.directory, config.sessions.directory).startsWith("..")).toBe(true);
    expect(mkdtempSync(join(tmpdir(), "x-"))).toBeTruthy();
  });
});
