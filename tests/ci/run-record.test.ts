// The run record, schema version 1: what it says about the session, the budget, redaction and the final scan.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { loadConfig } from "../../src/config.ts";
import { RunRecordSchema } from "../../src/schemas/run-record.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
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

describe("run record v1", () => {
  it("describes a member run: session, budget, redaction, scan and artifacts", async () => {
    const config = testConfig();
    const { record, runDir } = await runScripted({ site, testCase: loadCase("cases/TC-ACCT-001.yaml"), script: "tests/ci/scripts/TC-ACCT-001.json", config, secrets: store });
    expect(record.schema_version).toBe(6);
    expect(record.frozen).toBeNull(); // driven by an actor, not by a frozen script
    expect(record.preflight).toBeNull(); // runCase was called directly, without the pre-flight check
    expect(record.verdict).toBe("PASS");
    expect(record.session).toEqual({ role: "member", mode: "per-case", established: true });
    expect(record.budget.used.tool_calls).toBe(2);
    expect(record.budget.limits).toEqual({
      max_tool_calls_per_run: config.budgets.maxToolCallsPerRun,
      max_tool_calls_per_step: config.budgets.maxToolCallsPerStep,
      max_wall_ms: config.budgets.maxWallMs,
      max_cost_usd: config.budgets.maxCostUsd,
    });
    expect(record.budget.stop).toBeNull();
    expect(record.redaction.secrets_tracked).toBeGreaterThanOrEqual(2); // the password and the session cookie
    expect(record.redaction.replacements).toBeGreaterThan(0);
    expect(record.artifact_scan).toMatchObject({ findings: 0, cleaned: false });
    expect(record.artifact_scan.files_scanned).toBeGreaterThan(3);
    expect(record.artifacts).toEqual({ har: "network.har", model_context: "model-context.jsonl" });
    // The stored file validates and says nothing about where the session file was.
    const onDisk = RunRecordSchema.parse(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")));
    expect(JSON.stringify(onDisk)).not.toContain(config.sessions.directory.replaceAll("\\", "\\\\"));
  });

  it("records the stop reason and source when the loop detector ends the run", async () => {
    const config = testConfig((c) => {
      c.tools.actionTimeoutMs = 300;
    });
    const missing = { tool: "click", args: { target: { role: "button", name: "Nope" } } };
    const { record } = await runScripted({
      site,
      testCase: loadCase("cases/TC-FORM-001.yaml"),
      script: { case_id: "TC-FORM-001", steps: [[{ tool: "goto", args: { url: "/form" } }], [missing, missing, missing]], observations: [], injection_suspected: false, notes: "" },
      config,
    });
    expect(record.run_state).toMatchObject({ actor_stop_reason: "loop", stop_source: "runner" });
    expect(record.budget.used.tool_calls).toBe(4);
  });

  it("records which budget ended the run, and the cost", async () => {
    const config = testConfig((c) => {
      c.pricing.inputPerMTok = 1000;
      c.budgets.maxCostUsd = 0.5;
    });
    const { record } = await runScripted({
      site,
      testCase: loadCase("cases/TC-FORM-001.yaml"),
      script: {
        case_id: "TC-FORM-001",
        steps: [[{ tool: "goto", args: { url: "/form" }, usage: { input_tokens: 600_000, output_tokens: 0 } }]],
        observations: [],
        injection_suspected: false,
        notes: "",
      },
      config,
    });
    expect(record.verdict).toBe("INCOMPLETE");
    expect(record.budget.stop?.reason).toBe("budget");
    expect(record.budget.used.cost_usd).toBeCloseTo(600, 3);
    expect(record.budget.used.input_tokens).toBe(600_000);
  });

  it("a role none run has no login and still carries every section", async () => {
    const { record } = await runScripted({ site, testCase: loadCase("cases/TC-FORM-001.yaml"), script: "tests/ci/scripts/TC-FORM-001.json" });
    expect(record.session).toEqual({ role: "none", mode: "per-case", established: true });
    expect(record.redaction.secrets_tracked).toBe(0);
  });

  it("the default configuration validates and keeps the limits the manual describes", () => {
    const c = loadConfig();
    expect(c.loop.failureLimit).toBe(3); // the manual: "the same action failing three times in a row"
    expect(c.budgets.maxWallMs).toBeGreaterThan(0);
    expect(c.sessions.mode).toBe("per-case");
  });
});
