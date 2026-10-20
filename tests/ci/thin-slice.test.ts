// T17: the thin slice runs end to end. One case passes on the fixture site and its negative
// control fails, using the scripted fake model. The other tests check the wiring around it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { negativeControl } from "../../src/cases/mutate.ts";
import { RunRecordSchema } from "../../src/schemas/run-record.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted, testConfig } from "./helpers/run.ts";

let site: FixtureSite;
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

describe("T17 the thin slice runs end to end", () => {
  it("TC-FORM-001 passes, and its negative control fails", async () => {
    const real = loadCase("cases/TC-FORM-001.yaml");
    const script = "tests/ci/scripts/TC-FORM-001.json";
    const pass = await runScripted({ site, testCase: real, script });
    expect(pass.record.verdict).toBe("PASS");
    expect(pass.record.verdict_row).toBe(7);

    const { testCase: wrong } = negativeControl(real);
    const fail = await runScripted({ site, testCase: wrong, script });
    expect(fail.record.verdict).toBe("FAIL");
  });

  it("TC-AUTH-003 passes on the correct application and fails with the off-by-one defect", async () => {
    const testCase = loadCase("cases/TC-AUTH-003.yaml");
    const script = "tests/ci/scripts/TC-AUTH-003.json";
    expect((await runScripted({ site, testCase, script })).record.verdict).toBe("PASS");
    site.setDefects(["lockout-off-by-one"]);
    expect((await runScripted({ site, testCase, script })).record.verdict).toBe("FAIL");
  });

  it("runs setup and teardown through the test API", async () => {
    // Seeding 3 failed attempts is what makes the 4th attempt the boundary case. After the run the
    // teardown reset the users, so the user starts clean again.
    const testCase = loadCase("cases/TC-AUTH-003.yaml");
    const script = "tests/ci/scripts/TC-AUTH-003.json";
    const first = await runScripted({ site, testCase, script });
    const second = await runScripted({ site, testCase, script });
    expect(first.record.verdict).toBe("PASS");
    expect(second.record.verdict).toBe("PASS"); // would lock at the 5th attempt if teardown had not reset the count
    expect(first.record.cleanup_errors).toEqual([]);
  });

  it("writes a valid run record, with evidence files and version stamps", async () => {
    const { record, runDir } = await runScripted({
      site,
      testCase: loadCase("cases/TC-FORM-001.yaml"),
      script: "tests/ci/scripts/TC-FORM-001.json",
    });
    const onDisk = RunRecordSchema.parse(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")));
    expect(onDisk.run_id).toBe(record.run_id);
    expect(onDisk.versions.model_client).toBe("scripted");
    expect(onDisk.versions.playwright).toMatch(/^\d+\.\d+\.\d+/);
    expect(onDisk.versions.browser).toMatch(/\d/);
    expect(onDisk.versions.build).toBe("fixture-1");
    expect(Object.keys(onDisk.versions.prompt_hashes).sort()).toEqual(["actor.v1.md", "judge.v1.md"]);
    expect(onDisk.steps).toHaveLength(3);
    expect(onDisk.steps.flatMap((s) => s.actions).every((a) => a.ok)).toBe(true);
    for (const ref of onDisk.evidence) expect(existsSync(join(runDir, ref.path))).toBe(true);
    expect(onDisk.guardrail_events.filter((e) => e.decision === "blocked")).toEqual([]);
  });

  it("is INCONCLUSIVE when the build changes mid-run", async () => {
    let calls = 0;
    const { record } = await runScripted({
      site,
      testCase: loadCase("cases/TC-FORM-001.yaml"),
      script: "tests/ci/scripts/TC-FORM-001.json",
      buildProbe: async () => ({ ok: true, build: `build-${++calls}` }),
    });
    expect(record.verdict).toBe("INCONCLUSIVE");
    expect(record.verdict_row).toBe(1);
    expect(record.run_state.infrastructure_failure).toMatch(/build changed/);
  });

  it("is INCONCLUSIVE when the health check fails at the end of the run", async () => {
    let calls = 0;
    const { record } = await runScripted({
      site,
      testCase: loadCase("cases/TC-FORM-001.yaml"),
      script: "tests/ci/scripts/TC-FORM-001.json",
      buildProbe: async () => ({ ok: ++calls === 1, build: "b" }),
    });
    expect(record.verdict).toBe("INCONCLUSIVE");
  });

  it("is INCONCLUSIVE when setup fails, and does not start the browser", async () => {
    const testCase = loadCase("cases/TC-AUTH-003.yaml");
    testCase.setup = [{ call: "POST /__test/no-such-endpoint" }];
    const { record } = await runScripted({ site, testCase, script: "tests/ci/scripts/TC-AUTH-003.json" });
    expect(record.verdict).toBe("INCONCLUSIVE");
    expect(record.versions.browser).toBe("not started");
    expect(record.run_state.infrastructure_failure).toMatch(/setup failed/);
  });

  it("is BLOCKED when the actor stops because an element is missing, and later results are not evaluated", async () => {
    const { record } = await runScripted({
      site,
      testCase: loadCase("cases/TC-FORM-001.yaml"),
      script: {
        case_id: "TC-FORM-001",
        steps: [[{ tool: "goto", args: { url: "/form" } }], [{ stop: "element_missing" }]],
        observations: [],
        injection_suspected: false,
        notes: "",
      },
    });
    expect(record.verdict).toBe("BLOCKED");
    expect(record.run_state.actor_stop_reason).toBe("element_missing");
    expect(record.outcomes).toEqual([]);
  });

  it("is INCOMPLETE when the hard tool-call cap is hit", async () => {
    const config = testConfig((c) => {
      c.budgets.maxToolCallsPerStep = 1;
    });
    const { record } = await runScripted({
      site,
      testCase: loadCase("cases/TC-AUTH-003.yaml"),
      script: {
        case_id: "TC-AUTH-003",
        steps: [[{ tool: "goto", args: { url: "/login" } }, { tool: "snapshot", args: {} }]],
        observations: [],
        injection_suspected: false,
        notes: "",
      },
      config,
    });
    expect(record.verdict).toBe("INCOMPLETE");
  });

  it("is INCONCLUSIVE, with the block logged, when the page leaves the allowlist", async () => {
    // The injection page asks the bot to leave the allowed domains. Here a trap page does it for real.
    const { record } = await runScripted({
      site,
      testCase: loadCase("cases/TC-FORM-001.yaml"),
      script: {
        case_id: "TC-FORM-001",
        steps: [
          [{ tool: "goto", args: { url: "http://localhost:9/elsewhere" } }],
          [{ tool: "snapshot", args: {} }],
          [{ tool: "snapshot", args: {} }],
        ],
        observations: [],
        injection_suspected: false,
        notes: "",
      },
    });
    expect(record.verdict).toBe("INCONCLUSIVE");
    expect(record.verdict_row).toBe(2);
    expect(record.guardrail_events.some((e) => e.decision === "blocked")).toBe(true);
  });
});
