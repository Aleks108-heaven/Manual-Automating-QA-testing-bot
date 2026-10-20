// T4: loops stop. The same action failing three times in a row gives BLOCKED. The runner decides this
// itself (so the model has nothing to report), and later results are not evaluated.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { ScriptedModelClient } from "../../src/model/scripted.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { RecordingModel, runScripted, testConfig } from "./helpers/run.ts";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

const config = () =>
  testConfig((c) => {
    c.tools.actionTimeoutMs = 300; // a missing element fails after 300 ms, so the loop tests stay quick
  });

const missing = { tool: "click", args: { target: { role: "button", name: "No such button" } } };
const other = { tool: "click", args: { target: { role: "button", name: "Another missing button" } } };
const goto = { tool: "goto", args: { url: "/form" } };
const snapshot = { tool: "snapshot", args: {} };
const scriptOf = (steps: unknown[]) => ({ case_id: "TC-FORM-001", steps: steps as never, observations: [], injection_suspected: false, notes: "" });
const form = () => loadCase("cases/TC-FORM-001.yaml");

describe("T4 loops stop", () => {
  it("the same action failing 3 times in a row gives BLOCKED, and the model is not asked to report", async () => {
    const model = new RecordingModel(new ScriptedModelClient(scriptOf([[goto], [missing, missing, missing, missing, missing]])));
    const { record } = await runScripted({ site, testCase: form(), script: "", model, config: config() });
    expect(record.verdict).toBe("BLOCKED");
    expect(record.verdict_row).toBe(4);
    expect(record.run_state.actor_stop_reason).toBe("loop");
    expect(record.steps[1]?.actions).toHaveLength(3); // the 4th and 5th attempts never happened
    expect(model.seen.some((s) => s.includes('"actorStop"'))).toBe(false); // finalOutput was never requested
    expect(record.outcomes).toEqual([]); // the expected results come after the stop
  });

  it("two failures and then a success do not count as a loop", async () => {
    const { record } = await runScripted({
      site,
      testCase: form(),
      script: scriptOf([[goto], [missing, missing, snapshot, missing, missing, snapshot]]),
      config: config(),
    });
    expect(record.run_state.actor_stop_reason).toBeNull();
    expect(record.steps[1]?.actions).toHaveLength(6);
  });

  it("different failing actions in a row do not count as a loop", async () => {
    const { record } = await runScripted({ site, testCase: form(), script: scriptOf([[goto], [missing, other, missing, other]]), config: config() });
    expect(record.run_state.actor_stop_reason).toBeNull();
    expect(record.steps[1]?.actions).toHaveLength(4);
  });

  it("the same action with different arguments is a different action", async () => {
    const a = { tool: "click", args: { target: { role: "button", name: "A" } } };
    const b = { tool: "click", args: { target: { role: "button", name: "B" } } };
    const c = { tool: "click", args: { target: { role: "button", name: "C" } } };
    const { record } = await runScripted({ site, testCase: form(), script: scriptOf([[goto], [a, b, c]]), config: config() });
    expect(record.run_state.actor_stop_reason).toBeNull();
  });

  it("argument order does not hide a repeat", async () => {
    const first = { tool: "fill", args: { value: "x", target: { name: "Nothing", role: "textbox" } } };
    const second = { tool: "fill", args: { target: { role: "textbox", name: "Nothing" }, value: "x" } };
    const { record } = await runScripted({ site, testCase: form(), script: scriptOf([[goto], [first, second, first]]), config: config() });
    expect(record.run_state.actor_stop_reason).toBe("loop");
  });

  it("the same successful action repeated without end also stops the run", async () => {
    const tight = testConfig((c) => {
      c.loop.repeatLimit = 4;
    });
    const { record } = await runScripted({ site, testCase: form(), script: scriptOf([[goto, snapshot, snapshot, snapshot, snapshot, snapshot]]), config: tight });
    expect(record.verdict).toBe("BLOCKED");
    expect(record.run_state.actor_stop_reason).toBe("loop");
    expect(record.steps[0]?.actions).toHaveLength(5); // goto, then 4 identical snapshots
  });

  it("a mismatch found before the loop still gives FAIL", async () => {
    // Step 1 ends with a wrong expectation checked at that step, then step 2 loops.
    const testCase = form();
    testCase.expected = [{ id: "x1", after_step: 1, kind: "url", equals: "/not-the-form", description: "Deliberately wrong" }];
    const { record } = await runScripted({ site, testCase, script: scriptOf([[goto], [missing, missing, missing]]), config: config() });
    expect(record.verdict).toBe("FAIL");
    expect(record.run_state.actor_stop_reason).toBe("loop");
  });

  it("the limits are configuration", async () => {
    const strict = testConfig((c) => {
      c.tools.actionTimeoutMs = 300;
      c.loop.failureLimit = 2;
    });
    const { record } = await runScripted({ site, testCase: form(), script: scriptOf([[goto], [missing, missing, missing]]), config: strict });
    expect(record.steps[1]?.actions).toHaveLength(2);
  });
});
