// The configuration loader: the rules that stop a safe configuration from being weakened by an override.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";

const load = (env: NodeJS.ProcessEnv) => loadConfig("config/default.json", env);

describe("configuration rules", () => {
  it("the shipped configuration loads", () => {
    expect(load({}).preflight.requireCanaries).toBe(true);
  });

  it("a configuration that requires the container may not also drop the canaries", () => {
    expect(() => load({ QA_REQUIRE_CONTAINER: "1", QA_REQUIRE_CANARIES: "0" })).toThrow(/must also require at least one canary/);
    expect(() => load({ QA_REQUIRE_CONTAINER: "1", QA_CANARY_CASES: "" })).toThrow(/must also require at least one canary/);
  });

  it("requiring the container alone is fine, because the canaries are already required", () => {
    const c = load({ QA_REQUIRE_CONTAINER: "1" });
    expect(c.preflight.requireContainer).toBe(true);
    expect(c.preflight.canaryCases.length).toBeGreaterThan(0);
  });

  it("without the container requirement the canaries can be switched off for local work", () => {
    const c = load({ QA_CANARY_CASES: "", QA_REQUIRE_CANARIES: "0" });
    expect(c.preflight.canaryCases).toEqual([]);
  });

  it("the runs folder stands in for ${RUNS} in the kill-switch paths", () => {
    const c = load({ QA_RUNS_DIR: "somewhere" });
    expect(c.killSwitch.stateFile).toBe("somewhere/.kill-switch.json");
    expect(c.killSwitch.auditLog).toBe("somewhere/.kill-switch-audit.jsonl");
  });

  it("the state-changing GET list is configured", () => {
    expect(load({}).mutations.stateChangingGets).toContain("/logout");
  });
});
