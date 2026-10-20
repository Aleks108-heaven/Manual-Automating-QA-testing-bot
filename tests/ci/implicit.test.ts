// Implicit checks: reported with the verdict, never part of it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase, validateCase } from "../../src/cases/load.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
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

const impl = () => loadCase("cases/TC-IMPL-001.yaml");
const script = "tests/ci/scripts/TC-IMPL-001.json";

describe("implicit checks", () => {
  it("find a console error, a bad response, a missing and a broken image, and accessibility defects", async () => {
    const { record } = await runScripted({ site, testCase: impl(), script });
    const { findings, counts } = record.implicit;
    // The page's own error, and the browser's message about the image that answered 404.
    const consoleDetails = findings.filter((f) => f.kind === "console_error").map((f) => f.detail);
    expect(counts.console_error).toBe(consoleDetails.length);
    expect(consoleDetails).toContain("The page script reported a problem");
    expect(consoleDetails.some((d) => d.includes("404"))).toBe(true);
    expect(findings.find((f) => f.kind === "http_error")?.detail).toBe("GET /missing.png answered 404");
    expect(counts.broken_image).toBeGreaterThanOrEqual(2); // /missing.png and /broken.png
    expect(findings.filter((f) => f.kind === "broken_image").map((f) => f.detail).join(" ")).toContain("/broken.png");
    const rules = findings.filter((f) => f.kind === "accessibility").map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["image-alt", "button-name", "label"]));
    for (const f of findings) {
      expect(f.step).toBe(1);
      expect(f.page).toBe(`${site.origin}/implicit`);
      expect(f.count).toBeGreaterThanOrEqual(1);
    }
    expect(findings.find((f) => f.rule === "button-name")?.impact).toBeTruthy();
  });

  it("never change the verdict: the run passes with findings present", async () => {
    const { record } = await runScripted({ site, testCase: impl(), script });
    expect(record.implicit.findings.length).toBeGreaterThan(3);
    expect(record.verdict).toBe("PASS");
    expect(record.verdict_row).toBe(7);
  });

  it("never become outcomes", async () => {
    const { record } = await runScripted({ site, testCase: impl(), script });
    expect(record.outcomes).toHaveLength(1);
    expect(record.outcomes.every((o) => ["MATCH", "MISMATCH", "NO_EVIDENCE"].includes(o.outcome))).toBe(true);
    expect(record.outcomes[0]?.expected_ref).toBe("e1");
  });

  it("do not rescue a failure either: a FAIL stays FAIL", async () => {
    const testCase = impl();
    const first = testCase.expected[0]!;
    if (first.kind !== "text_visible") throw new Error("test setup");
    testCase.expected[0] = { ...first, text: "A heading that is not there" };
    const { record } = await runScripted({ site, testCase, script });
    expect(record.verdict).toBe("FAIL");
    expect(record.implicit.findings.length).toBeGreaterThan(0);
  });

  it("leave out a response that the case itself expects", async () => {
    const { record } = await runScripted({ site, testCase: loadCase("cases/TC-FORM-001.yaml"), script: "tests/ci/scripts/TC-FORM-001.json" });
    expect(record.verdict).toBe("PASS");
    expect(record.implicit.findings.filter((f) => f.kind === "http_error")).toEqual([]); // the 422 is expected (e3)
  });

  it("report a response the case does not expect", async () => {
    const testCase = loadCase("cases/TC-FORM-001.yaml");
    testCase.expected = testCase.expected.filter((e) => e.kind !== "status");
    const { record } = await runScripted({ site, testCase, script: "tests/ci/scripts/TC-FORM-001.json" });
    expect(record.implicit.findings.find((f) => f.kind === "http_error")?.detail).toBe("POST /api/subscribe answered 422");
  });

  it("check each page for accessibility once, and count repeats of the same finding", async () => {
    const visitTwice = validateCase({
      id: "TC-TEST-030",
      title: "Visit the implicit page twice",
      priority: "P3",
      steps: ["open /implicit", "open /implicit again"],
      expected: [{ id: "e1", after_step: 2, kind: "text_visible", where: { role: "heading" }, text: "Implicit findings", description: "Heading" }],
    });
    const { record } = await runScripted({
      site,
      testCase: visitTwice,
      script: { case_id: "TC-TEST-030", steps: [[{ tool: "goto", args: { url: "/implicit" } }], [{ tool: "goto", args: { url: "/implicit" } }]] as never, observations: [], injection_suspected: false, notes: "" },
    });
    const a11y = record.implicit.findings.filter((f) => f.kind === "accessibility");
    expect(new Set(a11y.map((f) => f.rule)).size).toBe(a11y.length); // each rule once for the page
    const pageError = record.implicit.findings.filter((f) => f.kind === "console_error" && f.detail === "The page script reported a problem");
    expect(pageError).toHaveLength(1); // one finding, not two
    expect(pageError[0]?.count).toBe(2); // seen on both visits
    expect(pageError[0]?.step).toBe(1); // first seen at step 1
  });

  it("are capped, and say so", async () => {
    const config = testConfig((c) => {
      c.implicit.maxFindings = 3;
    });
    const { record } = await runScripted({ site, testCase: impl(), script, config });
    expect(record.implicit.findings).toHaveLength(3);
    expect(record.implicit.truncated).toBe(true);
    expect(record.verdict).toBe("PASS");
  });

  it("can be switched off, in whole or for accessibility only", async () => {
    const off = await runScripted({ site, testCase: impl(), script, config: testConfig((c) => (c.implicit.enabled = false)) });
    expect(off.record.implicit).toMatchObject({ enabled: false, findings: [], truncated: false });
    const noA11y = await runScripted({ site, testCase: impl(), script, config: testConfig((c) => (c.implicit.accessibility = false)) });
    expect(noA11y.record.implicit.counts.accessibility).toBe(0);
    expect(noA11y.record.implicit.counts.console_error).toBeGreaterThanOrEqual(1);
  });

  it("are scrubbed like everything else: a secret in a console error never reaches the record", async () => {
    const leak = validateCase({
      id: "TC-TEST-031",
      title: "Visit the console leak page as a member",
      priority: "P3",
      role: "member",
      steps: ["open /debug/console-leak"],
      expected: [{ id: "e1", after_step: 1, kind: "url", matches: "console-leak", description: "On the page" }],
    });
    const config = testConfig();
    const { record, runDir } = await runScripted({
      site,
      testCase: leak,
      script: { case_id: "TC-TEST-031", steps: [[{ tool: "goto", args: { url: "/debug/console-leak" } }]] as never, observations: [], injection_suspected: false, notes: "" },
      config,
      secrets: new StaticSecretStore(FIXTURE_SECRETS),
    });
    const entry = record.implicit.findings.find((f) => f.kind === "console_error");
    expect(entry?.detail).toContain("[REDACTED:member.password]");
    expect(readFileSync(join(runDir, "run.json"), "utf8")).not.toContain(FIXTURE_SECRETS["fixture_member.password"] as string);
    expect(record.artifact_scan.findings).toBe(0);
  });

  it("are not collected for a step that was never completed", async () => {
    const { record } = await runScripted({
      site,
      testCase: impl(),
      script: { case_id: "TC-IMPL-001", steps: [[{ stop: "step_ambiguous" }]] as never, observations: [], injection_suspected: false, notes: "" },
    });
    expect(record.verdict).toBe("BLOCKED");
    expect(record.implicit.findings).toEqual([]);
  });
});
