// The verdict calculator against the precedence table on the Definitions page.
// Exhaustive row combinations are T18 and belong to M3. These tests cover every row once and the
// most important combinations, so M1 cannot silently drift from the table.
import { describe, expect, it } from "vitest";
import { calculateVerdict, type VerdictInput } from "../../src/verdict/calculate.ts";

const clean = { infrastructureFailure: null, guardrailBlock: false, actorStopReason: null, runnerStopReason: null } as const;
const o = (outcome: "MATCH" | "MISMATCH" | "NO_EVIDENCE", ref = "e1") => ({ expected_ref: ref, outcome });
type Overrides = Omit<Partial<VerdictInput>, "runState"> & { runState?: Partial<VerdictInput["runState"]> };
const input = (overrides: Overrides = {}): VerdictInput => ({
  expectedCount: 1,
  outcomes: [o("MATCH")],
  ...overrides,
  runState: { ...clean, ...overrides.runState },
});

describe("verdict calculator", () => {
  it("row 1: infrastructure failure or a crash gives INCONCLUSIVE", () => {
    expect(calculateVerdict(input({ runState: { infrastructureFailure: "host unreachable" } }))).toEqual({ verdict: "INCONCLUSIVE", row: 1 });
    expect(calculateVerdict(input({ runState: { runnerStopReason: "crash" } }))).toEqual({ verdict: "INCONCLUSIVE", row: 1 });
  });

  it("row 2: a guardrail block gives INCONCLUSIVE", () => {
    expect(calculateVerdict(input({ runState: { guardrailBlock: true } }))).toEqual({ verdict: "INCONCLUSIVE", row: 2 });
  });

  it("row 3: any MISMATCH gives FAIL", () => {
    expect(calculateVerdict(input({ outcomes: [o("MISMATCH")] }))).toEqual({ verdict: "FAIL", row: 3 });
  });

  it("row 4: an actor stop gives BLOCKED", () => {
    for (const reason of ["element_missing", "step_ambiguous", "loop"] as const) {
      expect(calculateVerdict(input({ outcomes: [], runState: { actorStopReason: reason } }))).toEqual({ verdict: "BLOCKED", row: 4 });
    }
  });

  it("row 5: a budget or timeout stop gives INCOMPLETE", () => {
    expect(calculateVerdict(input({ outcomes: [], runState: { runnerStopReason: "budget" } }))).toEqual({ verdict: "INCOMPLETE", row: 5 });
    expect(calculateVerdict(input({ outcomes: [], runState: { runnerStopReason: "timeout" } }))).toEqual({ verdict: "INCOMPLETE", row: 5 });
  });

  it("row 6: NO_EVIDENCE, or a result never reached, gives INCONCLUSIVE", () => {
    expect(calculateVerdict(input({ outcomes: [o("NO_EVIDENCE")] }))).toEqual({ verdict: "INCONCLUSIVE", row: 6 });
    expect(calculateVerdict(input({ expectedCount: 2, outcomes: [o("MATCH")] }))).toEqual({ verdict: "INCONCLUSIVE", row: 6 });
  });

  it("row 7: every result MATCH gives PASS", () => {
    expect(calculateVerdict(input({ expectedCount: 2, outcomes: [o("MATCH", "e1"), o("MATCH", "e2")] }))).toEqual({ verdict: "PASS", row: 7 });
  });

  it("a MISMATCH followed by a blocked step is still FAIL", () => {
    expect(calculateVerdict(input({ outcomes: [o("MISMATCH")], runState: { actorStopReason: "element_missing" } })).verdict).toBe("FAIL");
  });

  it("an infrastructure failure beats a MISMATCH", () => {
    expect(calculateVerdict(input({ outcomes: [o("MISMATCH")], runState: { infrastructureFailure: "build changed" } })).verdict).toBe("INCONCLUSIVE");
  });

  it("a MISMATCH beats a budget stop", () => {
    expect(calculateVerdict(input({ outcomes: [o("MISMATCH")], runState: { runnerStopReason: "budget" } })).verdict).toBe("FAIL");
  });

  it("never gives PASS when a result is missing, even if the others matched", () => {
    expect(calculateVerdict(input({ expectedCount: 3, outcomes: [o("MATCH", "e1"), o("MATCH", "e2")] })).verdict).not.toBe("PASS");
  });

  it("refuses a case with no expected results", () => {
    expect(() => calculateVerdict(input({ expectedCount: 0, outcomes: [] }))).toThrow();
  });
});
