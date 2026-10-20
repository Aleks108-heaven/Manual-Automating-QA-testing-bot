// T13: the golden set detects drift. A set of runs with verdicts a person froze must give the same verdicts every
// time, and a verdict that moves must be reported, with a moved P1 verdict flagged. Like every measuring tool, the set
// is tested by breaking the bot on purpose and checking that the set notices.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatGoldenReport, GoldenSetError, loadGoldenSet, rehashGoldenSet, runGoldenSet, type GoldenSet } from "../../evals/golden.ts";
import { GoldenReportSchema } from "../../src/eval/golden-report.ts";
import { RunnerPausedError } from "../../src/ops/kill-switch.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { testConfig } from "./helpers/run.ts";

const REAL = "golden/golden-set.json";
let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

/** A copy of some golden entries, with the case and the scripts copied next to it, signed by the test and rehashed. */
function tempSet(ids: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "qa-bot-golden-"));
  mkdirSync(dir, { recursive: true });
  const set = JSON.parse(readFileSync(REAL, "utf8")) as GoldenSet;
  set.frozen_by = "test reviewer";
  set.entries = set.entries.filter((e) => ids.includes(e.id));
  for (const e of set.entries) {
    const caseCopy = join(dir, `${e.id}.case.yaml`);
    const scriptCopy = join(dir, `${e.id}.script.json`);
    copyFileSync(e.case, caseCopy);
    copyFileSync(e.script, scriptCopy);
    e.case = caseCopy;
    e.script = scriptCopy;
    if (e.judge_script) {
      const judgeCopy = join(dir, `${e.id}.judge.json`);
      copyFileSync(e.judge_script, judgeCopy);
      e.judge_script = judgeCopy;
    }
  }
  const file = join(dir, "golden-set.json");
  writeFileSync(file, JSON.stringify(set, null, 2));
  rehashGoldenSet(file);
  return { dir, file, set };
}

const run = (file: string, extra: Partial<Parameters<typeof runGoldenSet>[0]> = {}) =>
  runGoldenSet({ config: testConfig(), site, outDir: mkdtempSync(join(tmpdir(), "qa-bot-golden-out-")), file, ...extra });

describe("the golden set that ships", () => {
  const set = loadGoldenSet(REAL);

  it("is valid, and covers every verdict, the main guardrails, and enough P1 entries", () => {
    expect(set.entries.length).toBeGreaterThanOrEqual(20);
    expect(new Set(set.entries.map((e) => e.expect.verdict))).toEqual(new Set(["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "INCOMPLETE"]));
    expect(set.entries.filter((e) => e.priority === "P1").length).toBeGreaterThanOrEqual(8);
    expect(new Set(set.entries.map((e) => e.expect.row))).toEqual(new Set([2, 3, 4, 5, 6, 7]));
    // A person must be able to see why each verdict is right.
    for (const e of set.entries) expect(e.rationale.length, e.id).toBeGreaterThan(20);
  });

  it("has not been signed by a person, and says so: an unsigned set can never be clean", async () => {
    expect(set.frozen_by).toMatch(/^\[to fill/);
    const one = tempSet(["G01"]);
    const unsigned = JSON.parse(readFileSync(one.file, "utf8")) as GoldenSet;
    unsigned.frozen_by = "[to fill: the person who reviews and signs this set]";
    writeFileSync(one.file, JSON.stringify(unsigned));
    const report = await run(one.file);
    expect(report.entries[0]?.status).toBe("match");
    expect(report.ok).toBe(false);
    expect(report.flags.join(" ")).toMatch(/nobody has frozen/);
  }, 60_000);
});

describe("running the whole set", () => {
  let report: Awaited<ReturnType<typeof run>>;
  let outDir: string;
  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "qa-bot-golden-full-"));
    const signed = tempSet(loadGoldenSet(REAL).entries.map((e) => e.id));
    report = await run(signed.file, { outDir });
  }, 240_000);

  it("matches every frozen verdict on the shipped cases and scripts", () => {
    expect(report.entries.filter((e) => e.status !== "match").map((e) => [e.id, e.details])).toEqual([]);
    expect(report.match).toMatchObject({ count: report.entries.length, n: report.entries.length, rate: 1 });
    expect(report.changed_p1).toEqual([]);
    expect(report.flags).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.model).toBe("scripted");
    expect(report.notes[0]).toMatch(/scripted/);
  });

  it("writes a report that parses, and a readable text version", () => {
    const onDisk = GoldenReportSchema.parse(JSON.parse(readFileSync(join(outDir, "golden-latest.json"), "utf8")));
    expect(onDisk.entries.length).toBe(report.entries.length);
    const text = formatGoldenReport(report);
    expect(text).toContain("Clean: nothing moved.");
    expect(text).toContain("G01");
  });

  it("leaves the fixture without defects", async () => {
    const response = await fetch(site.origin + "/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "not-an-email" }) });
    expect(response.status).toBe(422);
  });
});

describe("drift is detected", () => {
  it("a bot that skips a step moves a P1 verdict, and the entry is named", async () => {
    const { file, dir } = tempSet(["G01", "G06"]);
    const scriptPath = join(dir, "G01.script.json");
    const script = JSON.parse(readFileSync(scriptPath, "utf8")) as { steps: unknown[] };
    script.steps = script.steps.slice(0, 2); // the click on Subscribe is dropped
    writeFileSync(scriptPath, JSON.stringify(script));
    const report = await run(file);
    expect(report.ok).toBe(false);
    expect(report.changed_p1).toEqual(["G01"]);
    expect(report.entries.find((e) => e.id === "G01")).toMatchObject({ status: "changed", actual: { verdict: "FAIL" }, inputs_changed: true });
    expect(report.entries.find((e) => e.id === "G06")?.status).toBe("match");
    expect(report.match).toMatchObject({ count: 1, n: 2 });
    expect(report.flags[0]).toMatch(/P1 verdict\(s\) changed: G01/);
    expect(formatGoldenReport(report)).toContain("CHANGED");
  }, 90_000);

  it("a case loosened to check less is noticed even though it still passes", async () => {
    const { file, dir } = tempSet(["G01"]);
    const casePath = join(dir, "G01.case.yaml");
    const text = readFileSync(casePath, "utf8");
    // The status check is removed from the case. The verdict stays PASS, but the case no longer checks what it did.
    writeFileSync(casePath, text.replace(/  - id: e3[\s\S]*$/, ""));
    const report = await run(file);
    expect(report.entries[0]).toMatchObject({ status: "changed", actual: { verdict: "PASS" }, inputs_changed: true });
    expect(report.entries[0]?.details.join(" ")).toMatch(/outcomes were e1=MATCH, e2=MATCH, e3=MATCH, now e1=MATCH, e2=MATCH/);
    expect(report.changed_p1).toEqual(["G01"]);
    expect(report.ok).toBe(false);
  }, 60_000);

  it("a bot that stops reporting FAIL for a seeded defect is noticed", async () => {
    // The defect is real but the case stops checking the message: a lenient bot passes what it should fail.
    const { file, dir } = tempSet(["G13"]);
    const casePath = join(dir, "G13.case.yaml");
    writeFileSync(casePath, readFileSync(casePath, "utf8").replace("    exact: true\n", ""));
    const report = await run(file);
    expect(report.entries[0]).toMatchObject({ status: "changed", expected: { verdict: "FAIL" }, actual: { verdict: "PASS" } });
    expect(report.changed_p1).toEqual(["G13"]);
  }, 60_000);

  it("a changed file with the same verdict is flagged as stale until a person re-freezes it", async () => {
    const { file, dir } = tempSet(["G01"]);
    const casePath = join(dir, "G01.case.yaml");
    writeFileSync(casePath, readFileSync(casePath, "utf8").replace("Reject an invalid email on the newsletter form", "Reject an invalid email"));
    const stale = await run(file);
    expect(stale.entries[0]).toMatchObject({ status: "match", inputs_changed: true });
    expect(stale.changed_p1).toEqual([]);
    expect(stale.ok).toBe(false);
    expect(stale.flags.join(" ")).toMatch(/frozen with other inputs/);
    expect(formatGoldenReport(stale)).toContain("STALE");
    // A person looks at the change and re-freezes. The expected verdicts are not touched.
    const before = (JSON.parse(readFileSync(file, "utf8")) as GoldenSet).entries.map((e) => e.expect);
    expect(rehashGoldenSet(file)).toBe(1);
    expect((JSON.parse(readFileSync(file, "utf8")) as GoldenSet).entries.map((e) => e.expect)).toEqual(before);
    const fresh = await run(file);
    expect(fresh.ok).toBe(true);
  }, 90_000);
});

describe("paused runner and bad sets", () => {
  const paused = { isPaused: () => true, status: () => ({ paused: true, engaged_at: "now", engaged_by: "tester", reason: "test" }) };

  it("a run refuses to start while the kill switch is engaged, but a run made to resume does not", async () => {
    const { file } = tempSet(["G01"]);
    await expect(run(file, { pause: paused })).rejects.toBeInstanceOf(RunnerPausedError);
    const report = await run(file, { pause: paused, purpose: "resume" });
    expect(report.purpose).toBe("resume");
    expect(report.ok).toBe(true);
  }, 90_000);

  it("rejects a set with a missing file, a duplicate id, an unknown defect, or no entries", () => {
    const { dir, set } = tempSet(["G01", "G06"]);
    const write = (change: (s: GoldenSet) => void) => {
      const copy = structuredClone(set);
      change(copy);
      const file = join(dir, `bad-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(copy));
      return file;
    };
    expect(() => loadGoldenSet(join(dir, "nope.json"))).toThrow(GoldenSetError);
    expect(() => loadGoldenSet(write((s) => void (s.entries[0]!.case = join(dir, "missing.yaml"))))).toThrow(/does not exist/);
    expect(() => loadGoldenSet(write((s) => void (s.entries[1]!.id = s.entries[0]!.id)))).toThrow(/two entries called/);
    expect(() => loadGoldenSet(write((s) => void (s.entries[0]!.defects = ["no-such-defect"])))).toThrow(/Unknown fixture defect/);
    expect(() => loadGoldenSet(write((s) => void (s.entries = [])))).toThrow(GoldenSetError);
    expect(() => loadGoldenSet(write((s) => void (s.entries[0]!.rationale = "short")))).toThrow(GoldenSetError);
  });
});
