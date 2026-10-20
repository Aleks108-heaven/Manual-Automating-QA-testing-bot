// T9: pre-flight blocks the run. Each failing condition prevents the run: provider down, quota empty, secret
// expired, session stale, image mismatch, staging unhealthy, wrong build, failing canary (and a paused runner).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import type { Config } from "../../src/config.ts";
import { runPreflight, failedChecks, writePreflightReport, type PreflightDeps } from "../../src/preflight/preflight.ts";
import { PreflightReportSchema } from "../../src/preflight/report.ts";
import { ScriptedProviderStatus } from "../../src/preflight/provider.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
import type { Verdict } from "../../src/schemas/common.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { testConfig } from "./helpers/run.ts";

let site: FixtureSite;
const T = { "x-fixture-test": "1", "content-type": "application/json" };
const DIGEST = `sha256:${"a".repeat(64)}`;
const DOCKERFILE = `FROM mcr.microsoft.com/playwright:v1.63.0-noble@${DIGEST}\nUSER pwuser\n`;

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});
beforeEach(async () => {
  await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
});

interface Setup {
  config?: (c: Config) => void;
  deps?: Partial<PreflightDeps>;
  canaryCalls?: string[];
  canary?: (isNegativeControl: boolean) => Verdict;
}

function build(setup: Setup = {}): PreflightDeps {
  const config = testConfig((c) => {
    c.preflight.requireContainer = true;
    c.preflight.runnerImageDigest = DIGEST;
    c.preflight.canaryCases = ["cases/TC-FORM-001.yaml"];
    setup.config?.(c);
  });
  const original = loadCase("cases/TC-FORM-001.yaml");
  return {
    config,
    targetOrigin: site.origin,
    provider: new ScriptedProviderStatus(),
    secrets: new StaticSecretStore(FIXTURE_SECRETS),
    probe: async () => ({ ok: true, build: "fixture-1" }),
    plannedCases: [loadCase("cases/TC-ACCT-001.yaml")], // runs as the role "member", so a real login is checked
    dockerfileText: () => DOCKERFILE,
    runCanary: async (testCase) => {
      const negative = JSON.stringify(testCase.expected) !== JSON.stringify(original.expected);
      setup.canaryCalls?.push(negative ? "negative" : "positive");
      return setup.canary ? setup.canary(negative) : negative ? "FAIL" : "PASS";
    },
    ...setup.deps,
  };
}

const byName = (report: Awaited<ReturnType<typeof runPreflight>>, name: string) => report.checks.find((c) => c.name === name);

describe("T9 all good", () => {
  it("passes every check, in a fixed order, and the report is valid", async () => {
    const report = await runPreflight(build());
    expect(report.checks.map((c) => c.name)).toEqual([
      "runner is not paused",
      "provider reachable",
      "quota left",
      "secrets valid",
      "sessions fresh",
      "runner image is the pinned one",
      "target healthy",
      "build is the expected one",
      "canary cases behave",
    ]);
    expect(report.checks.map((c) => c.status)).toEqual(Array(9).fill("passed"));
    expect(report.ok).toBe(true);
    expect(failedChecks(report)).toEqual([]);
    expect(byName(report, "canary cases behave")?.detail).toBe("TC-FORM-001: PASS; negative control: FAIL");
    expect(PreflightReportSchema.parse(report)).toEqual(report);
  });

  it("is written as a file that can be read back", async () => {
    const deps = build();
    const report = await runPreflight(deps);
    const path = join(deps.config.runs.directory, "preflight.json");
    writePreflightReport(report, path);
    expect(PreflightReportSchema.parse(JSON.parse(readFileSync(path, "utf8")))).toEqual(report);
  });
});

describe("T9 each failing condition prevents the run, by name", () => {
  const blocks = (report: Awaited<ReturnType<typeof runPreflight>>, name: string, detail: RegExp) => {
    expect(report.ok).toBe(false);
    expect(failedChecks(report).map((c) => c.name)).toContain(name);
    expect(byName(report, name)?.detail).toMatch(detail);
  };

  it("the runner is paused", async () => {
    blocks(await runPreflight(build({ deps: { pause: { isPaused: () => true } } })), "runner is not paused", /kill switch is engaged/);
  });

  it("the provider is down", async () => {
    blocks(await runPreflight(build({ deps: { provider: new ScriptedProviderStatus({ reachable: false }) } })), "provider reachable", /did not answer/);
  });

  it("the quota is empty", async () => {
    blocks(await runPreflight(build({ deps: { provider: new ScriptedProviderStatus({ quotaUsd: 0 }) } })), "quota left", /0 USD left, 1 needed/);
  });

  it("a provider that does not report a quota is skipped, which is not a pass", async () => {
    const report = await runPreflight(build({ deps: { provider: new ScriptedProviderStatus({ quotaUsd: null }) } }));
    expect(byName(report, "quota left")?.status).toBe("skipped");
    expect(failedChecks(report)).toEqual([]); // it does not stop a run
    expect(report.ok).toBe(false); // but it cannot be used to resume the kill switch
  });

  it("a secret has expired or been removed", async () => {
    const { "fixture_member.password": _gone, ...rest } = FIXTURE_SECRETS;
    blocks(await runPreflight(build({ deps: { secrets: new StaticSecretStore(rest) } })), "secrets valid", /not available: fixture_member\.password/);
  });

  it("a case declares a secret that does not exist", async () => {
    const withSecret = loadCase("cases/TC-AUTH-004.yaml");
    const store = new StaticSecretStore({ ...FIXTURE_SECRETS });
    const missing = { ...withSecret, data: { ...withSecret.data, correct_password: "secret:nobody.password" } };
    blocks(await runPreflight(build({ deps: { secrets: store, plannedCases: [missing] } })), "secrets valid", /nobody\.password/);
  });

  it("a role's session is stale: the target refuses the login", async () => {
    await fetch(site.origin + "/__test/revoke", { method: "POST", headers: T, body: "{}" });
    blocks(await runPreflight(build()), "sessions fresh", /role member: .*refused with status 403/);
  });

  it("a role's session is stale: the password no longer works, and the report does not show it", async () => {
    const report = await runPreflight(build({ deps: { secrets: new StaticSecretStore({ ...FIXTURE_SECRETS, "fixture_member.password": "Expired-Password-9" }) } }));
    blocks(report, "sessions fresh", /refused with status 401/);
    expect(JSON.stringify(report)).not.toContain("Expired-Password-9");
  });

  it("an unknown role is reported", async () => {
    const stranger = { ...loadCase("cases/TC-ACCT-001.yaml"), role: "ghost" };
    blocks(await runPreflight(build({ deps: { plannedCases: [stranger] } })), "secrets valid", /unknown role\(s\): ghost/);
  });

  it("the runner image does not match the pinned digest", async () => {
    blocks(await runPreflight(build({ config: (c) => (c.preflight.runnerImageDigest = `sha256:${"b".repeat(64)}`) })), "runner image is the pinned one", /does not match/);
  });

  it("the runner is not in the container at all", async () => {
    blocks(await runPreflight(build({ config: (c) => (c.preflight.runnerImageDigest = null) })), "runner image is the pinned one", /QA_RUNNER_IMAGE_DIGEST is not set/);
  });

  it("the Dockerfile has no digest to compare with", async () => {
    blocks(await runPreflight(build({ deps: { dockerfileText: () => "FROM node:24\n" } })), "runner image is the pinned one", /no pinned digest/);
  });

  it("when no container is required the image check is skipped, not passed", async () => {
    const report = await runPreflight(build({ config: (c) => (c.preflight.requireContainer = false) }));
    expect(byName(report, "runner image is the pinned one")?.status).toBe("skipped");
    expect(report.ok).toBe(false);
  });

  it("staging is unhealthy", async () => {
    blocks(await runPreflight(build({ deps: { probe: async () => ({ ok: false, build: null }) } })), "target healthy", /did not answer/);
  });

  it("the target reports the wrong build", async () => {
    blocks(await runPreflight(build({ deps: { probe: async () => ({ ok: true, build: "fixture-2" }) } })), "build is the expected one", /reports build fixture-2, expected fixture-1/);
  });

  it("no particular build required means the build check is skipped", async () => {
    const report = await runPreflight(build({ config: (c) => (c.preflight.expectedBuild = null) }));
    expect(byName(report, "build is the expected one")?.status).toBe("skipped");
  });
});

describe("T9 the canary pair", () => {
  const canaryBlocks = async (canary: (negative: boolean) => Verdict, detail: RegExp) => {
    const report = await runPreflight(build({ canary }));
    expect(failedChecks(report).map((c) => c.name)).toEqual(["canary cases behave"]);
    expect(byName(report, "canary cases behave")?.detail).toMatch(detail);
  };

  it("fails when the known-good case does not PASS", () => canaryBlocks((negative) => (negative ? "FAIL" : "FAIL"), /gave FAIL, expected PASS/));

  it("fails when the negative control PASSES: a bot that passes a wrong expected result is broken", () =>
    canaryBlocks(() => "PASS", /negative control of TC-FORM-001 gave PASS, expected FAIL \(the bot passes a wrong expected result\)/));

  it("fails when the negative control is merely INCONCLUSIVE", () => canaryBlocks((negative) => (negative ? "INCONCLUSIVE" : "PASS"), /gave INCONCLUSIVE, expected FAIL/));

  it("fails when no canary is configured and one is required", async () => {
    const report = await runPreflight(build({ config: (c) => (c.preflight.canaryCases = []) }));
    expect(byName(report, "canary cases behave")).toMatchObject({ status: "failed", detail: "no canary case is configured" });
  });

  it("is skipped when no canary is configured and none is required", async () => {
    const report = await runPreflight(build({ config: (c) => ((c.preflight.canaryCases = []), (c.preflight.requireCanaries = false)) }));
    expect(byName(report, "canary cases behave")?.status).toBe("skipped");
    expect(failedChecks(report)).toEqual([]);
  });

  it("fails when a canary case cannot be loaded", async () => {
    const report = await runPreflight(build({ config: (c) => (c.preflight.canaryCases = ["cases/NO-SUCH-CASE.yaml"]) }));
    expect(byName(report, "canary cases behave")?.status).toBe("failed");
  });

  it("is not run when an earlier check failed, because it would not be trustworthy", async () => {
    const calls: string[] = [];
    const report = await runPreflight(build({ canaryCalls: calls, deps: { provider: new ScriptedProviderStatus({ reachable: false }) } }));
    expect(byName(report, "canary cases behave")).toMatchObject({ status: "skipped" });
    expect(byName(report, "canary cases behave")?.detail).toMatch(/earlier check failed/);
    expect(calls).toEqual([]);
  });

  it("runs the known-good case and its negative control, once each", async () => {
    const calls: string[] = [];
    await runPreflight(build({ canaryCalls: calls }));
    expect(calls).toEqual(["positive", "negative"]);
  });
});

describe("T9 the report never shows a credential", () => {
  it("with several things wrong at once", async () => {
    await fetch(site.origin + "/__test/revoke", { method: "POST", headers: T, body: "{}" });
    const store = new StaticSecretStore({ ...FIXTURE_SECRETS, "fixture_member.password": "Stale-Password-123" });
    const report = await runPreflight(build({ deps: { secrets: store, provider: new ScriptedProviderStatus({ reachable: false }) } }));
    const text = JSON.stringify(report);
    for (const secret of [...Object.values(FIXTURE_SECRETS).filter((v) => v.length > 8), "Stale-Password-123"]) expect(text).not.toContain(secret);
    expect(report.ok).toBe(false);
  });

  it("a check that throws is reported as failed, without stopping the others", async () => {
    const report = await runPreflight(build({ deps: { probe: async () => Promise.reject(new Error("boom")) } }));
    expect(byName(report, "target healthy")).toMatchObject({ status: "failed" });
    expect(byName(report, "target healthy")?.detail).toMatch(/the check itself failed: Error: boom/);
    expect(report.checks).toHaveLength(9);
  });
});
