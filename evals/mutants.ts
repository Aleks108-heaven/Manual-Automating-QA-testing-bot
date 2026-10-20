// The mutant eval (T19). Each mutant is the fixture site with one defect switched on. The eval runs the cases that
// are meant to notice the defect, and asks whether the bot did.
//
// What it can and cannot say:
//  - A case that does not PASS on the clean application is not trusted ("unreliable"). A case that fails everything
//    detects every mutant, so its mutants are set aside as uncheckable instead of being counted as detected.
//  - A mutant that no case covers is a COVERAGE GAP, and one that changes nothing a user can see is EQUIVALENT.
//    Neither counts against the bot. Gaps are listed, because they are the case set's fault.
//  - A MISS is a covered mutant that every covering run passed. That is a wrong PASS, the failure that matters most.
//  - With a scripted model the numbers describe the machinery (assertions, verdicts, guardrails), not a model.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCase } from "../src/cases/load.ts";
import type { Config } from "../src/config.ts";
import type { JudgeClient } from "../src/judge/client.ts";
import { ScriptedJudge } from "../src/judge/scripted.ts";
import type { ModelClient } from "../src/model/client.ts";
import { ScriptedModelClient } from "../src/model/scripted.ts";
import type { PauseSource } from "../src/ops/kill-switch.ts";
import { runCase } from "../src/runner/run-case.ts";
import { StaticSecretStore, type SecretStore } from "../src/secrets/store.ts";
import type { TestCase } from "../src/schemas/case.ts";
import type { Verdict } from "../src/schemas/common.ts";
import { launchSharedBrowser, type SharedBrowser } from "../src/tools/tool-layer.ts";
import { COVERED_MUTANTS, generateMutants, MUTANT_CLASSES, sampleMutants, type Mutant } from "../fixtures/mutants.ts";
import { FIXTURE_SECRETS } from "../fixtures/secrets.ts";
import type { FixtureSite } from "../fixtures/site/server.ts";
import { percent, rate, type Rate } from "../src/eval/stats.ts";

export type MutantStatus = "detected" | "missed" | "undecided" | "uncheckable" | "coverage-gap" | "equivalent";

export interface CaseTally {
  case_id: string;
  verdicts: Verdict[];
  /** The case gave different verdicts for the same mutant. */
  flaky: boolean;
}

export interface MutantResult {
  id: string;
  class: string;
  description: string;
  status: MutantStatus;
  cases: CaseTally[];
  /** Run folders kept for a person to look at (misses, undecided, flaky). */
  kept_runs: string[];
}

export interface ClassStats {
  class: string;
  /** Covered, checkable mutants. */
  n: number;
  detected: Rate;
  missed: Rate;
  undecided: number;
  /** Share of this class's mutant runs that ended in PASS or FAIL. */
  decisive: Rate;
}

export interface BaselineCase {
  case_id: string;
  verdicts: Verdict[];
  reliable: boolean;
}

export interface MutantReport {
  schema_version: 1;
  kind: "mutant-eval";
  at: string;
  target_note: string;
  model: string;
  notes: string[];
  settings: { sample: number | null; repeat: number; baseline_runs: number; assertion_timeout_ms: number };
  gates: { min_detection_rate: number; min_decisive_rate: number; max_baseline_false_fail_rate: number };
  manifest: { total: number; equivalent: number; coverage_gaps: number; covered: number; run: number };
  baseline: { cases: BaselineCase[]; false_fail: Rate; not_pass: Rate; decisive: Rate };
  overall: ClassStats;
  classes: ClassStats[];
  /** Mutants no case covers: the case set's gap, not the bot's miss. */
  coverage_gaps: Array<{ id: string; description: string }>;
  misses: MutantResult[];
  undecided: MutantResult[];
  uncheckable: MutantResult[];
  flaky: MutantResult[];
  mutants: MutantResult[];
  /** Everything that needs a person's attention. Empty means all gates held. */
  flags: string[];
  ok: boolean;
  seconds: number;
}

export interface MutantEvalOptions {
  config: Config;
  /** A running fixture site. The eval switches its defects on and off, and leaves them off. */
  site: FixtureSite;
  /** Where the report and the kept run folders go. */
  outDir: string;
  /** The bot under test: one model per case. Defaults to the scripted model in tests/ci/scripts. */
  modelFor?: (caseId: string) => ModelClient;
  judgeFor?: (caseId: string) => JudgeClient | undefined;
  /** The cases under test. Defaults to cases/<id>.yaml. */
  caseFor?: (caseId: string) => TestCase;
  secrets?: SecretStore;
  mutants?: readonly Mutant[];
  sample?: number;
  repeat?: number;
  baselineRuns?: number;
  pause?: PauseSource;
  sharedBrowser?: SharedBrowser;
  onProgress?: (done: number, total: number, note: string) => void;
}

const DEFAULT_MODEL = (id: string): ModelClient => ScriptedModelClient.fromFile(`tests/ci/scripts/${id}.json`);
const DEFAULT_JUDGE = (id: string): JudgeClient | undefined => {
  const path = `tests/ci/judge-scripts/${id}.json`;
  return existsSync(path) ? ScriptedJudge.fromFile(path) : undefined;
};
const DEFAULT_CASE = (id: string): TestCase => loadCase(`cases/${id}.yaml`);

const isDecisive = (v: Verdict) => v === "PASS" || v === "FAIL";

export async function evaluateMutants(options: MutantEvalOptions): Promise<MutantReport> {
  const started = Date.now();
  const gates = options.config.evals.mutants;
  const repeat = options.repeat ?? gates.repeat;
  const baselineRuns = options.baselineRuns ?? gates.baselineRuns;
  const modelFor = options.modelFor ?? DEFAULT_MODEL;
  const judgeFor = options.judgeFor ?? DEFAULT_JUDGE;
  const caseFor = options.caseFor ?? DEFAULT_CASE;
  const secrets = options.secrets ?? new StaticSecretStore(FIXTURE_SECRETS);
  const manifest = [...(options.mutants ?? generateMutants())];

  const equivalent = manifest.filter((m) => m.equivalent);
  const gaps = manifest.filter((m) => !m.equivalent && m.coveredBy.length === 0);
  const covered = manifest.filter(COVERED_MUTANTS);
  const selected = options.sample === undefined ? covered : sampleMutants(covered, options.sample);

  const config = structuredClone(options.config);
  config.oracle.assertionTimeoutMs = config.evals.assertionTimeoutMs;
  config.runs.directory = join(options.outDir, "runs");
  mkdirSync(config.runs.directory, { recursive: true });

  const ownBrowser = options.sharedBrowser === undefined;
  const sharedBrowser = options.sharedBrowser ?? (await launchSharedBrowser(config, [new URL(options.site.origin).host]));
  const testHeaders = { "content-type": "application/json", ...config.testApi.headers };

  const caseIds = [...new Set(selected.flatMap((m) => m.coveredBy))].sort();
  const totalRuns = caseIds.length * baselineRuns + selected.reduce((sum, m) => sum + m.coveredBy.length * repeat, 0);
  let done = 0;
  let modelName = "unknown";
  const keep = config.evals.keepRuns === "all";

  const runOne = async (caseId: string, label: string, worthKeeping: (v: Verdict) => boolean): Promise<{ verdict: Verdict; kept: string | null }> => {
    await fetch(`${options.site.origin}/__test/reset`, { method: "POST", headers: testHeaders, body: "{}" });
    const model = modelFor(caseId);
    modelName = model.name;
    const judge = judgeFor(caseId);
    const { record, runDir } = await runCase({
      testCase: caseFor(caseId),
      caseSource: `eval:mutants:${label}`,
      targetOrigin: options.site.origin,
      model,
      config,
      secrets,
      sharedBrowser,
      ...(judge ? { judge } : {}),
      ...(options.pause ? { pause: options.pause } : {}),
    });
    done += 1;
    options.onProgress?.(done, totalRuns, `${caseId} ${label}: ${record.verdict}`);
    const kept = keep || worthKeeping(record.verdict);
    if (!kept) rmSync(runDir, { recursive: true, force: true });
    return { verdict: record.verdict, kept: kept ? runDir : null };
  };

  try {
    // 1. The clean application. A covering case that does not PASS here proves nothing about any mutant.
    options.site.setDefects([]);
    const baseline: BaselineCase[] = [];
    for (const id of caseIds) {
      const verdicts: Verdict[] = [];
      for (let i = 0; i < baselineRuns; i += 1) verdicts.push((await runOne(id, "baseline", (v) => v !== "PASS")).verdict);
      baseline.push({ case_id: id, verdicts, reliable: verdicts.every((v) => v === "PASS") });
    }
    const reliable = new Set(baseline.filter((b) => b.reliable).map((b) => b.case_id));
    const baselineVerdicts = baseline.flatMap((b) => b.verdicts);

    // 2. Each mutant against the cases that are meant to notice it.
    const results: MutantResult[] = [];
    const mutantRuns = new Map<string, Verdict[]>();
    for (const m of selected) {
      const usable = m.coveredBy.filter((id) => reliable.has(id));
      if (usable.length === 0) {
        results.push({ id: m.id, class: m.class, description: m.description, status: "uncheckable", cases: [], kept_runs: [] });
        done += m.coveredBy.length * repeat;
        continue;
      }
      done += (m.coveredBy.length - usable.length) * repeat;
      options.site.setDefects(m.defects);
      const cases: CaseTally[] = [];
      const kept: string[] = [];
      for (const id of usable) {
        const verdicts: Verdict[] = [];
        const dirs: Array<string | null> = [];
        for (let r = 0; r < repeat; r += 1) {
          const run = await runOne(id, m.id, (v) => v !== "FAIL");
          verdicts.push(run.verdict);
          dirs.push(run.kept);
        }
        cases.push({ case_id: id, verdicts, flaky: new Set(verdicts).size > 1 });
        kept.push(...dirs.filter((d): d is string => d !== null));
      }
      const all = cases.flatMap((c) => c.verdicts);
      mutantRuns.set(m.id, all);
      const status: MutantStatus = all.includes("FAIL") ? "detected" : all.every((v) => v === "PASS") ? "missed" : "undecided";
      results.push({ id: m.id, class: m.class, description: m.description, status, cases, kept_runs: kept });
    }
    options.site.setDefects([]);

    // 3. The numbers.
    const stats = (label: string, rows: MutantResult[]): ClassStats => {
      const n = rows.length;
      const runs = rows.flatMap((r) => mutantRuns.get(r.id) ?? []);
      return {
        class: label,
        n,
        detected: rate(rows.filter((r) => r.status === "detected").length, n),
        missed: rate(rows.filter((r) => r.status === "missed").length, n),
        undecided: rows.filter((r) => r.status === "undecided").length,
        decisive: rate(runs.filter(isDecisive).length, runs.length),
      };
    };
    const checked = results.filter((r) => r.status === "detected" || r.status === "missed" || r.status === "undecided");
    const overall = stats("all", checked);
    const classes = MUTANT_CLASSES.map((c) => stats(c, checked.filter((r) => r.class === c))).filter((s) => s.n > 0);

    const baselineFalseFail = rate(baselineVerdicts.filter((v) => v === "FAIL").length, baselineVerdicts.length);
    const baselineNotPass = rate(baselineVerdicts.filter((v) => v !== "PASS").length, baselineVerdicts.length);
    const baselineDecisive = rate(baselineVerdicts.filter(isDecisive).length, baselineVerdicts.length);
    const allRuns = [...baselineVerdicts, ...[...mutantRuns.values()].flat()];
    const overallDecisive = rate(allRuns.filter(isDecisive).length, allRuns.length);

    const flags: string[] = [];
    if (selected.length === 0) flags.push("no covered mutant was run, so nothing was measured");
    if (baselineFalseFail.rate !== null && baselineFalseFail.rate > gates.maxBaselineFalseFailRate) {
      flags.push(`${baselineFalseFail.count} of ${baselineFalseFail.n} clean runs reported FAIL (${percent(baselineFalseFail.rate)}, gate ${percent(gates.maxBaselineFalseFailRate)}): the bot raises false alarms`);
    }
    const unreliable = baseline.filter((b) => !b.reliable);
    if (unreliable.length > 0) flags.push(`${unreliable.length} covering case(s) did not PASS on the clean application, so their mutants could not be judged: ${unreliable.map((b) => b.case_id).join(", ")}`);
    if (overallDecisive.rate !== null && overallDecisive.rate < gates.minDecisiveRate) {
      flags.push(`decisive rate ${percent(overallDecisive.rate)} is below the gate ${percent(gates.minDecisiveRate)}: too many runs ended BLOCKED, INCONCLUSIVE or INCOMPLETE`);
    }
    if (overall.n > 0 && (overall.detected.rate ?? 0) < gates.minDetectionRate) {
      flags.push(`detection ${percent(overall.detected.rate)} (at least ${percent(overall.detected.lower95)} with 95% confidence) is below the gate ${percent(gates.minDetectionRate)}`);
    }
    for (const c of classes) {
      if ((c.detected.rate ?? 0) < gates.minDetectionRate) flags.push(`class ${c.class}: detection ${percent(c.detected.rate)} (${c.detected.count} of ${c.n}) is below the gate ${percent(gates.minDetectionRate)}`);
    }
    const misses = results.filter((r) => r.status === "missed");
    if (misses.length > 0) flags.push(`${misses.length} wrong PASS(es): ${misses.slice(0, 5).map((m) => m.id).join(", ")}${misses.length > 5 ? ", ..." : ""}`);
    const flaky = results.filter((r) => r.cases.some((c) => c.flaky));
    if (flaky.length > 0) flags.push(`${flaky.length} mutant(s) gave different verdicts on repeated runs of the same case`);

    const notes = [
      "Fixture mutants cover the fixture's defect classes only. They do not replace seeded defects in a real application (manual: Pilot).",
      "Detection means a covering case reported FAIL. A mutant whose covering runs all ended undecided is neither detected nor missed.",
    ];
    if (modelName === "scripted") {
      notes.unshift("The model was scripted: these numbers test the bot's machinery (assertions, verdicts, guardrails). They say nothing about a language model, and cannot be used for the pilot gates.");
    }

    const report: MutantReport = {
      schema_version: 1,
      kind: "mutant-eval",
      at: new Date().toISOString(),
      target_note: "local fixture site",
      model: modelName,
      notes,
      settings: { sample: options.sample ?? null, repeat, baseline_runs: baselineRuns, assertion_timeout_ms: config.oracle.assertionTimeoutMs },
      gates: { min_detection_rate: gates.minDetectionRate, min_decisive_rate: gates.minDecisiveRate, max_baseline_false_fail_rate: gates.maxBaselineFalseFailRate },
      manifest: { total: manifest.length, equivalent: equivalent.length, coverage_gaps: gaps.length, covered: covered.length, run: selected.length },
      baseline: { cases: baseline, false_fail: baselineFalseFail, not_pass: baselineNotPass, decisive: baselineDecisive },
      overall,
      classes,
      coverage_gaps: gaps.map((g) => ({ id: g.id, description: g.description })),
      misses,
      undecided: results.filter((r) => r.status === "undecided"),
      uncheckable: results.filter((r) => r.status === "uncheckable"),
      flaky,
      mutants: results,
      flags,
      ok: flags.length === 0,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    mkdirSync(options.outDir, { recursive: true });
    const stamp = report.at.replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
    writeFileSync(join(options.outDir, `mutant-eval-${stamp}.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(options.outDir, "mutant-eval-latest.json"), JSON.stringify(report, null, 2));
    return report;
  } finally {
    options.site.setDefects([]);
    if (ownBrowser) await sharedBrowser.close();
  }
}

const bounded = (r: Rate, side: "lower95" | "upper95") => `${r.count}/${r.n} = ${percent(r.rate)} (${side === "lower95" ? "at least" : "at most"} ${percent(r[side])} at 95%)`;

/** The report as text for a terminal. */
export function formatMutantReport(report: MutantReport): string {
  const out: string[] = [];
  out.push(`Mutant eval  ${report.at}  model: ${report.model}  ${report.seconds} s`);
  for (const n of report.notes) out.push(`  Note: ${n}`);
  const m = report.manifest;
  out.push(`Manifest     ${m.total} mutants: ${m.equivalent} equivalent (never counted), ${m.coverage_gaps} coverage gaps (the case set's gap, not a miss), ${m.covered} covered; ${m.run} run${report.settings.sample ? ` (sample of ${report.settings.sample})` : ""}, ${report.settings.repeat} run(s) per case`);
  const b = report.baseline;
  out.push(`Clean runs   ${b.false_fail.n} runs of ${b.cases.length} case(s): FAIL ${bounded(b.false_fail, "upper95")}; not PASS ${percent(b.not_pass.rate)}`);
  for (const c of b.cases.filter((x) => !x.reliable)) out.push(`  UNRELIABLE ${c.case_id}: ${c.verdicts.join(", ")}`);
  out.push("");
  out.push("Class".padEnd(18) + "n".padStart(5) + "  detected".padEnd(54) + "  decisive");
  for (const c of [...report.classes, report.overall]) {
    out.push(c.class.padEnd(18) + String(c.n).padStart(5) + `  ${bounded(c.detected, "lower95")}`.padEnd(54) + `  ${percent(c.decisive.rate)}`);
  }
  if (report.misses.length > 0) {
    out.push("");
    out.push(`Wrong PASS (${report.misses.length}):`);
    for (const x of report.misses) out.push(`  ${x.id}  ${x.description}  [${x.cases.map((c) => `${c.case_id}: ${c.verdicts.join("/")}`).join("; ")}]`);
  }
  if (report.undecided.length > 0) {
    out.push("");
    out.push(`Undecided (${report.undecided.length}): no covering run said FAIL or an all-PASS`);
    for (const x of report.undecided.slice(0, 10)) out.push(`  ${x.id}  [${x.cases.map((c) => `${c.case_id}: ${c.verdicts.join("/")}`).join("; ")}]`);
  }
  if (report.uncheckable.length > 0) out.push(`\nUncheckable: ${report.uncheckable.length} mutant(s) whose covering cases did not pass on the clean application.`);
  if (report.coverage_gaps.length > 0) {
    out.push("");
    out.push(`Coverage gaps (${report.coverage_gaps.length}): defects no case checks`);
    for (const g of report.coverage_gaps.slice(0, 8)) out.push(`  ${g.id}  ${g.description}`);
    if (report.coverage_gaps.length > 8) out.push(`  ... and ${report.coverage_gaps.length - 8} more`);
  }
  out.push("");
  out.push(report.ok ? "All gates held." : `FLAGGED (${report.flags.length}):`);
  for (const f of report.flags) out.push(`  - ${f}`);
  return out.join("\n");
}
