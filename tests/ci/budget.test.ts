// T3: a budget cutoff is INCOMPLETE. A step, a time, and a cost budget each end a run as INCOMPLETE, never PASS.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BudgetGuard, DeadlineExceeded, withDeadline } from "../../src/agent/budget.ts";
import { loadCase } from "../../src/cases/load.ts";
import { loadConfig } from "../../src/config.ts";
import type { FinalContext, ModelAction, ModelClient, ModelContext } from "../../src/model/client.ts";
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
  await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
});

const form = () => loadCase("cases/TC-FORM-001.yaml");
const goto = (usage?: { input_tokens: number; output_tokens: number }, delay_ms?: number) => ({
  tool: "goto",
  args: { url: "/form" },
  ...(usage ? { usage } : {}),
  ...(delay_ms ? { delay_ms } : {}),
});
const fillAndClick = [
  [{ tool: "fill", args: { target: { role: "textbox", name: "Email" }, value: "not-an-email" } }],
  [{ tool: "click", args: { target: { role: "button", name: "Subscribe" } } }],
];
const scriptOf = (steps: unknown[]) => ({ case_id: "TC-FORM-001", steps: steps as never, observations: [], injection_suspected: false, notes: "" });

describe("T3 budget cutoffs are INCOMPLETE", () => {
  it("a tool-call budget per step", async () => {
    const config = testConfig((c) => {
      c.budgets.maxToolCallsPerStep = 2;
    });
    const { record } = await runScripted({
      site,
      testCase: form(),
      script: scriptOf([[goto(), { tool: "snapshot", args: {} }, { tool: "snapshot", args: { } , delay_ms: 0 }, { tool: "console_errors", args: {} }]]),
      config,
    });
    expect(record.verdict).toBe("INCOMPLETE");
    expect(record.verdict_row).toBe(5);
    expect(record.run_state.runner_stop_reason).toBe("budget");
    expect(record.steps[0]?.actions).toHaveLength(2);
  });

  it("a tool-call budget per run", async () => {
    const config = testConfig((c) => {
      c.budgets.maxToolCallsPerRun = 2;
    });
    const { record } = await runScripted({ site, testCase: form(), script: scriptOf([[goto()], ...fillAndClick]), config });
    expect(record.verdict).toBe("INCOMPLETE");
    expect(record.run_state.runner_stop_reason).toBe("budget");
    expect(record.steps.flatMap((s) => s.actions)).toHaveLength(2);
    expect(record.outcomes).toEqual([]); // the expected results come after the cut, so they were never checked
  });

  it("a time budget, when the model is slow", async () => {
    const config = testConfig((c) => {
      c.budgets.maxWallMs = 500;
    });
    const started = Date.now();
    const { record } = await runScripted({ site, testCase: form(), script: scriptOf([[goto(undefined, 3000)], ...fillAndClick]), config });
    expect(record.verdict).toBe("INCOMPLETE");
    expect(record.run_state.runner_stop_reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a time budget, when the model never answers", async () => {
    class HungModel implements ModelClient {
      readonly name = "hung";
      readonly modelId = "hung";
      readonly live = false;
      nextAction(_context: ModelContext): Promise<ModelAction> {
        return new Promise(() => undefined);
      }
      async finalOutput(_context: FinalContext): Promise<unknown> {
        throw new Error("not reached");
      }
    }
    const config = testConfig((c) => {
      c.budgets.maxWallMs = 400;
    });
    const { record } = await runScripted({ site, testCase: form(), script: "", model: new HungModel(), config });
    expect(record.verdict).toBe("INCOMPLETE");
    expect(record.run_state.runner_stop_reason).toBe("timeout");
  });

  it("a cost budget: the action that would exceed it is not carried out", async () => {
    const config = testConfig((c) => {
      c.pricing.inputPerMTok = 1000;
      c.budgets.maxCostUsd = 0.001;
    });
    // 10,000 input tokens at 1000 USD per million tokens is 0.01 USD, ten times the limit.
    const { record } = await runScripted({ site, testCase: form(), script: scriptOf([[goto({ input_tokens: 10_000, output_tokens: 0 })], ...fillAndClick]), config });
    expect(record.verdict).toBe("INCOMPLETE");
    expect(record.run_state.runner_stop_reason).toBe("budget");
    expect(record.steps[0]?.actions).toEqual([]);
  });

  it("never PASS: a run that would have passed is cut before its last step", async () => {
    const passing = await runScripted({ site, testCase: form(), script: "tests/ci/scripts/TC-FORM-001.json" });
    expect(passing.record.verdict).toBe("PASS"); // control: the same case passes within its budget
    const config = testConfig((c) => {
      c.budgets.maxToolCallsPerRun = 2;
    });
    const cut = await runScripted({ site, testCase: form(), script: "tests/ci/scripts/TC-FORM-001.json", config });
    expect(cut.record.verdict).toBe("INCOMPLETE");
    expect(cut.record.verdict).not.toBe("PASS");
  });
});

describe("BudgetGuard", () => {
  const limits = { ...loadConfig().budgets, maxToolCallsPerRun: 5, maxToolCallsPerStep: 3, maxWallMs: 1000, maxCostUsd: 0.5 };
  const pricing = { inputPerMTok: 3, outputPerMTok: 15 };

  it("computes cost from token usage and prices", () => {
    const g = new BudgetGuard(limits, pricing);
    g.chargeUsage({ input_tokens: 2_000_000, output_tokens: 100_000 });
    expect(g.costUsd).toBeCloseTo(2 * 3 + 0.1 * 15, 10);
    expect(g.snapshot()).toMatchObject({ input_tokens: 2_000_000, output_tokens: 100_000, cost_usd: 7.5 });
  });

  it("checks time first, then tool calls, then cost", () => {
    let now = 0;
    const g = new BudgetGuard({ ...limits, maxToolCallsPerRun: 1 }, pricing, () => now);
    g.start();
    g.chargeToolCall();
    g.chargeUsage({ input_tokens: 10_000_000, output_tokens: 0 });
    expect(g.check(0)).toMatchObject({ reason: "budget", detail: expect.stringContaining("tool calls per run") });
    now = 2000;
    expect(g.check(0)).toMatchObject({ reason: "timeout" });
  });

  it("allows a run within every limit", () => {
    const g = new BudgetGuard(limits, pricing, () => 0);
    g.start();
    g.chargeToolCall();
    expect(g.check(2)).toBeNull();
    expect(g.check(3)).toMatchObject({ reason: "budget", detail: expect.stringContaining("per step") });
  });

  it("withDeadline rejects when the promise is too slow, and passes through otherwise", async () => {
    await expect(withDeadline(new Promise(() => undefined), 50)).rejects.toBeInstanceOf(DeadlineExceeded);
    await expect(withDeadline(Promise.resolve(7), 500)).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error("boom")), 500)).rejects.toThrow("boom");
  });
});
