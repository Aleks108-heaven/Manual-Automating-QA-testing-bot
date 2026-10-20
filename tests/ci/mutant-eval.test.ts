// T19, the harness half: the mutant eval must report a healthy bot as healthy, and must NOT report a broken bot as
// healthy. A measuring instrument that cannot fail is worth nothing, so each way of being broken is tried here.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { evaluateMutants, formatMutantReport, type MutantEvalOptions } from "../../evals/mutants.ts";
import { ScriptedModelClient } from "../../src/model/scripted.ts";
import { KillSwitch, RunnerPausedError } from "../../src/ops/kill-switch.ts";
import type { TestCase } from "../../src/schemas/case.ts";
import { generateMutants, MUTANT_CLASSES, sampleMutants, type Mutant } from "../../fixtures/mutants.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { testConfig } from "./helpers/run.ts";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

const all = generateMutants();
const byId = (...ids: string[]): Mutant[] =>
  ids.map((id) => {
    const found = all.find((m) => m.id === id);
    if (!found) throw new Error(`no mutant ${id}`);
    return found;
  });

// One mutant for each kind of covering case, so the sample is small but not trivial.
const SMALL = [
  "lockout:lockout-threshold=3",
  "email-validation:email-validator=accepts-all",
  "message-text:message=welcome:drop-last-char",
  "status-code:apikey-ok-status=500",
  "api-key:apikey=accepts-any",
  "ui-element:logout-button=missing",
];

function options(extra: Partial<MutantEvalOptions> = {}): MutantEvalOptions {
  return { config: testConfig(), site, outDir: mkdtempSync(join(tmpdir(), "qa-bot-mutant-eval-")), baselineRuns: 1, ...extra };
}

describe("sampling", () => {
  const covered = all.filter((m) => !m.equivalent && m.coveredBy.length > 0);

  it("gives the same mutants every time, with every class in a small sample", () => {
    const a = sampleMutants(covered, 14);
    expect(a).toHaveLength(14);
    expect(sampleMutants(covered, 14).map((m) => m.id)).toEqual(a.map((m) => m.id));
    expect(new Set(a.map((m) => m.class))).toEqual(new Set(MUTANT_CLASSES));
  });

  it("returns everything when asked for more than there is, and never duplicates", () => {
    expect(sampleMutants(covered, 10_000)).toHaveLength(covered.length);
    const s = sampleMutants(covered, 60);
    expect(new Set(s.map((m) => m.id)).size).toBe(60);
  });
});

describe("a healthy bot", () => {
  it("detects every covered mutant, holds every gate, and writes a readable report", async () => {
    const opts = options({ mutants: byId(...SMALL) });
    const report = await evaluateMutants(opts);
    expect(report.mutants.map((m) => [m.id, m.status])).toEqual(SMALL.map((id) => [id, "detected"]));
    expect(report.flags).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.overall.n).toBe(6);
    expect(report.overall.detected.rate).toBe(1);
    expect(report.overall.decisive.rate).toBe(1);
    expect(report.baseline.false_fail.count).toBe(0);
    expect(report.model).toBe("scripted");
    expect(report.notes[0]).toMatch(/scripted/);
    // The file on disk is the report, and the text is for people.
    const onDisk = JSON.parse(readFileSync(join(opts.outDir, "mutant-eval-latest.json"), "utf8"));
    expect(onDisk.kind).toBe("mutant-eval");
    expect(onDisk.overall.n).toBe(6);
    expect(formatMutantReport(report)).toContain("All gates held.");
    // Passing runs need no folder, and the fixture is left clean.
    expect(existsSync(join(opts.outDir, "runs"))).toBe(true);
    await expect(fetch(site.origin + "/health").then((r) => r.status)).resolves.toBe(200);
  }, 180_000);

  it("keeps equivalent mutants and coverage gaps out of the denominator, and lists the gaps", async () => {
    const equivalent = all.find((m) => m.equivalent)!;
    const gap = all.find((m) => !m.equivalent && m.coveredBy.length === 0)!;
    const real = byId("lockout:lockout-threshold=3");
    const report = await evaluateMutants(options({ mutants: [equivalent, gap, ...real] }));
    expect(report.manifest).toMatchObject({ total: 3, equivalent: 1, coverage_gaps: 1, covered: 1, run: 1 });
    expect(report.overall.n).toBe(1);
    expect(report.coverage_gaps.map((g) => g.id)).toEqual([gap.id]);
    expect(report.misses).toEqual([]);
    expect(report.mutants.map((m) => m.id)).toEqual(real.map((m) => m.id));
  }, 120_000);

  it("shows a case that disagrees with itself as flaky", async () => {
    // A model that does the right thing the first time and nothing afterwards.
    let calls = 0;
    const real = byId("lockout:lockout-threshold=3");
    const report = await evaluateMutants(
      options({
        mutants: real,
        repeat: 2,
        modelFor: (id) => {
          calls += 1;
          const good = ScriptedModelClient.fromFile(`tests/ci/scripts/${id}.json`);
          // Calls 1 is the clean run and 2 the first mutant run. From the third on the model gives up at step 1.
          return calls <= 2 ? good : new ScriptedModelClient({ case_id: id, steps: [[{ stop: "element_missing" }]], observations: [], injection_suspected: false, notes: "" });
        },
      }),
    );
    expect(report.flaky.map((m) => m.id)).toEqual(real.map((m) => m.id));
    expect(report.flags.join(" ")).toMatch(/different verdicts/);
    expect(report.ok).toBe(false);
  }, 120_000);
});

describe("a broken bot is caught", () => {
  it("an idle bot (it stops at once) is flagged: no mutant can be judged and nothing is decisive", async () => {
    const report = await evaluateMutants(
      options({
        mutants: byId(...SMALL),
        modelFor: (id) => new ScriptedModelClient({ case_id: id, steps: [[{ stop: "step_ambiguous" }]], observations: [], injection_suspected: false, notes: "" }),
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.uncheckable).toHaveLength(6);
    expect(report.overall.n).toBe(0);
    expect(report.misses).toEqual([]); // it did not "pass" anything either
    expect(report.baseline.decisive.rate).toBe(0);
    expect(report.flags.join("\n")).toMatch(/did not PASS on the clean application/);
    expect(report.flags.join("\n")).toMatch(/decisive rate 0\.0%/);
  }, 120_000);

  it("a bot that does nothing and reports FAIL everywhere is flagged for false alarms, not credited with detections", async () => {
    const report = await evaluateMutants(
      options({
        mutants: byId(...SMALL),
        // It never acts, so nothing it should check has happened. Every expected result fails on the clean application too.
        modelFor: (id) => new ScriptedModelClient({ case_id: id, steps: [], observations: [], injection_suspected: false, notes: "" }),
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.baseline.false_fail.rate).toBeGreaterThan(0.5);
    expect(report.mutants.every((m) => m.status === "uncheckable")).toBe(true);
    expect(report.overall.detected.count).toBe(0);
    expect(report.flags.join("\n")).toMatch(/false alarms/);
  }, 120_000);

  it("cases that only look at the URL miss the mutants, and the misses are named", async () => {
    const urlOnly = (id: string): TestCase => {
      const original = loadCase(`cases/${id}.yaml`);
      return { ...original, expected: [{ id: "w1", after_step: original.steps.length, kind: "url", matches: ".*", description: "Some page is open" }] };
    };
    const report = await evaluateMutants(options({ mutants: byId(...SMALL), caseFor: urlOnly }));
    expect(report.ok).toBe(false);
    expect(report.baseline.false_fail.count).toBe(0); // the weak cases pass on a clean application, as weak cases do
    expect(report.misses.length).toBeGreaterThanOrEqual(5);
    expect(report.overall.missed.count).toBe(report.misses.length);
    expect(report.overall.detected.rate).toBeLessThan(0.5);
    expect(report.flags.join("\n")).toMatch(/wrong PASS/);
    expect(report.flags.join("\n")).toMatch(/detection .* is below the gate/);
    expect(formatMutantReport(report)).toContain("Wrong PASS");
  }, 180_000);
});

describe("the kill switch", () => {
  it("stops the eval before any run when the runner is paused", async () => {
    const paused = { isPaused: () => true, status: () => ({ paused: true, engaged_at: "now", engaged_by: "tester", reason: "test" }) };
    await expect(evaluateMutants(options({ mutants: byId(...SMALL), pause: paused as unknown as KillSwitch }))).rejects.toBeInstanceOf(RunnerPausedError);
    // The fixture is left without defects even though the eval was aborted.
    const response = await fetch(site.origin + "/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "not-an-email" }) });
    expect(response.status).toBe(422);
  }, 60_000);
});
