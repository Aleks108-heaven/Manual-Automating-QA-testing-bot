// Secrets and sessions (M2 step 3): the session is made outside the model's context, per case, and removed afterwards.
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { loadConfig } from "../../src/config.ts";
import { Redactor } from "../../src/redact/redactor.ts";
import { EnvSecretStore, envVarFor, parseSecretRef, SecretError, StaticSecretStore } from "../../src/secrets/store.ts";
import { establishSession, parseSetCookie, SessionError } from "../../src/sessions/session-setup.ts";
import { ToolLayer } from "../../src/tools/tool-layer.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted, testConfig } from "./helpers/run.ts";

let site: FixtureSite;
const store = new StaticSecretStore(FIXTURE_SECRETS);

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});
beforeEach(async () => {
  await fetch(site.origin + "/__test/reset", { method: "POST", headers: { "x-fixture-test": "1" }, body: "{}" });
});

function setup(role: string, overrides: { secrets?: StaticSecretStore; sessionsDir?: string } = {}) {
  const config = loadConfig();
  const runDir = mkdtempSync(join(tmpdir(), "qa-bot-run-"));
  config.sessions.directory = overrides.sessionsDir ?? mkdtempSync(join(tmpdir(), "qa-bot-sess-"));
  const redactor = new Redactor();
  return { config, runDir, redactor, options: { role, config, secrets: overrides.secrets ?? store, targetOrigin: site.origin, runId: "run-1", runDir, redactor } };
}

async function accountText(storageStatePath: string | null): Promise<{ status: string; text: string }> {
  const config = loadConfig();
  const layer = await ToolLayer.create({
    targetOrigin: site.origin,
    config,
    runDir: mkdtempSync(join(tmpdir(), "qa-bot-view-")),
    ...(storageStatePath ? { storageStatePath } : {}),
  });
  try {
    await layer.call("goto", { url: "/account" });
    const page = layer.runnerAccess().page();
    return { status: new URL(page.url()).pathname, text: await page.locator("body").innerText() };
  } finally {
    await layer.close();
  }
}

describe("secret store", () => {
  it("parses secret references", () => {
    expect(parseSecretRef("secret:lock_test_01.password")).toBe("lock_test_01.password");
    for (const bad of ["lock_test_01.password", "secret:", "secret:a b", "data.x", "Secret:x"]) expect(parseSecretRef(bad), bad).toBeNull();
  });

  it("reads environment variables, and the error names the secret but not a value", async () => {
    expect(envVarFor("lock_test_01.password")).toBe("QA_SECRET_LOCK_TEST_01_PASSWORD");
    expect(await new EnvSecretStore({ QA_SECRET_X_Y: "value-123" }).get("x.y")).toBe("value-123");
    await expect(new EnvSecretStore({}).get("x.y")).rejects.toThrow(SecretError);
    await expect(new EnvSecretStore({}).get("x.y")).rejects.toThrow(/QA_SECRET_X_Y/);
    await expect(new StaticSecretStore({}).get("nope")).rejects.toThrow(/"nope" is not set/);
  });
});

describe("session setup", () => {
  it("parses Set-Cookie attributes", () => {
    const c = parseSetCookie("fx_session=abc; HttpOnly; Path=/app; SameSite=Strict; Secure; Max-Age=60", "127.0.0.1");
    expect(c).toMatchObject({ name: "fx_session", value: "abc", domain: "127.0.0.1", path: "/app", httpOnly: true, secure: true, sameSite: "Strict" });
    expect(c.expires).toBeGreaterThan(Date.now() / 1000);
    expect(() => parseSetCookie("garbage", "h")).toThrow(SessionError);
  });

  it("role none has no session, and /account sends the browser to the login page", async () => {
    const s = setup("none");
    const session = await establishSession(s.options);
    expect(session.storageStatePath).toBeNull();
    expect((await accountText(null)).status).toBe("/login");
  });

  it("role member starts the browser signed in, without the model doing anything", async () => {
    const s = setup("member");
    const session = await establishSession(s.options);
    try {
      expect(session.storageStatePath).not.toBeNull();
      const view = await accountText(session.storageStatePath);
      expect(view.status).toBe("/account");
      expect(view.text).toContain("Welcome, fixture_member");
    } finally {
      session.cleanup();
    }
  });

  it("keeps the session file outside the run directory, and removes it on cleanup", async () => {
    const s = setup("member");
    const session = await establishSession(s.options);
    const file = session.storageStatePath as string;
    expect(existsSync(file)).toBe(true);
    expect(relative(s.runDir, file).startsWith("..")).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("fx_session");
    session.cleanup();
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a session directory inside the run directory", async () => {
    const s = setup("member");
    s.config.sessions.directory = join(s.runDir, "sessions");
    await expect(establishSession(s.options)).rejects.toThrow(/must not be inside the run directory/);
  });

  it("gives each case its own login, so a logout in one does not end the other", async () => {
    const a = await establishSession(setup("member").options);
    const b = await establishSession(setup("member").options);
    try {
      expect(readFileSync(a.storageStatePath as string, "utf8")).not.toBe(readFileSync(b.storageStatePath as string, "utf8"));
      const layer = await ToolLayer.create({ targetOrigin: site.origin, config: loadConfig(), runDir: mkdtempSync(join(tmpdir(), "qa-bot-view-")), storageStatePath: a.storageStatePath as string, allowedMutations: ["GET /logout"] });
      await layer.call("goto", { url: "/logout" }); // a state-changing GET ends session a
      await layer.close();
      expect((await accountText(a.storageStatePath)).status).toBe("/login");
      expect((await accountText(b.storageStatePath)).status).toBe("/account");
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it("registers the password and every cookie value with the redactor", async () => {
    const s = setup("member");
    const session = await establishSession(s.options);
    try {
      const cookie = JSON.parse(readFileSync(session.storageStatePath as string, "utf8")).cookies[0].value as string;
      const scrubbed = s.redactor.scrubText(`pw=${FIXTURE_SECRETS["fixture_member.password"]} cookie=${cookie}`);
      expect(scrubbed).toBe("pw=[REDACTED:member.password] cookie=[REDACTED:member.cookie.fx_session]");
    } finally {
      session.cleanup();
    }
  });

  it("fails clearly for an unknown role, a wrong password, and a missing secret, without leaking the password", async () => {
    await expect(establishSession(setup("ghost").options)).rejects.toThrow(/unknown role "ghost"/);

    const wrong = new StaticSecretStore({ ...FIXTURE_SECRETS, "fixture_member.password": "Not-The-Password-1" });
    const err = await establishSession(setup("member", { secrets: wrong }).options).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as Error).message).toMatch(/refused with status 401/);
    expect((err as Error).message).not.toContain("Not-The-Password-1");

    const missing = new StaticSecretStore({});
    await expect(establishSession(setup("member", { secrets: missing }).options)).rejects.toThrow(/unavailable/);
  });
});

describe("sessions in a full run", () => {
  it("a session failure is INCONCLUSIVE, with no credential in the record", async () => {
    const testCase = { ...loadCase("cases/TC-FORM-001.yaml"), role: "member" };
    const model = "tests/ci/scripts/TC-FORM-001.json";
    const { ScriptedModelClient } = await import("../../src/model/scripted.ts");
    const { runCase } = await import("../../src/runner/run-case.ts");
    const { record, runDir } = await runCase({
      testCase,
      caseSource: "test",
      targetOrigin: site.origin,
      model: ScriptedModelClient.fromFile(model),
      config: testConfig(),
      secrets: new StaticSecretStore({ ...FIXTURE_SECRETS, "fixture_member.password": "Wrong-Password-77" }),
    });
    expect(record.verdict).toBe("INCONCLUSIVE");
    expect(record.run_state.infrastructure_failure).toMatch(/session setup failed/);
    expect(record.versions.browser).toBe("not started");
    for (const f of readdirSync(runDir)) expect(readFileSync(join(runDir, f), "utf8")).not.toContain("Wrong-Password-77");
  });

  it("runs a case as role member with no login steps", async () => {
    const testCase = loadCase("cases/TC-FORM-001.yaml");
    testCase.role = "member";
    const { record } = await runScripted({ site, testCase, script: "tests/ci/scripts/TC-FORM-001.json", secrets: store });
    expect(record.verdict).toBe("PASS");
  });
});
