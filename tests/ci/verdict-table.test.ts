// T18: verdict precedence. Every row of the precedence table, and the combinations of rows, give the
// specified verdict. The table in the manual is parsed, so the manual and the code cannot drift apart.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActorStopReason, Outcome, RunnerStopReason, Verdict } from "../../src/schemas/common.ts";
import { calculateVerdict, PRECEDENCE_ROWS, type VerdictInput } from "../../src/verdict/calculate.ts";

describe("T18 the precedence table in the manual and in the code", () => {
  const text = readFileSync("docs/manual/05-definitions.md", "utf8");
  const documented = [...text.matchAll(/^\|\s*(\d+)\s*\|(.+)\|\s*(PASS|FAIL|BLOCKED|INCONCLUSIVE|INCOMPLETE)\s*\|\s*$/gm)].map((m) => ({
    row: Number(m[1]),
    condition: (m[2] as string).trim(),
    verdict: m[3] as Verdict,
  }));

  it("the manual's table has seven rows in order", () => {
    expect(documented.map((d) => d.row)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("each row's verdict in the code is the verdict in the manual", () => {
    expect(PRECEDENCE_ROWS.map((r) => ({ row: r.row, verdict: r.verdict }))).toEqual(documented.map((d) => ({ row: d.row, verdict: d.verdict })));
  });

  it("the calculator returns the row it names, and that row's verdict", () => {
    const rowVerdict = new Map(PRECEDENCE_ROWS.map((r) => [r.row, r.verdict]));
    for (const input of allInputs()) {
      const result = calculateVerdict(input);
      expect(result.verdict, JSON.stringify(input)).toBe(rowVerdict.get(result.row));
    }
  });
});

// ----- the enumeration -----

type Presence = "absent" | Outcome;
const PRESENCES: Presence[] = ["absent", "MATCH", "MISMATCH", "NO_EVIDENCE"];
const ACTOR_STOPS: Array<ActorStopReason | null> = [null, "element_missing", "step_ambiguous", "loop"];
const RUNNER_STOPS: Array<RunnerStopReason | null> = [null, "budget", "timeout", "crash"];

function* allInputs(): Generator<VerdictInput> {
  for (const infra of [null, "host unreachable"]) {
    for (const guardrailBlock of [false, true]) {
      for (const actorStopReason of ACTOR_STOPS) {
        for (const runnerStopReason of RUNNER_STOPS) {
          for (const a of PRESENCES) {
            for (const b of PRESENCES) {
              const outcomes = [
                ...(a === "absent" ? [] : [{ expected_ref: "e1", outcome: a }]),
                ...(b === "absent" ? [] : [{ expected_ref: "e2", outcome: b }]),
              ];
              yield { expectedCount: 2, outcomes, runState: { infrastructureFailure: infra, guardrailBlock, actorStopReason, runnerStopReason } };
            }
          }
        }
      }
    }
  }
}

/** The table written out a second time, in the manual's own words, as ordered if-statements. */
function reference(input: VerdictInput): Verdict {
  const s = input.runState;
  const outcomes = input.outcomes.map((o) => o.outcome);
  if (s.infrastructureFailure !== null || s.runnerStopReason === "crash") return "INCONCLUSIVE"; // 1
  if (s.guardrailBlock) return "INCONCLUSIVE"; // 2
  if (outcomes.includes("MISMATCH")) return "FAIL"; // 3
  if (s.actorStopReason !== null) return "BLOCKED"; // 4
  if (s.runnerStopReason === "budget" || s.runnerStopReason === "timeout") return "INCOMPLETE"; // 5
  if (outcomes.includes("NO_EVIDENCE") || outcomes.length < input.expectedCount) return "INCONCLUSIVE"; // 6
  return "PASS"; // 7
}

describe("T18 every combination", () => {
  const inputs = [...allInputs()];

  it("covers about a thousand combinations", () => {
    expect(inputs.length).toBe(2 * 2 * 4 * 4 * 16);
  });

  it("agrees with the table written out independently, for every combination", () => {
    const wrong = inputs.filter((i) => calculateVerdict(i).verdict !== reference(i));
    expect(wrong).toEqual([]);
  });

  it("gives PASS only when nothing at all went wrong (a PASS is never an accident)", () => {
    for (const i of inputs) {
      if (calculateVerdict(i).verdict !== "PASS") continue;
      expect(i.runState).toEqual({ infrastructureFailure: null, guardrailBlock: false, actorStopReason: null, runnerStopReason: null });
      expect(i.outcomes.map((o) => o.outcome)).toEqual(["MATCH", "MATCH"]);
    }
  });

  it("adding any problem to a PASS never leaves it a PASS", () => {
    const base: VerdictInput = { expectedCount: 2, outcomes: [{ expected_ref: "e1", outcome: "MATCH" }, { expected_ref: "e2", outcome: "MATCH" }], runState: { infrastructureFailure: null, guardrailBlock: false, actorStopReason: null, runnerStopReason: null } };
    expect(calculateVerdict(base).verdict).toBe("PASS");
    const problems: VerdictInput[] = [
      { ...base, runState: { ...base.runState, infrastructureFailure: "x" } },
      { ...base, runState: { ...base.runState, guardrailBlock: true } },
      { ...base, runState: { ...base.runState, actorStopReason: "loop" } },
      { ...base, runState: { ...base.runState, runnerStopReason: "budget" } },
      { ...base, runState: { ...base.runState, runnerStopReason: "timeout" } },
      { ...base, runState: { ...base.runState, runnerStopReason: "crash" } },
      { ...base, outcomes: [base.outcomes[0] as VerdictInput["outcomes"][number]] },
      { ...base, outcomes: [{ expected_ref: "e1", outcome: "MATCH" }, { expected_ref: "e2", outcome: "NO_EVIDENCE" }] },
      { ...base, outcomes: [{ expected_ref: "e1", outcome: "MATCH" }, { expected_ref: "e2", outcome: "MISMATCH" }] },
    ];
    for (const p of problems) expect(calculateVerdict(p).verdict, JSON.stringify(p)).not.toBe("PASS");
  });

  it("only a PASS counts as verified: every other verdict has a reason a person must look at", () => {
    const verdicts = new Set(inputs.map((i) => calculateVerdict(i).verdict));
    expect([...verdicts].sort()).toEqual(["BLOCKED", "FAIL", "INCOMPLETE", "INCONCLUSIVE", "PASS"]);
  });
});

describe("T18 the named combinations", () => {
  const clean = { infrastructureFailure: null, guardrailBlock: false, actorStopReason: null, runnerStopReason: null } as const;
  const mismatch = [{ expected_ref: "e1", outcome: "MISMATCH" as const }];
  const verdict = (outcomes: VerdictInput["outcomes"], runState: Partial<VerdictInput["runState"]>, expectedCount = 1) =>
    calculateVerdict({ expectedCount, outcomes, runState: { ...clean, ...runState } }).verdict;

  it("a MISMATCH followed by a blocked step is FAIL", () => {
    expect(verdict(mismatch, { actorStopReason: "element_missing" })).toBe("FAIL");
  });

  it("an environment failure together with a MISMATCH is INCONCLUSIVE", () => {
    expect(verdict(mismatch, { infrastructureFailure: "the health check was failing at the end of the run" })).toBe("INCONCLUSIVE");
  });

  it("an application 500 with a failing assertion is FAIL (a response from the application is not an infrastructure failure)", () => {
    // The runner records no infrastructure failure for an HTTP 500, so the MISMATCH decides.
    expect(verdict(mismatch, {})).toBe("FAIL");
  });

  it("a guardrail block is INCONCLUSIVE, even when everything else matched", () => {
    expect(verdict([{ expected_ref: "e1", outcome: "MATCH" }], { guardrailBlock: true })).toBe("INCONCLUSIVE");
  });

  it("a budget stop is INCOMPLETE, and never PASS even with all evaluated results matching", () => {
    expect(verdict([{ expected_ref: "e1", outcome: "MATCH" }], { runnerStopReason: "budget" }, 2)).toBe("INCOMPLETE");
  });

  it("a crash is INCONCLUSIVE (the runner crashed, so the evidence is unreliable), not INCOMPLETE", () => {
    expect(verdict([], { runnerStopReason: "crash" })).toBe("INCONCLUSIVE");
  });

  it("a loop stop is BLOCKED, and a MISMATCH found earlier still wins", () => {
    expect(verdict([], { actorStopReason: "loop" })).toBe("BLOCKED");
    expect(verdict(mismatch, { actorStopReason: "loop" })).toBe("FAIL");
  });
});
