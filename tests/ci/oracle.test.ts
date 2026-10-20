// T5: no PASS without evidence.
// T6: a wrong expected result fails.
// T22 (timing part): a result that appears only transiently after its step is caught, and the
// evidence comes from the runner, not from the actor.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase, validateCase } from "../../src/cases/load.ts";
import { negativeControl } from "../../src/cases/mutate.ts";
import { evaluateExpected } from "../../src/oracle/assertions.ts";
import type { EvidenceSink } from "../../src/oracle/evidence.ts";
import { ToolLayer } from "../../src/tools/tool-layer.ts";
import { calculateVerdict } from "../../src/verdict/calculate.ts";
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

describe("T5 no PASS without evidence", () => {
  it("gives NO_EVIDENCE when the runner captured no evidence, and the run is INCONCLUSIVE", async () => {
    const config = testConfig();
    const layer = await ToolLayer.create({ targetOrigin: site.origin, config, runDir: mkdtempSync(join(tmpdir(), "qa-bot-t5-")) });
    try {
      await layer.call("goto", { url: "/form" });
      const emptySink: EvidenceSink = { capture: async () => [], all: () => [] };
      const testCase = loadCase("cases/TC-FORM-001.yaml");
      const e2 = testCase.expected[1]!; // url equals /form: true on this page
      const outcome = await evaluateExpected(e2, { access: layer.runnerAccess(), config, evidence: emptySink });
      expect(outcome.outcome).toBe("NO_EVIDENCE");
      expect(outcome.evidence).toEqual([]);
      const verdict = calculateVerdict({
        expectedCount: 1,
        outcomes: [{ expected_ref: outcome.expected_ref, outcome: outcome.outcome }],
        runState: { infrastructureFailure: null, guardrailBlock: false, actorStopReason: null, runnerStopReason: null },
      });
      expect(verdict.verdict).toBe("INCONCLUSIVE");
    } finally {
      await layer.close();
    }
  });

  it("gives NO_EVIDENCE for a judged result until the judge exists", async () => {
    const testCase = validateCase({
      id: "TC-TEST-002",
      title: "A judged case",
      priority: "P3",
      steps: ["open /form"],
      expected: [{ id: "j1", after_step: 1, kind: "judged", description: "The page looks like a signup form" }],
    });
    const { record } = await runScripted({
      site,
      testCase,
      script: { case_id: "TC-TEST-002", steps: [[{ tool: "goto", args: { url: "/form" } }]], observations: [], injection_suspected: false, notes: "" },
    });
    expect(record.outcomes[0]?.outcome).toBe("NO_EVIDENCE");
    expect(record.verdict).toBe("INCONCLUSIVE");
  });

  it("ignores evidence that the actor claims: only runner-captured evidence counts", async () => {
    const testCase = loadCase("cases/TC-FORM-001.yaml");
    const { record, runDir } = await runScripted({
      site,
      testCase,
      script: {
        case_id: "TC-FORM-001",
        steps: [
          [{ tool: "goto", args: { url: "/form" } }],
          [{ tool: "fill", args: { target: { role: "textbox", name: "Email" }, value: "not-an-email" } }],
          [{ tool: "click", args: { target: { role: "button", name: "Subscribe" } } }],
        ],
        observations: [{ expected_ref: "e1", observed: "Enter a valid email", evidence: ["claimed-by-actor-ev-999"] }],
        injection_suspected: false,
        notes: "",
      },
    });
    expect(record.verdict).toBe("PASS");
    const ids = new Set(record.evidence.map((e) => e.id));
    for (const outcome of record.outcomes) {
      expect(outcome.evidence.length).toBeGreaterThan(0);
      for (const id of outcome.evidence) {
        expect(ids.has(id)).toBe(true);
        expect(id).not.toBe("claimed-by-actor-ev-999");
      }
    }
    for (const ref of record.evidence) expect(existsSync(join(runDir, ref.path)), ref.path).toBe(true);
  });
});

describe("T6 a wrong expected result fails", () => {
  const script = "tests/ci/scripts/TC-FORM-001.json";

  it("passes the real case (control)", async () => {
    const { record } = await runScripted({ site, testCase: loadCase("cases/TC-FORM-001.yaml"), script });
    expect(record.outcomes.map((o) => o.outcome)).toEqual(["MATCH", "MATCH", "MATCH"]);
    expect(record.verdict).toBe("PASS");
  });

  it("gives MISMATCH and FAIL when one expected value is wrong, for every kind that can be mutated", async () => {
    const original = loadCase("cases/TC-FORM-001.yaml");
    for (const e of original.expected) {
      const { testCase, mutatedId } = negativeControl(original, e.id);
      const { record } = await runScripted({ site, testCase, script });
      expect(mutatedId).toBe(e.id);
      expect(record.outcomes.find((o) => o.expected_ref === e.id)?.outcome, `${e.id} (${e.kind})`).toBe("MISMATCH");
      expect(record.verdict, `${e.id} (${e.kind})`).toBe("FAIL");
      expect(record.verdict_row).toBe(3);
    }
  });

  it("fails when the application has the defect the case targets", async () => {
    site.setDefects(["email-check-missing"]);
    const { record } = await runScripted({ site, testCase: loadCase("cases/TC-FORM-001.yaml"), script });
    expect(record.verdict).toBe("FAIL");
    site.setDefects(["wrong-email-message"]);
    const second = await runScripted({ site, testCase: loadCase("cases/TC-FORM-001.yaml"), script });
    expect(second.record.verdict).toBe("FAIL");
    expect(second.record.outcomes.find((o) => o.expected_ref === "e1")?.actual).toContain("Enter valid email");
  });
});

describe("text_visible: contains, or exact", () => {
  const script = "tests/ci/scripts/TC-FORM-001.json";
  const withExact = (exact: boolean) => {
    const testCase = loadCase("cases/TC-FORM-001.yaml");
    const e1 = testCase.expected[0]!;
    if (e1.kind !== "text_visible") throw new Error("test setup");
    testCase.expected[0] = exact ? { ...e1, exact: true } : (({ exact: _x, ...rest }) => rest)(e1) as typeof e1;
    return testCase;
  };

  it("contains (the default) misses a message with something added; exact catches it", async () => {
    site.setDefects(["message=email-invalid:add-period"]);
    const loose = await runScripted({ site, testCase: withExact(false), script });
    expect(loose.record.outcomes.find((o) => o.expected_ref === "e1")?.outcome).toBe("MATCH"); // "Enter a valid email." contains the text
    const strict = await runScripted({ site, testCase: withExact(true), script });
    expect(strict.record.outcomes.find((o) => o.expected_ref === "e1")?.outcome).toBe("MISMATCH");
    expect(strict.record.verdict).toBe("FAIL");
    expect(strict.record.outcomes.find((o) => o.expected_ref === "e1")?.expected).toContain('shows exactly "Enter a valid email"');
  });

  it("exact passes the correct message, and ignores white space a browser would collapse", async () => {
    expect((await runScripted({ site, testCase: withExact(true), script })).record.verdict).toBe("PASS");
    site.setDefects(["message=email-invalid:double-space"]);
    expect((await runScripted({ site, testCase: withExact(true), script })).record.verdict).toBe("PASS");
  });
});

describe("T22 expected results are timed and evidence is the runner's", () => {
  const transientCase = () =>
    validateCase({
      id: "TC-TEST-003",
      title: "A toast appears after Save and disappears again",
      priority: "P2",
      steps: ["open /transient", "click the Save button"],
      expected: [
        { id: "t1", after_step: 2, kind: "text_visible", where: { role: "status" }, text: "Saved", description: "The toast is shown after Save" },
        { id: "t2", after_step: 2, kind: "count", where: { selector: "[data-testid=never-there]" }, equals: 0, description: "No unrelated element exists" },
      ],
    });

  const transientScript = {
    case_id: "TC-TEST-003",
    steps: [[{ tool: "goto", args: { url: "/transient" } }], [{ tool: "click", args: { target: { role: "button", name: "Save" } } }]],
    observations: [],
    injection_suspected: false,
    notes: "",
  };

  it("catches a message that appears 300 ms after the step and is gone after 2.5 s", async () => {
    const { record, runDir } = await runScripted({ site, testCase: transientCase(), script: transientScript });
    expect(record.outcomes.find((o) => o.expected_ref === "t1")?.outcome).toBe("MATCH");
    expect(record.verdict).toBe("PASS");
    // The runner's screenshot was taken while the toast was on screen, and the snapshot shows it.
    const snapshot = record.evidence.find((e) => e.id === "ev-t1-snapshot");
    expect(snapshot).toBeDefined();
  });

  it("fails when the transient message never appears", async () => {
    const wrong = transientCase();
    const first = wrong.expected[0]!;
    if (first.kind !== "text_visible") throw new Error("test setup");
    wrong.expected[0] = { ...first, text: "Saved!!" };
    const { record } = await runScripted({ site, testCase: wrong, script: transientScript });
    expect(record.outcomes.find((o) => o.expected_ref === "t1")?.outcome).toBe("MISMATCH");
    expect(record.verdict).toBe("FAIL");
  });

  it("does not let an absence check pass early: the lockout banner arrives after the response", async () => {
    // With the defect on, the 4th failed attempt locks the account. The banner count must be read
    // after the response arrives, so the case must FAIL rather than pass on an empty page.
    site.setDefects(["lockout-off-by-one"]);
    const { record } = await runScripted({ site, testCase: loadCase("cases/TC-AUTH-003.yaml"), script: "tests/ci/scripts/TC-AUTH-003.json" });
    expect(record.verdict).toBe("FAIL");
    expect(record.outcomes.find((o) => o.expected_ref === "e2")?.outcome).toBe("MISMATCH");
  });
});
