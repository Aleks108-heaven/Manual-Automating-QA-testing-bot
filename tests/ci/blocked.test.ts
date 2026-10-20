// T7: a missing element is BLOCKED. A step naming a button that does not exist gives BLOCKED, with the
// step and a screenshot. The runner captures the screenshot itself at the moment of the stop.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted, testConfig } from "./helpers/run.ts";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

const config = () =>
  testConfig((c) => {
    c.tools.actionTimeoutMs = 300;
  });
const form = () => loadCase("cases/TC-FORM-001.yaml");
const script = (steps: unknown[]) => ({ case_id: "TC-FORM-001", steps: steps as never, observations: [], injection_suspected: false, notes: "" });
const goto = { tool: "goto", args: { url: "/form" } };

describe("T7 a missing element is BLOCKED, with the step and a screenshot", () => {
  it("a button that does not exist", async () => {
    const { record, runDir } = await runScripted({
      site,
      testCase: form(),
      script: script([[goto], [{ tool: "click", args: { target: { role: "button", name: "Subscribe now" } } }, { stop: "element_missing" }]]),
      config: config(),
    });
    expect(record.verdict).toBe("BLOCKED");
    expect(record.verdict_row).toBe(4);
    expect(record.blocked).toMatchObject({ step: 2, reason: "element_missing", source: "actor", step_text: "fill the Email field with data.invalid_email" });
    expect(record.blocked?.tool_error).toMatch(/^element_missing:/);

    // The screenshot: named in the record, listed as evidence, present on disk, and not empty.
    const ids = record.blocked?.evidence ?? [];
    expect(ids).toContain("ev-blocked-step2-screenshot");
    for (const id of ids) {
      const ref = record.evidence.find((e) => e.id === id);
      expect(ref, id).toBeDefined();
      expect(existsSync(join(runDir, ref?.path ?? "missing")), id).toBe(true);
    }
    const shot = record.evidence.find((e) => e.id === "ev-blocked-step2-screenshot");
    expect(shot?.kind).toBe("screenshot");
    expect(statSync(join(runDir, shot?.path ?? "")).size).toBeGreaterThan(1000);
  });

  it("a locator that matches several elements (step_ambiguous)", async () => {
    const { record } = await runScripted({
      site,
      testCase: form(),
      script: script([[{ tool: "goto", args: { url: "/" } }], [{ tool: "click", args: { target: { role: "link" } } }, { stop: "step_ambiguous" }]]),
      config: config(),
    });
    expect(record.verdict).toBe("BLOCKED");
    expect(record.blocked).toMatchObject({ step: 2, reason: "step_ambiguous", source: "actor" });
    expect(record.blocked?.tool_error).toMatch(/^ambiguous:/);
    expect(record.blocked?.evidence).toContain("ev-blocked-step2-screenshot");
  });

  it("a stop with no failed tool call still carries the step and a screenshot", async () => {
    const { record } = await runScripted({ site, testCase: form(), script: script([[goto], [{ stop: "step_ambiguous" }]]), config: config() });
    expect(record.blocked).toMatchObject({ step: 2, reason: "step_ambiguous", tool_error: null });
    expect(record.blocked?.evidence.length).toBeGreaterThan(0);
  });

  it("a stop decided by the runner's loop detector carries the same evidence", async () => {
    const missing = { tool: "click", args: { target: { role: "button", name: "Nope" } } };
    const { record } = await runScripted({ site, testCase: form(), script: script([[goto], [missing, missing, missing]]), config: config() });
    expect(record.verdict).toBe("BLOCKED");
    expect(record.blocked).toMatchObject({ step: 2, reason: "loop", source: "runner" });
    expect(record.blocked?.evidence).toContain("ev-blocked-step2-screenshot");
  });

  it("a mismatch found before the stop still gives FAIL, and the report lists the blocked step", async () => {
    const testCase = form();
    testCase.expected = [{ id: "x1", after_step: 1, kind: "url", equals: "/not-the-form", description: "Deliberately wrong" }];
    const { record } = await runScripted({ site, testCase, script: script([[goto], [{ stop: "element_missing" }]]), config: config() });
    expect(record.verdict).toBe("FAIL");
    expect(record.blocked).toMatchObject({ step: 2, reason: "element_missing" });
  });

  it("runs that were not blocked carry no blocked section", async () => {
    const { record } = await runScripted({ site, testCase: form(), script: "tests/ci/scripts/TC-FORM-001.json" });
    expect(record.verdict).toBe("PASS");
    expect(record.blocked).toBeNull();
  });
});
