// Runs several cases one after another, each behind its own pre-flight check, and ends with one report. The command line, the
// library entry point (src/index.ts) and the MCP server all run cases through here, so they cannot drift apart.
//
// After a refusal (the kill switch is engaged, or a pre-flight check failed) the rest of the batch does not start. Those cases
// are reported as planned and not executed. A case file that did not validate is listed the same way, with the reason.
import type { Config } from "./config.ts";
import type { JudgeClient } from "./judge/client.ts";
import type { ModelClient } from "./model/client.ts";
import { KillSwitch, RunnerPausedError } from "./ops/kill-switch.ts";
import { failedChecks } from "./preflight/preflight.ts";
import type { ProviderStatus } from "./preflight/provider.ts";
import type { PreflightReport } from "./preflight/report.ts";
import { buildReport, loadRun, type PlanEntry } from "./report/build.ts";
import type { Report } from "./report/schema.ts";
import { newReportId } from "./report/write.ts";
import { orchestrateRun, PreflightFailedError, type CanaryMemo } from "./runner/orchestrate.ts";
import type { TestCase } from "./schemas/case.ts";
import type { SecretStore } from "./secrets/store.ts";
import { externalCaseProblems, isLoopbackTarget, runAllowlist } from "./target.ts";

export interface BatchEntry {
  /** Where the case came from (a file path, or a label for a case given as an object). Used to tell cases apart and shown in the report. */
  source: string;
  testCase: TestCase;
  /** Set for a negative control: the text that says which expected result was made wrong. */
  control?: string | null;
  /** Makes the model for a case. The canary cases use it too, so they run the same way as the real run. */
  modelFor: (testCase: TestCase) => ModelClient;
  judge?: JudgeClient;
}

export interface BatchOptions {
  /** Every planned source, in order. A source that is in `invalid` has no entry. */
  order: readonly string[];
  entries: readonly BatchEntry[];
  /** Sources that did not validate, with the reason. They count as planned and not executed. */
  invalid?: ReadonlyMap<string, string>;
  targetOrigin: string;
  /** What the target is (from assertTarget). Without it the target is taken to be the fixture site. */
  target?: { kind: "fixture" | "external"; note: string };
  /** Required for an external target: a fixture site where the canary pair runs, because the canary must never run on an external target. */
  canaryTargetOrigin?: string;
  config: Config;
  secrets: SecretStore;
  provider: ProviderStatus;
  /** For a test: another kill switch. */
  killSwitchFor?: () => KillSwitch;
  /** Called once, after the first case that passed its pre-flight check. */
  onPreflightPassed?: (report: PreflightReport) => void;
  onPreflightFailed?: (report: PreflightReport, message: string) => void;
  onPaused?: (message: string) => void;
}

export interface BatchResult {
  report: Report;
  /** The run directory of each case that ran, by case id. */
  runDirs: ReadonlyMap<string, string>;
}

export async function runBatch(options: BatchOptions): Promise<BatchResult> {
  const { targetOrigin } = options;
  // A target that nobody checked with assertTarget is taken to be the fixture, and the fixture is on this machine. Anything else is refused,
  // so a host that calls runBatch directly cannot point it at another site by leaving the target out.
  // (A batch with nothing to run has no target to check: every case file was invalid, and the report just lists them.)
  if (!options.target && options.entries.length > 0 && !isLoopbackTarget(targetOrigin)) {
    throw new Error("runBatch needs the result of assertTarget for a target that is not on this machine. QaBot.run does that.");
  }
  // The allowlist of these runs is worked out from the target: an external run reaches the listed origins and nothing else, and a fixture run
  // never reaches an external origin.
  const config: Config = structuredClone(options.config);
  config.allowlist.hosts = runAllowlist(options.config, options.target?.kind ?? "fixture");
  const runDirs = new Map<string, string>();
  const notRun = new Map<string, string>();
  let stopped: string | null = null;
  let printedPreflight = false;
  // The canary pair is run once for the batch, before its first case. A case later in the batch reuses the result, and every other
  // pre-flight check (the kill switch, the provider, the target, the build) still runs for each case.
  const canaryMemo: CanaryMemo = new Map();
  const external = options.target?.kind === "external";
  if (external && !options.canaryTargetOrigin) {
    throw new Error("An external target needs a fixture site for the canary pair (canaryTargetOrigin). The canary cases send requests that change state, and they must never run on an external target.");
  }
  for (const entry of options.entries) {
    const id = entry.testCase.id;
    if (stopped !== null) {
      notRun.set(id, `not started, because ${stopped}`);
      continue;
    }
    // A case that is not safe on someone's real site is not run there. It is listed as not executed, with the reasons, and the rest of the batch runs.
    if (external) {
      const problems = externalCaseProblems(entry.testCase, config);
      if (problems.length > 0) {
        notRun.set(id, `not run on an external target: ${problems.join("; ")}`);
        continue;
      }
    }
    try {
      const { runDir, preflight } = await orchestrateRun({
        testCase: entry.testCase,
        caseSource: entry.source,
        targetOrigin,
        config,
        secrets: options.secrets,
        modelFor: entry.modelFor,
        ...(entry.judge ? { judge: entry.judge } : {}),
        provider: options.provider,
        // The kill switch's revoke calls are for the fixture. They are never sent to an external target.
        killSwitch: options.killSwitchFor ? options.killSwitchFor() : new KillSwitch({ config, targetOrigin: options.canaryTargetOrigin ?? targetOrigin }),
        canaryMemo,
        ...(options.target ? { target: options.target } : {}),
        ...(options.canaryTargetOrigin ? { canaryTargetOrigin: options.canaryTargetOrigin } : {}),
        // Nothing is asked of an external site except what the case's steps send: no /health request before or after the run.
        ...(external ? { buildProbe: async () => ({ ok: false, build: null }) } : {}),
      });
      runDirs.set(id, runDir);
      if (!printedPreflight) options.onPreflightPassed?.(preflight);
      printedPreflight = true;
    } catch (error) {
      if (error instanceof PreflightFailedError) {
        options.onPreflightFailed?.(error.report, error.message);
        stopped = `the pre-flight check failed (${failedChecks(error.report).map((c) => c.name).join(", ")})`;
        notRun.set(id, error.message);
      } else if (error instanceof RunnerPausedError) {
        options.onPaused?.(error.message);
        stopped = "the runner is paused by the kill switch";
        notRun.set(id, error.message);
      } else {
        throw error;
      }
    }
  }

  // The report reads the stored run records, so what it shows is what was written to disk.
  const plan: PlanEntry[] = options.order.map((source) => {
    const reason = options.invalid?.get(source);
    if (reason !== undefined) return { id: `invalid case file: ${source}`, source, notRunReason: `the case file is invalid and was rejected before its run: ${reason}` };
    const e = options.entries.find((x) => x.source === source)!;
    return {
      id: e.testCase.id,
      source: e.source,
      title: e.testCase.title,
      priority: e.testCase.priority,
      ...(notRun.has(e.testCase.id) ? { notRunReason: notRun.get(e.testCase.id)! } : {}),
      ...(e.control ? { control: e.control } : {}),
    };
  });
  // A report of a run on an external target says what the target was and who attested that the test was allowed, in its header.
  const notes = external && options.target ? [options.target.note] : [];
  const report = buildReport({ reportId: newReportId(), generatedAt: new Date().toISOString(), plan, runs: [...runDirs.values()].map((dir) => loadRun(dir)), notes });
  return { report, runDirs };
}
