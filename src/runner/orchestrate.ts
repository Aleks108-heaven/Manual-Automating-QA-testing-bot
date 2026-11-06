// Starting a run properly: the runner must not be paused, the pre-flight check must not have a failed check, and
// only then does the case run. The command line uses this. Tests that exercise the runner directly use runCase.
import { join } from "node:path";
import type { Config } from "../config.ts";
import { hashText, stableJson } from "../hash.ts";
import type { Verdict } from "../schemas/common.ts";
import type { JudgeClient } from "../judge/client.ts";
import type { ModelClient } from "../model/client.ts";
import { KillSwitch, RunnerPausedError } from "../ops/kill-switch.ts";
import { failedChecks, runPreflight, writePreflightReport } from "../preflight/preflight.ts";
import type { ProviderStatus } from "../preflight/provider.ts";
import type { PreflightReport } from "../preflight/report.ts";
import type { TestCase } from "../schemas/case.ts";
import type { SecretStore } from "../secrets/store.ts";
import { defaultBuildProbe, runCase, type BuildProbe, type RunOptions, type RunResult } from "./run-case.ts";

/** Thrown when the pre-flight check has a failed check. The report says which. */
export class PreflightFailedError extends Error {
  readonly report: PreflightReport;
  constructor(report: PreflightReport) {
    super(`Pre-flight check failed: ${failedChecks(report).map((c) => c.name).join(", ")}. The run did not start.`);
    this.name = "PreflightFailedError";
    this.report = report;
  }
}

export interface OrchestrateOptions {
  testCase: TestCase;
  caseSource: string;
  targetOrigin: string;
  config: Config;
  secrets: SecretStore;
  /** Makes the model for a case. The canary cases use it too, so they run the same way as the real run. */
  modelFor: (testCase: TestCase) => ModelClient;
  judge?: JudgeClient;
  provider: ProviderStatus;
  killSwitch: KillSwitch;
  buildProbe?: BuildProbe;
  /** Replay an approved frozen script. `modelFor` must give that script's FrozenScriptModel for the case. */
  frozen?: NonNullable<RunOptions["frozen"]>;
  /**
   * The canary runs already made in this batch. A batch runs the canary pair once, before its first case, and the later cases reuse
   * the result (every other check still runs for each case). Without a memo every run makes its own canary runs.
   */
  canaryMemo?: CanaryMemo;
  /** What is being tested. For an external target, its note (who attested to it) goes into the pre-flight report. */
  target?: { kind: "fixture" | "external"; note: string };
  /**
   * Where the canary pair runs, when that is not the target. The canary cases are written for the fixture site and send requests that change
   * state, so they must never run on an external target: an external target needs a fixture site for them.
   */
  canaryTargetOrigin?: string;
}

/** The verdict of each canary run made so far in one batch, by the canary's content. A canary that was changed is a different canary. */
export type CanaryMemo = Map<string, Verdict>;

/** Runs the pre-flight check for the given cases and writes its report. Does not start a run. */
export async function preflightFor(
  options: Omit<OrchestrateOptions, "testCase" | "caseSource" | "judge"> & { plannedCases: readonly TestCase[]; reportPath?: string; purpose?: "run" | "resume" },
): Promise<PreflightReport> {
  const purpose = options.purpose ?? "run";
  const { config, targetOrigin } = options;
  const probe = options.buildProbe ?? defaultBuildProbe;
  if (options.target?.kind === "external" && !options.canaryTargetOrigin) {
    throw new Error("An external target needs a fixture site for the canary pair (canaryTargetOrigin). The canary cases send requests that change state, and they must never run on an external target.");
  }
  // The canaries run in their own folder so they do not mix with real runs.
  const canaryConfig: Config = structuredClone(config);
  canaryConfig.runs.directory = join(config.runs.directory, "canary");
  // They run on the fixture site, which the browser may reach on its own; the external origins are not for them.
  const canaryOrigin = options.canaryTargetOrigin ?? targetOrigin;
  if (options.canaryTargetOrigin) canaryConfig.allowlist.hosts = [];
  const canaryProbe = options.canaryTargetOrigin ? defaultBuildProbe : probe;
  let reused = false;
  const report = await runPreflight({
    canaryNote: () => (reused ? " (the canary pair ran earlier in this batch, so its result is reused)" : ""),
    ...(options.target ? { target: options.target } : {}),
    ...(options.canaryTargetOrigin ? { sessionsOrigin: options.canaryTargetOrigin } : {}),
    config,
    targetOrigin,
    pause: options.killSwitch,
    purpose,
    provider: options.provider,
    secrets: options.secrets,
    probe,
    plannedCases: options.plannedCases,
    runCanary: async (canary) => {
      const key = hashText(stableJson(canary));
      const known = options.canaryMemo?.get(key);
      if (known !== undefined) {
        reused = true;
        return known;
      }
      const verdict = (
        await runCase({
          testCase: canary,
          caseSource: "canary",
          targetOrigin: canaryOrigin,
          model: options.modelFor(canary),
          config: canaryConfig,
          secrets: options.secrets,
          buildProbe: canaryProbe,
          // A check made to resume the kill switch has to run canaries while the switch is still engaged.
          ...(purpose === "resume" ? {} : { pause: options.killSwitch }),
        })
      ).record.verdict;
      options.canaryMemo?.set(key, verdict);
      return verdict;
    },
  });
  writePreflightReport(report, options.reportPath ?? join(config.runs.directory, "preflight-latest.json"));
  return report;
}

export async function orchestrateRun(options: OrchestrateOptions): Promise<RunResult & { preflight: PreflightReport }> {
  if (options.killSwitch.isPaused()) throw new RunnerPausedError(options.killSwitch.status());
  const preflight = await preflightFor({ ...options, plannedCases: [options.testCase] });
  if (failedChecks(preflight).length > 0) throw new PreflightFailedError(preflight);
  const result = await runCase({
    testCase: options.testCase,
    caseSource: options.caseSource,
    targetOrigin: options.targetOrigin,
    model: options.modelFor(options.testCase),
    config: options.config,
    secrets: options.secrets,
    ...(options.judge ? { judge: options.judge } : {}),
    ...(options.buildProbe ? { buildProbe: options.buildProbe } : {}),
    ...(options.frozen ? { frozen: options.frozen } : {}),
    pause: options.killSwitch,
    preflight,
  });
  return { ...result, preflight };
}
