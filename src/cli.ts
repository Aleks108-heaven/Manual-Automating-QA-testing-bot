// Command-line entry point. It runs cases against the local fixture site with a scripted fake model, so no API
// key and no cost are involved.
//
//   node src/cli.ts run cases/TC-FORM-001.yaml [more cases] [--script <file>] [--defects a,b]
//                        [--negative-control] [--mutate <expected id>] [--target <url>]
//   node src/cli.ts report <run directory or run.json>... [--plan a.yaml,b.yaml]
//   node src/cli.ts preflight [--cases a.yaml,b.yaml] [--out <file>] [--target <url>]
//   node src/cli.ts kill-switch status | engage | resume
//   node src/cli.ts eval mutants [--sample N] [--repeat R]
//   node src/cli.ts eval injection [--runs N]
//   node src/cli.ts golden [--for-resume] | golden rehash
//
// Every run starts with the pre-flight check and refuses to start if the kill switch is engaged. A run ends with a
// report (src/report/). After a refusal the rest of a batch does not start, and the report lists those cases as not executed.
// Exit codes: 0 every planned case is PASS, 1 any case is FAIL, 2 anything else that is not verified (BLOCKED,
// INCONCLUSIVE, INCOMPLETE, or a case that did not run), 3 nothing ran because the run was refused (kill switch
// engaged, or a pre-flight check failed), 64 usage error, 70 unexpected error.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CaseValidationError, loadCase } from "./cases/load.ts";
import { negativeControl } from "./cases/mutate.ts";
import { loadConfig } from "./config.ts";
import { formatGoldenReport, GoldenSetError, rehashGoldenSet, runGoldenSet } from "../evals/golden.ts";
import { evaluateInjection, formatInjectionReport } from "../evals/injection.ts";
import { evaluateMutants, formatMutantReport } from "../evals/mutants.ts";
import { ScriptedJudge } from "./judge/scripted.ts";
import { ScriptedModelClient } from "./model/scripted.ts";
import { KillSwitch, KillSwitchError, RunnerPausedError } from "./ops/kill-switch.ts";
import { failedChecks } from "./preflight/preflight.ts";
import { ScriptedProviderStatus } from "./preflight/provider.ts";
import type { PreflightReport } from "./preflight/report.ts";
import { orchestrateRun, PreflightFailedError, preflightFor } from "./runner/orchestrate.ts";
import { StaticSecretStore } from "./secrets/store.ts";
import { FIXTURE_SECRETS } from "../fixtures/secrets.ts";
import type { TestCase } from "./schemas/case.ts";
import { buildReport, loadRun, ReportError, type PlanEntry } from "./report/build.ts";
import { formatReport } from "./report/format.ts";
import type { Report } from "./report/schema.ts";
import { newReportId, writeReport } from "./report/write.ts";
import { startOutsideServer } from "../fixtures/outside-server.ts";
import { assertKnownDefects, startFixtureSite, type FixtureSite } from "../fixtures/site/server.ts";

const USAGE = `Usage: node src/cli.ts run <case.yaml>... [options]
       node src/cli.ts report <run directory or run.json>... [--plan a.yaml,b.yaml]
       node src/cli.ts preflight [--cases a.yaml,b.yaml] [--out <file>] [--for-resume]
       node src/cli.ts eval mutants [--sample N] [--repeat R] [--out-dir <dir>]
       node src/cli.ts eval injection [--runs N] [--out-dir <dir>]
       node src/cli.ts golden [--file <set>] [--out-dir <dir>] [--for-resume]
       node src/cli.ts golden rehash [--file <set>]
       node src/cli.ts kill-switch status
       node src/cli.ts kill-switch engage --by <name> --reason <text>
       node src/cli.ts kill-switch resume --by <name> --review <ref> --fix <ref> --preflight-report <file> --golden-report <file>

Options:
  --script <file>        Scripted model actions (default: tests/ci/scripts/<case id>.json). One case only
  --judge-script <file>  Scripted judge answers, for cases with judged expected results. One case only
  --plan a.yaml,b.yaml   With report: the cases that were planned. A planned case with no run is reported as not executed
  --defects a,b          Turn on fixture defects, for example lockout-threshold=4 or message=email-invalid:add-period (see fixtures/defects.ts)
  --negative-control     Make one expected result wrong. The bot must report FAIL.
  --mutate <id>          With --negative-control, choose which expected result to make wrong
  --target <url>         Use an already running fixture site instead of starting one
`;

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error(USAGE);
  process.exit(64);
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

function printPreflight(report: PreflightReport): void {
  console.log(`Pre-flight  ${report.at}  target ${report.target}`);
  for (const c of report.checks) console.log(`  ${c.status.toUpperCase().padEnd(8)} ${c.name.padEnd(34)} ${c.detail}`);
  const failed = failedChecks(report).length;
  console.log(failed > 0 ? `  ${failed} check(s) failed: the run does not start.` : report.ok ? "  All checks passed." : "  No check failed. Some were skipped, so this report cannot be used to resume the kill switch.");
  console.log();
}

/** Finds the target: an already running fixture (checked) or a new one. */
async function resolveTarget(target: string | undefined, defects: string[]): Promise<{ targetOrigin: string; site: FixtureSite | null }> {
  // Until M5 passes and the security review is done, the only allowed target is the local fixture site.
  if (target && !isLoopback(target)) usage("The target must be the local fixture site (a loopback address). See CLAUDE.md.");
  if (!target) {
    const site = await startFixtureSite({ defects });
    return { targetOrigin: site.origin, site };
  }
  const targetOrigin = new URL(target).origin;
  // A loopback address is not enough: another local service (an admin panel, a database UI) is not the fixture.
  const health = await fetch(`${targetOrigin}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<{ build?: string }>, () => null);
  if (!health || typeof health.build !== "string" || !health.build.startsWith("fixture-")) {
    usage(`${targetOrigin} does not identify itself as the fixture site (GET /health must report a build starting with "fixture-").`);
  }
  if (defects.length > 0) {
    const config = loadConfig();
    await fetch(`${targetOrigin}/__test/defects`, { method: "POST", headers: { "content-type": "application/json", ...config.testApi.headers }, body: JSON.stringify({ defects }) });
  }
  return { targetOrigin, site: null };
}

async function killSwitchCommand(action: string | undefined, v: { by?: string; reason?: string; review?: string; fix?: string; "preflight-report"?: string; "golden-report"?: string; target?: string }): Promise<number> {
  const config = loadConfig();
  const targetOrigin = v.target ? new URL(v.target).origin : "http://127.0.0.1:4173";
  const ks = new KillSwitch({ config, targetOrigin });
  try {
    if (action === "status") {
      const s = ks.status();
      console.log(s.paused ? `PAUSED since ${s.engaged_at} by ${s.engaged_by}: ${s.reason}` : "Not engaged. The runner may run.");
      if (s.revoked) console.log(`  Revoked: ${s.revoked.session_files_removed} session file(s) removed; ${s.revoked.calls.map((c) => `${c.call} ${c.ok ? "ok" : "FAILED"} (${c.detail})`).join("; ") || "no revoke calls configured"}`);
      return 0;
    }
    if (action === "engage") {
      const s = await ks.engage({ by: v.by ?? "", reason: v.reason ?? "" });
      console.log(`PAUSED. Engaged ${s.engaged_at} by ${s.engaged_by}: ${s.reason}`);
      if (s.revoked) console.log(`  Revoked: ${s.revoked.session_files_removed} session file(s) removed; ${s.revoked.calls.map((c) => `${c.call} ${c.ok ? "ok" : "FAILED"} (${c.detail})`).join("; ") || "no revoke calls configured"}`);
      return 0;
    }
    if (action === "resume") {
      await ks.resume({ by: v.by ?? "", review: v.review ?? "", fix: v.fix ?? "", preflightReport: v["preflight-report"] ?? "", ...(v["golden-report"] !== undefined ? { goldenReport: v["golden-report"] } : {}) });
      console.log("Resumed. Access was restored, and the runner may run.");
      return 0;
    }
  } catch (error) {
    if (error instanceof KillSwitchError) {
      console.error(error.message);
      return 3;
    }
    throw error;
  }
  return usage("Expected: kill-switch status | engage | resume");
}

/**
 * The exit code for a report. 0 only when every planned case is PASS. 1 when any case is FAIL. 3 when nothing was
 * executed (the run was refused). 2 for anything else that is not verified.
 */
function exitCodeFor(report: Report): number {
  if (report.summary.executed === 0) return 3;
  if (report.summary.by_verdict.FAIL > 0) return 1;
  return report.summary.verified === report.summary.planned ? 0 : 2;
}

function emit(report: Report, runsDir: string): void {
  const written = writeReport(report, runsDir);
  console.log(formatReport(report));
  console.log(`Report:  ${written.json}`);
}

/** Runs one or more cases, one after another, each behind its own pre-flight check, and ends with one report. */
async function runCommand(casePaths: string[], values: { script?: string; "judge-script"?: string; defects?: string; "negative-control"?: boolean; mutate?: string; target?: string }): Promise<number> {
  if (new Set(casePaths).size !== casePaths.length) usage("The same case file was given twice.");
  const loaded: Array<{ path: string; testCase: TestCase }> = [];
  const invalid = new Map<string, string>();
  for (const path of casePaths) {
    try {
      loaded.push({ path, testCase: loadCase(path) });
    } catch (error) {
      if (!(error instanceof CaseValidationError)) throw error;
      // A case that does not validate is rejected before its run starts and counts as not executed (manual: Definitions).
      // The rest of the batch still runs, and the report lists the case so that a person decides what to do about it.
      console.error(error.message);
      invalid.set(path, error.message.replace(/\s*\n\s*/g, " "));
    }
  }
  const idList = loaded.map((l) => l.testCase.id);
  if (new Set(idList).size !== idList.length) usage("Two of the case files have the same case id.");
  if (loaded.length > 1 && (values.script !== undefined || values["judge-script"] !== undefined || values.mutate !== undefined)) {
    usage("--script, --judge-script and --mutate belong to one case, so they need exactly one case file.");
  }

  const scriptFor = (c: TestCase) => values.script ?? `tests/ci/scripts/${c.id}.json`;
  for (const { testCase } of loaded) {
    if (!existsSync(scriptFor(testCase))) usage(`No script found at ${scriptFor(testCase)}. Pass --script <file>.`);
  }
  const judgePath = values["judge-script"];
  if (judgePath !== undefined && !existsSync(judgePath)) usage(`No judge script found at ${judgePath}.`);
  if (judgePath === undefined && loaded.some((l) => l.testCase.expected.some((e) => e.kind === "judged"))) {
    console.error("Note: a case has judged expected results and no --judge-script was given, so they will get NO_EVIDENCE and that run will be INCONCLUSIVE.\n");
  }

  const entries = loaded.map(({ path, testCase }) => {
    if (!values["negative-control"]) return { path, testCase, control: null as string | null };
    const control = negativeControl(testCase, values.mutate);
    return { path, testCase: control.testCase, control: `negative control: ${control.mutatedId} made wrong, expect FAIL` };
  });

  const defects = (values.defects ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  try {
    assertKnownDefects(defects);
  } catch (error) {
    usage((error as Error).message);
  }
  // With nothing valid to run there is no need to start the fixture site.
  const { targetOrigin, site } = entries.length > 0 ? await resolveTarget(values.target, defects) : { targetOrigin: "", site: null };

  try {
    const config = loadConfig();
    const runDirs = new Map<string, string>();
    const notRun = new Map<string, string>();
    let stopped: string | null = null;
    let printedPreflight = false;
    for (const entry of entries) {
      const id = entry.testCase.id;
      // After a refusal the rest of the batch does not start. They are reported as planned and not executed.
      if (stopped !== null) {
        notRun.set(id, `not started, because ${stopped}`);
        continue;
      }
      try {
        const { runDir, preflight } = await orchestrateRun({
          testCase: entry.testCase,
          caseSource: entry.path,
          targetOrigin,
          config,
          // The only valid target is the fixture site, whose credentials are fake.
          secrets: new StaticSecretStore(FIXTURE_SECRETS),
          // The canary cases use the same kind of model as the real run.
          modelFor: (c) => ScriptedModelClient.fromFile(c.id === id ? scriptFor(entry.testCase) : `tests/ci/scripts/${c.id}.json`),
          ...(judgePath !== undefined ? { judge: ScriptedJudge.fromFile(judgePath) } : {}),
          provider: new ScriptedProviderStatus(),
          killSwitch: new KillSwitch({ config, targetOrigin }),
        });
        runDirs.set(id, runDir);
        if (!printedPreflight) printPreflight(preflight);
        printedPreflight = true;
      } catch (error) {
        if (error instanceof PreflightFailedError) {
          printPreflight(error.report);
          console.error(error.message);
          stopped = `the pre-flight check failed (${failedChecks(error.report).map((c) => c.name).join(", ")})`;
          notRun.set(id, error.message);
        } else if (error instanceof RunnerPausedError) {
          console.error(error.message);
          stopped = "the runner is paused by the kill switch";
          notRun.set(id, error.message);
        } else {
          throw error;
        }
      }
    }

    // The report reads the stored run records, so what it shows is what was written to disk.
    const plan: PlanEntry[] = casePaths.map((path) => {
      const reason = invalid.get(path);
      if (reason !== undefined) return { id: `invalid case file: ${path}`, source: path, notRunReason: `the case file is invalid and was rejected before its run: ${reason}` };
      const e = entries.find((x) => x.path === path)!;
      return {
        id: e.testCase.id,
        source: e.path,
        title: e.testCase.title,
        priority: e.testCase.priority,
        ...(notRun.has(e.testCase.id) ? { notRunReason: notRun.get(e.testCase.id)! } : {}),
        ...(e.control ? { control: e.control } : {}),
      };
    });
    const report = buildReport({
      reportId: newReportId(),
      generatedAt: new Date().toISOString(),
      plan,
      runs: [...runDirs.values()].map((dir) => loadRun(dir)),
    });
    emit(report, config.runs.directory);
    // Every case file invalid is a usage error, not a refused run.
    return invalid.size === casePaths.length ? 64 : exitCodeFor(report);
  } finally {
    await site?.close();
  }
}

/** Builds a report from run records already on disk, optionally against the plan that was meant to run. */
function reportCommand(runPaths: string[], values: { plan?: string }): number {
  if (runPaths.length === 0) usage("Expected: report <run directory or run.json>... [--plan a.yaml,b.yaml]");
  let plan: PlanEntry[] | null = null;
  if (values.plan !== undefined) {
    plan = [];
    for (const path of values.plan.split(",").map((p) => p.trim()).filter(Boolean)) {
      try {
        const c = loadCase(path);
        plan.push({ id: c.id, source: path, title: c.title, priority: c.priority });
      } catch (error) {
        if (!(error instanceof CaseValidationError)) throw error;
        console.error(error.message);
        return 64;
      }
    }
  }
  try {
    const report = buildReport({ reportId: newReportId(), generatedAt: new Date().toISOString(), plan, runs: runPaths.map((p) => loadRun(p)) });
    emit(report, loadConfig().runs.directory);
    return exitCodeFor(report);
  } catch (error) {
    if (error instanceof ReportError) {
      console.error(error.message);
      return 64;
    }
    throw error;
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      script: { type: "string" },
      "judge-script": { type: "string" },
      defects: { type: "string" },
      "negative-control": { type: "boolean", default: false },
      mutate: { type: "string" },
      target: { type: "string" },
      by: { type: "string" },
      reason: { type: "string" },
      review: { type: "string" },
      fix: { type: "string" },
      "preflight-report": { type: "string" },
      "golden-report": { type: "string" },
      cases: { type: "string" },
      plan: { type: "string" },
      out: { type: "string" },
      "for-resume": { type: "boolean", default: false },
      sample: { type: "string" },
      repeat: { type: "string" },
      runs: { type: "string" },
      "out-dir": { type: "string" },
      file: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) usage();
  const [command, casePath] = positionals;
  if (command === "kill-switch") return killSwitchCommand(casePath, values);
  if (command === "preflight") return preflightCommand(values);
  if (command === "eval") return evalCommand(casePath, values);
  if (command === "golden") return goldenCommand(casePath, values);
  if (command === "report") return reportCommand(positionals.slice(1), values);
  if (command !== "run" || !casePath) usage("Expected: run <case.yaml>..., report, preflight, or kill-switch status|engage|resume");
  return runCommand(positionals.slice(1), values);
}

async function preflightCommand(values: { cases?: string; out?: string; target?: string; "for-resume"?: boolean }): Promise<number> {
  const config = loadConfig();
  const { targetOrigin, site } = await resolveTarget(values.target, []);
  try {
    const planned = (values.cases ?? "").split(",").map((c) => c.trim()).filter(Boolean).map((p) => loadCase(p));
    const report = await preflightFor({
      config,
      targetOrigin,
      secrets: new StaticSecretStore(FIXTURE_SECRETS),
      modelFor: (c) => ScriptedModelClient.fromFile(`tests/ci/scripts/${c.id}.json`),
      provider: new ScriptedProviderStatus(),
      killSwitch: new KillSwitch({ config, targetOrigin }),
      plannedCases: planned,
      purpose: values["for-resume"] ? "resume" : "run",
      ...(values.out ? { reportPath: values.out } : {}),
    });
    printPreflight(report);
    console.log(`Report: ${values.out ?? join(config.runs.directory, "preflight-latest.json")}`);
    return failedChecks(report).length > 0 ? 2 : 0;
  } finally {
    await site?.close();
  }
}

function positiveInt(name: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) usage(`--${name} must be a whole number of at least 1.`);
  return n;
}

/** The eval suites. They run against the fixture site only, and they stop when the kill switch is engaged. */
async function evalCommand(suite: string | undefined, values: { sample?: string; repeat?: string; runs?: string; "out-dir"?: string; target?: string }): Promise<number> {
  if (suite !== "mutants" && suite !== "injection") return usage("Expected: eval mutants [--sample N] [--repeat R] [--out-dir <dir>] | eval injection [--runs N] [--out-dir <dir>]");
  if (values.target) usage("The eval suites start their own fixture site, so --target is not allowed.");
  const config = loadConfig();
  const progress = (done: number, total: number) => {
    if (done % 25 === 0 || done === total) console.error(`  ${done} of ${total}`);
  };

  if (suite === "injection") {
    const runs = positiveInt("runs", values.runs);
    const outside = await startOutsideServer();
    const site = await startFixtureSite({ outsideOrigin: outside.origin });
    const outDir = values["out-dir"] ?? join(config.runs.directory, "eval", "injection");
    try {
      const report = await evaluateInjection({
        config,
        site,
        outside,
        outDir,
        pause: new KillSwitch({ config, targetOrigin: site.origin }),
        ...(runs !== undefined ? { runs } : {}),
        onProgress: progress,
      });
      console.log(formatInjectionReport(report));
      console.log(`\nReport: ${join(outDir, "injection-eval-latest.json")}`);
      return report.ok ? 0 : 2;
    } catch (error) {
      if (error instanceof RunnerPausedError) {
        console.error(error.message);
        return 3;
      }
      throw error;
    } finally {
      await site.close();
      await outside.close();
    }
  }

  const sample = positiveInt("sample", values.sample);
  const repeat = positiveInt("repeat", values.repeat);
  const { targetOrigin, site } = await resolveTarget(undefined, []);
  const outDir = values["out-dir"] ?? join(config.runs.directory, "eval", "mutants");
  try {
    const report = await evaluateMutants({
      config,
      site: site!,
      outDir,
      pause: new KillSwitch({ config, targetOrigin }),
      ...(sample !== undefined ? { sample } : {}),
      ...(repeat !== undefined ? { repeat } : {}),
      onProgress: progress,
    });
    console.log(formatMutantReport(report));
    console.log(`\nReport: ${join(outDir, "mutant-eval-latest.json")}`);
    return report.ok ? 0 : 2;
  } catch (error) {
    if (error instanceof RunnerPausedError) {
      console.error(error.message);
      return 3;
    }
    throw error;
  } finally {
    await site?.close();
  }
}

/**
 * The golden set: verdicts frozen by a person. `golden` runs it and reports drift. `golden rehash` records the current
 * hashes of the case files and scripts after a person has reviewed a deliberate change. It never changes an expected verdict.
 */
async function goldenCommand(action: string | undefined, values: { file?: string; "out-dir"?: string; "for-resume"?: boolean; target?: string }): Promise<number> {
  const config = loadConfig();
  const file = values.file ?? config.evals.golden.file;
  if (action === "rehash") {
    const changed = rehashGoldenSet(file);
    console.log(`Recorded the current inputs of ${changed} entr${changed === 1 ? "y" : "ies"} in ${file}. A person must review this change like any other change to the golden set.`);
    return 0;
  }
  if (action !== undefined) return usage("Expected: golden [--file <set>] [--out-dir <dir>] [--for-resume] | golden rehash [--file <set>]");
  if (values.target) usage("The golden set starts its own fixture site, so --target is not allowed.");
  const { targetOrigin, site } = await resolveTarget(undefined, []);
  const outDir = values["out-dir"] ?? join(config.runs.directory, "eval", "golden");
  try {
    const report = await runGoldenSet({
      config,
      site: site!,
      outDir,
      file,
      purpose: values["for-resume"] ? "resume" : "run",
      pause: new KillSwitch({ config, targetOrigin }),
    });
    console.log(formatGoldenReport(report));
    console.log(`\nReport: ${join(outDir, "golden-latest.json")}`);
    return report.ok ? 0 : 2;
  } catch (error) {
    if (error instanceof RunnerPausedError) {
      console.error(error.message);
      return 3;
    }
    if (error instanceof GoldenSetError) {
      console.error(error.message);
      return 64;
    }
    throw error;
  } finally {
    await site?.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(70);
  },
);
