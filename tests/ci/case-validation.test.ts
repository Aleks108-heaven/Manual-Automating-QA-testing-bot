// T22 (validation part): a case with no expected results, a duplicate id, or an invalid
// after_step is rejected before the run. Also the actor output invariants (T8 groundwork).
import { describe, expect, it } from "vitest";
import { CaseValidationError, loadCase, parseCase, validateCase } from "../../src/cases/load.ts";
import { ActorOutputSchema } from "../../src/schemas/actor.ts";

const valid = () => ({
  id: "TC-TEST-001",
  title: "A valid case",
  priority: "P2",
  steps: ["open /form", "click the Subscribe button"],
  expected: [{ id: "e1", after_step: 2, kind: "url", equals: "/form", description: "The page did not change" }],
});

function issuesOf(raw: unknown): string[] {
  try {
    validateCase(raw);
  } catch (error) {
    if (error instanceof CaseValidationError) return error.issues.map((i) => `${i.path}: ${i.message}`);
    throw error;
  }
  return [];
}

describe("T22 case validation", () => {
  it("loads the real cases", () => {
    expect(loadCase("cases/TC-FORM-001.yaml").expected).toHaveLength(3);
    expect(loadCase("cases/TC-AUTH-003.yaml").setup).toHaveLength(1);
  });

  it("accepts a valid case and fills defaults", () => {
    const c = validateCase(valid());
    expect(c.role).toBe("none");
    expect(c.allowed_mutations).toEqual([]);
  });

  it("rejects a case with no expected results", () => {
    expect(issuesOf({ ...valid(), expected: [] }).join("\n")).toMatch(/at least one expected result/);
  });

  it("rejects a case with no steps", () => {
    expect(issuesOf({ ...valid(), steps: [] }).join("\n")).toMatch(/at least one step/);
  });

  it("rejects a duplicate expected result id", () => {
    const c = valid();
    const e = c.expected[0]!;
    expect(issuesOf({ ...c, expected: [e, { ...e }] }).join("\n")).toMatch(/duplicate expected result id "e1"/);
  });

  it("rejects an after_step that refers to a missing step", () => {
    const c = valid();
    const e = c.expected[0]!;
    expect(issuesOf({ ...c, expected: [{ ...e, after_step: 3 }] }).join("\n")).toMatch(/does not exist/);
    expect(issuesOf({ ...c, expected: [{ ...e, after_step: 0 }] })).not.toEqual([]);
  });

  it("rejects an expected result without id or after_step", () => {
    const { id: _id, ...noId } = valid().expected[0]!;
    const { after_step: _a, ...noStep } = valid().expected[0]!;
    expect(issuesOf({ ...valid(), expected: [noId] })).not.toEqual([]);
    expect(issuesOf({ ...valid(), expected: [noStep] })).not.toEqual([]);
  });

  it("rejects unknown kinds, unknown fields, and a url entry with both equals and matches", () => {
    const e = valid().expected[0]!;
    expect(issuesOf({ ...valid(), expected: [{ ...e, kind: "looks_right" }] })).not.toEqual([]);
    expect(issuesOf({ ...valid(), mystery: true })).not.toEqual([]);
    expect(issuesOf({ ...valid(), expected: [{ ...e, matches: "/f.*" }] })).not.toEqual([]);
  });

  it("reports invalid YAML as a validation error", () => {
    expect(() => parseCase("id: [unclosed", "bad.yaml")).toThrow(CaseValidationError);
  });
});

describe("actor output schema", () => {
  const base = {
    test_id: "TC-TEST-001",
    completed: true,
    stop_reason: null,
    stopped_at_step: null,
    observations: [{ expected_ref: "e1", observed: "Enter a valid email", evidence: ["ev-1"] }],
    injection_suspected: false,
    notes: "",
  };

  it("accepts a completed run and a stopped run", () => {
    expect(ActorOutputSchema.safeParse(base).success).toBe(true);
    expect(
      ActorOutputSchema.safeParse({ ...base, completed: false, stop_reason: "element_missing", stopped_at_step: 2 }).success,
    ).toBe(true);
  });

  it("rejects a verdict field, because the actor never reports one", () => {
    expect(ActorOutputSchema.safeParse({ ...base, verdict: "PASS" }).success).toBe(false);
  });

  it("rejects completed=false with no stop_reason, and a stop_reason with no step", () => {
    expect(ActorOutputSchema.safeParse({ ...base, completed: false }).success).toBe(false);
    expect(ActorOutputSchema.safeParse({ ...base, completed: false, stop_reason: "loop" }).success).toBe(false);
  });

  it("rejects stop reasons that belong to the runner", () => {
    expect(
      ActorOutputSchema.safeParse({ ...base, completed: false, stop_reason: "budget", stopped_at_step: 1 }).success,
    ).toBe(false);
  });
});
