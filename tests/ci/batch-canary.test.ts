// The canary pair (the known-good case must PASS, its negative control must FAIL) runs once for a batch, before the first case. The
// later cases reuse the result. Every other pre-flight check still runs for each case. With a model on a laptop each canary pair costs
// minutes, so a batch of ten cases used to spend most of its time on ten identical canary pairs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBatch } from "../../src/batch.ts";
import { loadCase } from "../../src/cases/load.ts";
import { KillSwitch } from "../../src/ops/kill-switch.ts";
import { ScriptedModelClient } from "../../src/model/scripted.ts";
import { ScriptedProviderStatus } from "../../src/preflight/provider.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
import type { TestCase } from "../../src/schemas/case.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { testConfig } from "./helpers/run.ts";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

/** A batch of the given case files with the default canary (cases/TC-FORM-001.yaml). Counts the models made for each case id. */
async function batch(files: string[], change: (c: ReturnType<typeof testConfig>) => void = () => undefined, provider = new ScriptedProviderStatus()) {
  const config = testConfig(change);
  const made: Record<string, number> = {};
  const modelFor = (c: TestCase) => {
    made[c.id] = (made[c.id] ?? 0) + 1;
    return ScriptedModelClient.fromFile(`tests/ci/scripts/${c.id}.json`);
  };
  const entries = files.map((source) => ({ source, testCase: loadCase(source), modelFor }));
  const result = await runBatch({
    order: files,
    entries,
    targetOrigin: site.origin,
    config,
    secrets: new StaticSecretStore(FIXTURE_SECRETS),
    provider,
    killSwitchFor: () => new KillSwitch({ config, targetOrigin: site.origin }),
  });
  return { result, made, config };
}

describe("the canary pair in a batch", () => {
  it("runs once for the batch, and later cases reuse the result", async () => {
    const { result, made } = await batch(["cases/TC-FORM-002.yaml", "cases/TC-FORM-003.yaml", "cases/TC-FORM-004.yaml"]);
    expect(result.report.summary.verified).toBe(3);
    // TC-FORM-001 is the canary and is not part of this batch: two runs (the case and its negative control), once, not three times.
    expect(made["TC-FORM-001"]).toBe(2);
    // Each case ran once.
    expect([made["TC-FORM-002"], made["TC-FORM-003"], made["TC-FORM-004"]]).toEqual([1, 1, 1]);
  });

  it("is run for a single case too, once", async () => {
    const { made } = await batch(["cases/TC-FORM-002.yaml"]);
    expect(made["TC-FORM-001"]).toBe(2);
  });

  it("says in the pre-flight report that a result was reused, for the later cases only", async () => {
    const { config } = await batch(["cases/TC-FORM-002.yaml", "cases/TC-FORM-003.yaml"]);
    // The pre-flight report of the last case is the one left on disk.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const report = JSON.parse(readFileSync(join(config.runs.directory, "preflight-latest.json"), "utf8")) as { checks: Array<{ name: string; status: string; detail: string }> };
    const canary = report.checks.find((c) => c.name === "canary cases behave")!;
    expect(canary.status).toBe("passed");
    expect(canary.detail).toContain("TC-FORM-001: PASS; negative control: FAIL");
    expect(canary.detail).toContain("ran earlier in this batch, so its result is reused");
  });

  it("still runs every other check for each case: a provider that stops answering after the first case stops the batch", async () => {
    let calls = 0;
    const provider = new ScriptedProviderStatus();
    provider.ping = async () => {
      calls += 1;
      if (calls > 1) throw new Error("the provider did not answer");
    };
    const { result, made } = await batch(["cases/TC-FORM-002.yaml", "cases/TC-FORM-003.yaml"], undefined, provider);
    expect(calls).toBe(2); // the provider was asked for each case, canary reuse or not
    expect(result.report.summary.executed).toBe(1);
    expect(result.report.summary.not_executed).toBe(1);
    expect(made["TC-FORM-001"]).toBe(2);
  });

  it("a canary that fails stops the batch before any case runs, and nothing is reused from it", async () => {
    // The scripted model for the canary passes a wrong expected result: an idle bot that PASSes everything cannot be told apart from a good one
    // unless the negative control catches it. Here the canary case is broken on purpose: its script is for another case, so it crashes.
    const config = testConfig();
    const made: Record<string, number> = {};
    const modelFor = (c: TestCase) => {
      made[c.id] = (made[c.id] ?? 0) + 1;
      return ScriptedModelClient.fromFile(c.id === "TC-FORM-001" ? "tests/ci/scripts/TC-FORM-005.json" : `tests/ci/scripts/${c.id}.json`);
    };
    const files = ["cases/TC-FORM-002.yaml", "cases/TC-FORM-003.yaml"];
    const result = await runBatch({
      order: files,
      entries: files.map((source) => ({ source, testCase: loadCase(source), modelFor })),
      targetOrigin: site.origin,
      config,
      secrets: new StaticSecretStore(FIXTURE_SECRETS),
      provider: new ScriptedProviderStatus(),
      killSwitchFor: () => new KillSwitch({ config, targetOrigin: site.origin }),
    });
    expect(result.report.summary.executed).toBe(0);
    expect(result.report.summary.not_executed).toBe(2);
    // The first case's pre-flight ran the canary pair and failed; the second case was not started, so no second canary pair.
    expect(made["TC-FORM-001"]).toBe(2);
  });
});
