// T8: malformed model output is rejected. Output that violates the schema is rejected and retried within
// budget, never repaired by guessing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { ScriptedModelClient } from "../../src/model/scripted.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { RecordingModel, runScripted, testConfig } from "./helpers/run.ts";

let site: FixtureSite;
const T = { "x-fixture-test": "1", "content-type": "application/json" };
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});
beforeEach(async () => {
  await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
});

const form = () => loadCase("cases/TC-FORM-001.yaml");
const steps = [
  [{ tool: "goto", args: { url: "/form" } }],
  [{ tool: "fill", args: { target: { role: "textbox", name: "Email" }, value: "not-an-email" } }],
  [{ tool: "click", args: { target: { role: "button", name: "Subscribe" } } }],
];
const valid = { test_id: "TC-FORM-001", completed: true, stop_reason: null, stopped_at_step: null, observations: [], injection_suspected: false, notes: "" };
const withFinal = (final_outputs: unknown[], extra: Record<string, unknown> = {}) => ({
  case_id: "TC-FORM-001",
  steps: steps as never,
  observations: [],
  injection_suspected: false,
  notes: "",
  final_outputs,
  ...extra,
});

describe("T8 malformed model output is rejected", () => {
  const { injection_suspected: _i, ...missingField } = valid;
  const { completed: _c, ...missingCompleted } = valid;
  const malformed: Array<[string, unknown, RegExp]> = [
    ["a missing field", missingField, /injection_suspected/],
    ["another missing field", missingCompleted, /completed/],
    ["an extra field (a verdict)", { ...valid, verdict: "PASS" }, /verdict|Unrecognized/i],
    ["a wrong type", { ...valid, completed: "yes" }, /completed/],
    ["a stop reason the run did not have", { ...valid, completed: false, stop_reason: "loop", stopped_at_step: 1 }, /stop_reason/],
    ["a stop reason that belongs to the runner", { ...valid, completed: false, stop_reason: "budget", stopped_at_step: 1 }, /stop_reason/],
    ["the wrong test id", { ...valid, test_id: "TC-OTHER-999" }, /test_id/],
    ["an observation without its reference", { ...valid, observations: [{ observed: "x", evidence: [] }] }, /observations/],
    ["text instead of an object", "The test passed.", /report/],
    ["null", null, /report/],
  ];

  it.each(malformed)("rejects %s, asks again, and ends INCONCLUSIVE if it stays wrong", async (_name, bad, pattern) => {
    const { record } = await runScripted({ site, testCase: form(), script: withFinal([bad]) });
    expect(record.model_output.valid).toBe(false);
    expect(record.model_output.attempts).toBe(3);
    expect(record.model_output.errors).toHaveLength(3);
    expect(record.model_output.errors[0]).toMatch(pattern);
    expect(record.verdict).toBe("INCONCLUSIVE");
    expect(record.verdict_row).toBe(1);
    expect(record.run_state.infrastructure_failure).toMatch(/stayed invalid after 3 attempts/);
  });

  it("nothing is repaired: all expected results matched, and the verdict is still not PASS", async () => {
    const { record } = await runScripted({ site, testCase: form(), script: withFinal([missingField]) });
    expect(record.outcomes.map((o) => o.outcome)).toEqual(["MATCH", "MATCH", "MATCH"]);
    expect(record.verdict).not.toBe("PASS");
  });

  it("a malformed report followed by a valid one is accepted on the retry, and the model is told what was wrong", async () => {
    const model = new RecordingModel(new ScriptedModelClient(withFinal([missingField, "default"])));
    const { record } = await runScripted({ site, testCase: form(), script: "", model });
    expect(record.verdict).toBe("PASS");
    expect(record.model_output).toMatchObject({ attempts: 2, valid: true });
    expect(record.model_output.errors).toHaveLength(1);
    const asked = model.seen.filter((s) => s.includes('"attempt"')).map((s) => JSON.parse(s) as { attempt: number; previousError: string | null });
    expect(asked.map((a) => a.attempt)).toEqual([1, 2]);
    expect(asked[0]?.previousError).toBeNull();
    expect(asked[1]?.previousError).toMatch(/injection_suspected/);
  });

  it("the description of the problem names fields and rules, never values the model sent", async () => {
    const secretish = { ...valid, notes: 12345, observations: [{ expected_ref: "e1", observed: "SECRET-LOOKING-TEXT", evidence: "not-a-list" }] };
    const { record } = await runScripted({ site, testCase: form(), script: withFinal([secretish]) });
    expect(JSON.stringify(record.model_output.errors)).not.toContain("SECRET-LOOKING-TEXT");
  });

  it("the number of attempts is configuration", async () => {
    const config = testConfig((c) => {
      c.modelOutput.maxAttempts = 1;
    });
    const { record } = await runScripted({ site, testCase: form(), script: withFinal([missingField, "default"]), config });
    expect(record.model_output.attempts).toBe(1);
    expect(record.verdict).toBe("INCONCLUSIVE");
  });

  it("retries spend the cost budget: when it runs out, no more are requested and the run is INCOMPLETE", async () => {
    const config = testConfig((c) => {
      c.pricing.inputPerMTok = 1000;
      c.budgets.maxCostUsd = 1;
    });
    // Each report costs 2 USD (2,000 tokens at 1000 USD per million), so one attempt exhausts the budget.
    const { record } = await runScripted({
      site,
      testCase: form(),
      script: withFinal([missingField], { final_usage: { input_tokens: 2000, output_tokens: 0 } }),
      config,
    });
    expect(record.model_output.attempts).toBe(1);
    expect(record.verdict).toBe("INCOMPLETE");
    expect(record.run_state.runner_stop_reason).toBe("budget");
  });

  it("retries spend the time budget: a model that is too slow with its report ends the run as INCOMPLETE", async () => {
    const config = testConfig((c) => {
      c.budgets.maxWallMs = 5000;
    });
    const { record } = await runScripted({ site, testCase: form(), script: withFinal(["default"], { final_delay_ms: 30_000 }), config });
    expect(record.verdict).toBe("INCOMPLETE");
    expect(record.run_state.runner_stop_reason).toBe("timeout");
  });

  it("the cost of the final report is counted", async () => {
    const { record } = await runScripted({ site, testCase: form(), script: withFinal(["default"], { final_usage: { input_tokens: 1000, output_tokens: 500 } }) });
    expect(record.verdict).toBe("PASS");
    expect(record.budget.used.input_tokens).toBe(1000);
    expect(record.budget.used.output_tokens).toBe(500);
  });
});

describe("T8 malformed tool calls are rejected, not repaired", () => {
  const run = (actions: unknown[]) =>
    runScripted({
      site,
      testCase: form(),
      script: { case_id: "TC-FORM-001", steps: [[{ tool: "goto", args: { url: "/form" } }], actions] as never, observations: [], injection_suspected: false, notes: "" },
    });

  it("a call with a missing argument is invalid_args and does nothing", async () => {
    const { record } = await run([{ tool: "fill", args: { target: { role: "textbox", name: "Email" } } }]);
    expect(record.steps[1]?.actions[0]).toMatchObject({ tool: "fill", ok: false });
    expect(record.steps[1]?.actions[0]?.error).toMatch(/^invalid_args: .*value/);
  });

  it("a call with an extra argument is rejected, not trimmed", async () => {
    const { record } = await run([{ tool: "click", args: { target: { role: "button", name: "Subscribe" }, force: true } }]);
    expect(record.steps[1]?.actions[0]?.error).toMatch(/^invalid_args/);
    expect(record.outcomes.find((o) => o.expected_ref === "e3")?.outcome).not.toBe("MATCH"); // the click never happened
  });

  it("an unknown tool is rejected", async () => {
    const { record } = await run([{ tool: "shell", args: { cmd: "dir" } }]);
    expect(record.steps[1]?.actions[0]?.error).toMatch(/^unknown_tool/);
  });

  it("the same malformed call 3 times in a row is a loop", async () => {
    const bad = { tool: "fill", args: { target: { role: "textbox", name: "Email" } } };
    const { record } = await run([bad, bad, bad, bad]);
    expect(record.run_state).toMatchObject({ actor_stop_reason: "loop", stop_source: "runner" });
    expect(record.verdict).toBe("BLOCKED");
  });
});
