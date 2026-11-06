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
//   node src/cli.ts frozen freeze | approve | approve-proposal | run
//
// Every run starts with the pre-flight check and refuses to start if the kill switch is engaged. A run ends with a
// report (src/report/). After a refusal the rest of a batch does not start, and the report lists those cases as not executed.
// Exit codes: 0 every planned case is PASS, 1 any case is FAIL, 2 anything else that is not verified (BLOCKED,
// INCONCLUSIVE, INCOMPLETE, or a case that did not run), 3 nothing ran because the run was refused (kill switch
// engaged, or a pre-flight check failed), 64 usage error, 70 unexpected error.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CaseValidationError, loadCase } from "./cases/load.ts";
import { mutateExpected, negativeControl } from "./cases/mutate.ts";
import { isLoopbackUrl, loadConfig, loadConfigForListing, loadConfigIgnoringProvider, loadConfigWith, modelChosenInEnvironment, type Config } from "./config.ts";
import { exitCodeFor } from "./api.ts";
import { cleanForTerminal } from "./report/sanitize.ts";
import { assertFixtureTarget, assertTarget, TargetError } from "./target.ts";
import { runBatch } from "./batch.ts";
import { createLiveProvider, createProviderHttp, type LiveProvider } from "./provider.ts";
import type { ModelClient } from "./model/client.ts";
import type { JudgeClient } from "./judge/client.ts";
import type { ProviderStatus } from "./preflight/provider.ts";
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
import { newReleaseId, newReportId, writeRelease, writeReport } from "./report/write.ts";
import { buildRelease, checkRecordsOnDisk, loadInventory, loadRegister, ReleaseError } from "./release/build.ts";
import { formatRelease } from "./release/format.ts";
import { ReportSchema } from "./report/schema.ts";
import { exportScript } from "./frozen/export.ts";
import { ScriptedProposer } from "./frozen/propose.ts";
import { FrozenScriptModel } from "./frozen/replay.ts";
import { hashText } from "./hash.ts";
import { READ_LIMITS, readTextCapped, TooLargeError } from "./safe-read.ts";
import { approveProposal, approveScript, FrozenError, loadApprovedScript, loadFrozenRegister, nextVersion, readFrozenScript, readProposal, scriptsDirectory, writeDraft } from "./frozen/store.ts";
import { startOutsideServer } from "../fixtures/outside-server.ts";
import { assertKnownDefects, startFixtureSite, type FixtureSite } from "../fixtures/site/server.ts";

const USAGE = `Usage: node src/cli.ts cases [<case.yaml>...]       list the cases, or check the given files, without running them
       node src/cli.ts run <case.yaml>... [options]
       node src/cli.ts report <run directory or run.json>... [--plan a.yaml,b.yaml]
       node src/cli.ts release <report.json or report directory> [--register <file>] [--cases-dir <dir>] [--today YYYY-MM-DD]
       node src/cli.ts frozen freeze <case.yaml> <run directory>...
       node src/cli.ts frozen approve <draft.json> --by <name> [--case <case.yaml>]
       node src/cli.ts frozen approve-proposal <proposal.json> --by <name> [--case <case.yaml>]
       node src/cli.ts frozen run <case.yaml> [--proposal-script <file>] [--defects a,b] [--target <url>]
       node src/cli.ts preflight [--cases a.yaml,b.yaml] [--out <file>] [--for-resume]
       node src/cli.ts eval mutants [--sample N] [--repeat R] [--out-dir <dir>]
       node src/cli.ts eval injection [--runs N] [--out-dir <dir>]
       node src/cli.ts golden [--file <set>] [--out-dir <dir>] [--for-resume]
       node src/cli.ts golden rehash [--file <set>]
       node src/cli.ts provider models
       node src/cli.ts provider check [--model <id>] [--judge-model <id>] [--probe-context]
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
  --live                 Use the model server in config provider (LM Studio, Ollama...) instead of the scripted fake. Also for preflight and frozen run
  --model <id>           The model, as listed by "provider models" (or QA_PROVIDER_MODEL). --judge-model for the judge
`;

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error(USAGE);
  process.exit(64);
}

interface ProviderFlags {
  live?: boolean;
  model?: string;
  "judge-model"?: string;
  "probe-context"?: boolean;
}

/** The configuration, with the provider flags applied. --live means provider.kind openai-compatible; --model and --judge-model name models from the server's list. */
function configFor(flags: ProviderFlags): Config {
  const overrides: Record<string, string> = {};
  if (flags.live) overrides["QA_PROVIDER"] = "openai-compatible";
  if (flags.model) overrides["QA_PROVIDER_MODEL"] = flags.model;
  if (flags["judge-model"]) overrides["QA_PROVIDER_JUDGE_MODEL"] = flags["judge-model"];
  let config: Config;
  try {
    config = Object.keys(overrides).length > 0 ? loadConfigWith(overrides) : loadConfig();
  } catch (error) {
    // A provider setting the data handling rules refuse (a remote address without a register entry) is a usage problem, not a crash.
    // Only an error about the provider section is one: the issues name their path, and for this section it starts with "provider".
    if (error instanceof Error && /"provider"/.test(error.message)) usage(`The provider settings are not allowed:\n${error.message}`);
    throw error;
  }
  // A model named for the scripted fake would be ignored without a word, and the run would look as if that model had done it.
  if ((flags.model || flags["judge-model"]) && config.provider.kind === "scripted") usage("--model and --judge-model need a live provider: add --live (or set QA_PROVIDER=openai-compatible).");
  return config;
}

interface ProviderParts {
  provider: ProviderStatus;
  /** Set when a live provider is used. */
  live: LiveProvider | null;
}

/** The scripted fake by default, the live provider when the configuration says so. The canary cases get the same kind of model as the real run. */
async function providerParts(config: Config): Promise<ProviderParts> {
  if (config.provider.kind === "scripted") return { provider: new ScriptedProviderStatus(), live: null };
  const live = await createLiveProvider(config);
  return { provider: live.status, live };
}

/** The model for a case: the live model, or the scripted fake that plays the case's script file. */
function modelForCase(parts: ProviderParts, scripted: (testCase: TestCase) => ModelClient): (testCase: TestCase) => ModelClient {
  const live = parts.live;
  return live ? () => live.newModel() : scripted;
}

function describeProvider(config: Config): string {
  const p = config.provider;
  if (p.kind === "scripted") return "scripted fake model (no language model)";
  const where = isLoopbackUrl(p.baseUrl) ? "on this machine" : `OFF this machine (register entry: ${p.registerEntry ?? "none"})`;
  return `${p.modelId} at ${p.baseUrl}, ${where}; judge ${p.judgeModelId ?? p.modelId}; mode ${p.actionMode}; images ${p.vision ? "yes" : "no"}`;
}

/** provider models | provider check: what the server offers, and whether the chosen model can be used. */
async function providerCommand(action: string | undefined, flags: ProviderFlags): Promise<number> {
  if (action !== "models" && action !== "check") return usage("Expected: provider models | provider check [--model <id>] [--judge-model <id>]");
  // Listing the models is how one is chosen, so it must work before any is: it ignores the kind and the model names in the environment.
  // Checking needs a chosen model.
  let config: Config;
  try {
    config = action === "check" ? configFor({ ...flags, live: true }) : loadConfigForListing();
  } catch (error) {
    if (error instanceof Error && /"provider"/.test(error.message)) usage(`The provider settings are not allowed:\n${error.message}`);
    throw error;
  }
  let http;
  try {
    http = await createProviderHttp(config);
  } catch (error) {
    console.error((error as Error).message);
    return 64;
  }
  let listed: string[];
  try {
    listed = await http.listModels();
  } catch (error) {
    console.error(`${(error as Error).message}`);
    console.error("Is the server running? In LM Studio start the local server (Developer tab); for Ollama run `ollama serve`. Set the address with QA_PROVIDER_URL.");
    return 3;
  }
  if (action === "models") {
    // A name from the server is data, like page text: it is cleaned before it reaches the terminal.
    const chosen = flags.model ?? modelChosenInEnvironment();
    console.log(`Models at ${config.provider.baseUrl}:`);
    for (const id of listed) console.log(`  ${id === chosen ? "*" : " "} ${cleanForTerminal(id)}${/[:\-]cloud$/i.test(id) ? "   (runs off this machine)" : ""}`);
    console.log(chosen ? `\n* is the chosen model. Choose another with --model <id> or QA_PROVIDER_MODEL.` : `\nNone is chosen. Pass --model <id> or set QA_PROVIDER_MODEL.`);
    return 0;
  }
  console.log(`Provider: ${describeProvider(config)}`);
  try {
    const live = await createLiveProvider(config);
    await live.status.ping();
    console.log("OK: the server answered and lists the model(s) the run needs.");
    if (flags["probe-context"]) {
      // The server cuts a prompt that is longer than its context window without an error. This sends a long prompt and reads back how
      // much of it the server took in. It is slow on a small machine (it loads the model and reads thousands of tokens).
      console.log(`Probing the context: sending a prompt of about ${Math.floor(config.provider.contextTokens * 0.95)} tokens. This can take a few minutes...`);
      const probe = await live.http.probeContext(config.provider.modelId as string, config.provider.contextTokens);
      if (probe.reported === null) {
        console.log("The server does not report how many prompt tokens it took in, so the context cannot be checked this way. Check the context length on the server by hand.");
      } else if (probe.cut) {
        console.error(`CONTEXT TOO SMALL: the server took in ${probe.reported} of about ${probe.sentAbout} prompt tokens. Its context window is smaller than provider.contextTokens (${config.provider.contextTokens}), and it would cut prompts from the front. Raise the context on the server (Ollama: OLLAMA_CONTEXT_LENGTH; LM Studio: the context length when the model is loaded), or lower QA_PROVIDER_CONTEXT to what the server really has.`);
        return 2;
      } else {
        console.log(`OK: the server took in ${probe.reported} of about ${probe.sentAbout} prompt tokens, so its context holds at least the ${config.provider.contextTokens} declared.`);
      }
    }
    return 0;
  } catch (error) {
    console.error(`NOT READY: ${(error as Error).message}`);
    return 2;
  }
}

/**
 * cases | cases <file>...: lists the cases in the cases folder, or checks the files given, without running anything. A case that does not
 * validate is shown with its reasons. A tester runs this after writing a case, before the first run.
 */
function casesCommand(files: string[]): number {
  const config = loadConfigIgnoringProvider();
  const listing = files.length === 0;
  let paths = files;
  if (listing) {
    const dir = config.release.casesDirectory;
    if (!existsSync(dir)) usage(`There is no cases folder at ${dir}.`);
    paths = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort().map((name) => join(dir, name));
    if (paths.length === 0) {
      console.log(`No case files in ${dir}. A case is a .yaml file there: see docs/runbooks/writing-and-running-cases.md.`);
      return 0;
    }
    console.log(`Cases in ${dir}:`);
  }
  let invalid = 0;
  const ids = new Map<string, string>();
  for (const path of paths) {
    try {
      const c = loadCase(path);
      const kinds = [...new Set(c.expected.map((e) => e.kind))];
      const earlier = ids.get(c.id);
      ids.set(c.id, path);
      console.log(`  ok       ${c.id.padEnd(13)} ${c.priority}  ${cleanForTerminal(c.title)}`);
      console.log(`           ${c.steps.length} step(s), ${c.expected.length} expected result(s) (${kinds.join(", ")}), role ${c.role}${c.allowed_mutations.length > 0 ? `, may send ${c.allowed_mutations.join(", ")}` : ", sends no state-changing request"}  [${path}]`);
      if (earlier !== undefined) {
        invalid += 1;
        console.log(`           PROBLEM: the id ${c.id} is also used by ${earlier}. Two cases with one id cannot run in the same batch.`);
      }
      if (c.expected.some((e) => e.kind === "judged")) console.log("           note: has judged results. They need a judge model (--live gives one); with the scripted fake they get NO_EVIDENCE.");
      if (!c.expected.some((e) => mutateExpected(e) !== null)) console.log("           note: no expected result can be made wrong, so --negative-control cannot be used on this case.");
    } catch (error) {
      if (!(error instanceof CaseValidationError)) throw error;
      invalid += 1;
      console.log(`  INVALID  ${path}`);
      for (const issue of error.issues) console.log(`           - ${issue.path || "(case)"}: ${cleanForTerminal(issue.message)}`);
    }
  }
  console.log(`\n${paths.length} case file(s), ${invalid} with a problem.${invalid > 0 ? "" : " Next: node src/cli.ts run <file> --negative-control (must give FAIL), then run it for real."}`);
  return invalid > 0 ? 64 : 0;
}

function printPreflight(report: PreflightReport): void {
  console.log(`Pre-flight  ${report.at}  target ${report.target}`);
  for (const c of report.checks) console.log(`  ${c.status.toUpperCase().padEnd(8)} ${c.name.padEnd(34)} ${c.detail}`);
  const failed = failedChecks(report).length;
  console.log(failed > 0 ? `  ${failed} check(s) failed: the run does not start.` : report.ok ? "  All checks passed." : "  No check failed. Some were skipped, so this report cannot be used to resume the kill switch.");
  console.log();
}

/** What `run` learns about an external target: its note for the report, and the local fixture site where the canary pair runs. */
interface ExternalRun {
  kind: "external";
  note: string;
  canaryTargetOrigin: string;
}

/**
 * Finds the target: an already running fixture (checked) or a new one. With `config` (only `run` passes it) a target may also be an origin
 * that a person listed in targets.external.origins with an attestation. Then a fixture site is started here for the canary pair, and
 * `site` is that fixture, which the caller closes.
 */
async function resolveTarget(target: string | undefined, defects: string[], config?: Config): Promise<{ targetOrigin: string; site: FixtureSite | null; external: ExternalRun | null }> {
  if (!target) {
    const site = await startFixtureSite({ defects });
    return { targetOrigin: site.origin, site, external: null };
  }
  // The only allowed targets are the local fixture site and, if a person turned it on, the origins they listed. A loopback address is not
  // enough (another local service is not the fixture), so the target must say who it is. The library and the MCP server use the same checks.
  let targetOrigin: string;
  let external: { kind: "external"; note: string } | null = null;
  try {
    if (config) {
      const resolved = await assertTarget(target, config);
      targetOrigin = resolved.origin;
      if (resolved.kind === "external") external = { kind: "external", note: resolved.note };
    } else {
      targetOrigin = await assertFixtureTarget(target);
    }
  } catch (error) {
    if (error instanceof TargetError) usage(error.message);
    throw error;
  }
  if (external) {
    if (defects.length > 0) usage("--defects switch on defects of the fixture site, so they cannot be used with an external target.");
    console.log(`External target ${targetOrigin}. ${external.note}\nThe canary pair runs on a local fixture site, never on the external one.\n`);
    const canarySite = await startFixtureSite();
    return { targetOrigin, site: canarySite, external: { ...external, canaryTargetOrigin: canarySite.origin } };
  }
  if (defects.length > 0) {
    const plain = loadConfigIgnoringProvider();
    await fetch(`${targetOrigin}/__test/defects`, { method: "POST", headers: { "content-type": "application/json", ...plain.testApi.headers }, body: JSON.stringify({ defects }) });
  }
  return { targetOrigin, site: null, external: null };
}

async function killSwitchCommand(action: string | undefined, v: { by?: string; reason?: string; review?: string; fix?: string; "preflight-report"?: string; "golden-report"?: string; target?: string }): Promise<number> {
  // The emergency stop does not depend on the model settings: a provider variable that is wrong must not stop it from working.
  const config = loadConfigIgnoringProvider();
  // The revoke and restore calls (POST /__test/revoke and /__test/restore) are the fixture's. They are never sent to another system: a
  // real system needs its own way to revoke the bot's access, which is a decision still open.
  if (v.target && !isLoopbackUrl(v.target)) usage("The kill switch's revoke calls are for the local fixture site. They are never sent to an external system.");
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

function emit(report: Report, runsDir: string): void {
  const written = writeReport(report, runsDir);
  console.log(formatReport(report));
  console.log(`Report:  ${written.json}`);
}

/** Runs one or more cases, one after another, each behind its own pre-flight check, and ends with one report. */
async function runCommand(casePaths: string[], values: ProviderFlags & { script?: string; "judge-script"?: string; defects?: string; "negative-control"?: boolean; mutate?: string; target?: string }): Promise<number> {
  if (new Set(casePaths).size !== casePaths.length) usage("The same case file was given twice.");
  const config = configFor(values);
  const isLive = config.provider.kind !== "scripted";
  if (isLive && (values.script !== undefined || values["judge-script"] !== undefined)) usage("--script and --judge-script are for the scripted fake. A live provider has no script.");
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
    if (!isLive && !existsSync(scriptFor(testCase))) usage(`No script found at ${scriptFor(testCase)}. Pass --script <file>.`);
  }
  const judgePath = values["judge-script"];
  if (judgePath !== undefined && !existsSync(judgePath)) usage(`No judge script found at ${judgePath}.`);
  if (!isLive && judgePath === undefined && loaded.some((l) => l.testCase.expected.some((e) => e.kind === "judged"))) {
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
  const { targetOrigin, site, external } = entries.length > 0 ? await resolveTarget(values.target, defects, config) : { targetOrigin: "", site: null, external: null };

  try {
    const parts = await providerParts(config);
    // A live judge is used only when some case has a judged expected result.
    const needsJudge = entries.some((e) => e.testCase.expected.some((x) => x.kind === "judged"));
    const liveJudge: JudgeClient | null = parts.live && needsJudge ? parts.live.newJudge() : null;
    if (parts.live) console.log(`Provider: ${describeProvider(config)}\n`);
    const { report } = await runBatch({
      order: casePaths,
      entries: entries.map((entry) => ({
        source: entry.path,
        testCase: entry.testCase,
        control: entry.control,
        // The canary cases use the same kind of model as the real run.
        modelFor: modelForCase(parts, (c) => ScriptedModelClient.fromFile(c.id === entry.testCase.id ? scriptFor(entry.testCase) : `tests/ci/scripts/${c.id}.json`)),
        ...(liveJudge ? { judge: liveJudge } : judgePath !== undefined ? { judge: ScriptedJudge.fromFile(judgePath) } : {}),
      })),
      invalid,
      targetOrigin,
      ...(external ? { target: { kind: external.kind, note: external.note }, canaryTargetOrigin: external.canaryTargetOrigin } : {}),
      config,
      // The fixture's credentials are fake. An external target gets none: a case that needs a secret is not run there.
      secrets: new StaticSecretStore(external ? {} : FIXTURE_SECRETS),
      provider: parts.provider,
      onPreflightPassed: printPreflight,
      onPreflightFailed: (preflight, message) => {
        printPreflight(preflight);
        console.error(message);
      },
      onPaused: (message) => console.error(message),
    });
    emit(report, config.runs.directory);
    // Every case file invalid is a usage error, not a refused run.
    return invalid.size === casePaths.length ? 64 : exitCodeFor(report);
  } finally {
    await site?.close();
  }
}

/**
 * The release report: a run report plus the register of quarantines and overrides and the inventory of P1 cases. It shows
 * whether the evidence for the release decision is complete. It does not decide. Exit code 0 when the evidence is complete, 2 when not.
 */
function releaseCommand(reportPath: string | undefined, values: { register?: string; "cases-dir"?: string; today?: string }): number {
  if (!reportPath) usage("Expected: release <report.json or report directory> [--register <file>] [--cases-dir <dir>] [--today YYYY-MM-DD]");
  const config = loadConfigIgnoringProvider();
  try {
    const file = existsSync(reportPath) && statSync(reportPath).isDirectory() ? join(reportPath, "report.json") : reportPath;
    if (!existsSync(file)) throw new ReleaseError(`there is no report at ${file}`);
    let rawReport: unknown;
    try {
      rawReport = JSON.parse(readTextCapped(file, READ_LIMITS.report, "the report"));
    } catch (error) {
      throw new ReleaseError(error instanceof TooLargeError ? error.message : `the report at ${file} is not valid JSON`);
    }
    const parsed = ReportSchema.safeParse(rawReport);
    if (!parsed.success) throw new ReleaseError(`the report at ${file} is not a valid report: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    const inventory = loadInventory(values["cases-dir"] ?? config.release.casesDirectory);
    const release = buildRelease({
      releaseId: newReleaseId(),
      generatedAt: new Date().toISOString(),
      today: values.today ?? new Date().toISOString().slice(0, 10),
      report: parsed.data,
      register: loadRegister(values.register ?? config.release.registerFile),
      inventory: inventory.entries,
      inventoryProblems: inventory.problems,
      approvers: config.release.approvers,
      decisionMaker: config.release.decisionMaker,
      // The report is checked against the run records it was made from, and an override's evidence has to exist.
      recordProblems: checkRecordsOnDisk(parsed.data),
      evidenceExists: (path) => existsSync(path),
    });
    const written = writeRelease(release, config.runs.directory);
    console.log(formatRelease(release));
    console.log(`Release report: ${written.json}`);
    return release.evidence.status === "complete" ? 0 : 2;
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(error.message);
      return 64;
    }
    throw error;
  }
}

/**
 * Frozen scripts. `freeze` writes a draft from run records, `approve` and `approve-proposal` are what a configured approver does
 * (nothing else makes a script runnable), and `run` replays an approved script with no model. A script that is not approved,
 * or whose file or case has changed, does not run, and the report lists the case as not executed.
 */
async function frozenCommand(action: string | undefined, args: string[], values: ProviderFlags & { by?: string; today?: string; case?: string; "proposal-script"?: string; defects?: string; target?: string }): Promise<number> {
  // Only a replay can use a live proposer. Freezing and approving do not touch a model, and must work whatever the provider settings are.
  const config = action === "run" ? configFor(values) : loadConfigIgnoringProvider();
  const today = values.today ?? new Date().toISOString().slice(0, 10);
  // The case file is found by its id in the cases folder, unless --case names it. The ids that reach here have been checked
  // against the case id pattern, so an id from a file cannot point somewhere else.
  const caseFileFor = (id: string) => values.case ?? join(config.release.casesDirectory, `${id}.yaml`);
  try {
    if (action === "freeze") {
      const [casePath, ...runPaths] = args;
      if (!casePath || runPaths.length === 0) return usage("Expected: frozen freeze <case.yaml> <run directory>...");
      const testCase = loadCase(casePath);
      const runs = runPaths.map((p) => {
        const loaded = loadRun(p);
        if (!("record" in loaded)) throw new FrozenError(`the run at ${p} could not be read: ${loaded.error}`);
        return loaded.record;
      });
      const result = exportScript({
        runs,
        testCase,
        caseHash: hashText(readFileSync(casePath, "utf8")),
        minPassingRuns: config.frozen.minPassingRuns,
        version: nextVersion(loadFrozenRegister(config.frozen.registerFile), testCase.id),
        now: new Date().toISOString(),
      });
      if (!result.ok) {
        console.error(`${testCase.id} was not frozen:\n${result.reasons.map((r) => `  - ${r}`).join("\n")}`);
        return 2;
      }
      const draft = writeDraft(config, result.script);
      console.log(`Draft script for ${testCase.id}, version ${result.script.version}: ${draft}`);
      console.log(`It cannot run yet. A person reads it, and an approver runs: node src/cli.ts frozen approve ${draft} --by <name>`);
      if (!result.script.source.live_model) console.log("Note: the proving runs used a scripted fake, not a language model. The script tests the machinery.");
      return 0;
    }
    if (action === "approve") {
      const [draftPath] = args;
      if (!draftPath) return usage("Expected: frozen approve <draft.json> --by <name>");
      const script = readFrozenScript(draftPath);
      const entry = approveScript({
        config,
        script,
        caseText: readFileSync(caseFileFor(script.case_id), "utf8"),
        by: values.by ?? "",
        today,
        reason: script.version === 1 ? "first freeze, approved by a person" : "changed script, approved by a person",
      });
      console.log(`Approved ${entry.case_id} version ${entry.version} as ${entry.file} (hash ${entry.script_hash.slice(0, 12)}) by ${entry.approved_by} on ${entry.approved_on}.`);
      return 0;
    }
    if (action === "approve-proposal") {
      const [proposalPath] = args;
      if (!proposalPath) return usage("Expected: frozen approve-proposal <proposal.json> --by <name>");
      const proposal = readProposal(proposalPath);
      const caseText = readFileSync(caseFileFor(proposal.case_id), "utf8");
      const entry = approveProposal({ config, proposal, caseText, stepsInCase: loadCase(caseFileFor(proposal.case_id)).steps.length, by: values.by ?? "", today });
      console.log(`Approved the proposal as ${entry.case_id} version ${entry.version}: ${entry.file} (hash ${entry.script_hash.slice(0, 12)}) by ${entry.approved_by}. Run the case again to see whether the new script holds.`);
      return 0;
    }
    if (action === "run") return await frozenRun(args[0], values, config);
  } catch (error) {
    if (error instanceof FrozenError) {
      console.error(error.message);
      return 3;
    }
    if (error instanceof CaseValidationError) {
      console.error(error.message);
      return 64;
    }
    throw error;
  }
  return usage("Expected: frozen freeze | approve | approve-proposal | run");
}

async function frozenRun(casePath: string | undefined, values: { "proposal-script"?: string; defects?: string; target?: string }, config: ReturnType<typeof loadConfig>): Promise<number> {
  if (!casePath) return usage("Expected: frozen run <case.yaml> [--proposal-script <file>] [--defects a,b]");
  const testCase = loadCase(casePath);
  const defects = (values.defects ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  try {
    assertKnownDefects(defects);
  } catch (error) {
    usage((error as Error).message);
  }
  const plan: PlanEntry = { id: testCase.id, source: casePath, title: testCase.title, priority: testCase.priority };
  let approved;
  try {
    approved = loadApprovedScript({ register: loadFrozenRegister(config.frozen.registerFile), caseId: testCase.id, caseText: readFileSync(casePath, "utf8"), stepsInCase: testCase.steps.length, scriptsDirectory: scriptsDirectory(config) });
  } catch (error) {
    if (!(error instanceof FrozenError)) throw error;
    // A script that must not run is reported as a case that did not run, like any other refusal.
    emit(buildReport({ reportId: newReportId(), generatedAt: new Date().toISOString(), plan: [{ ...plan, notRunReason: error.message }], runs: [] }), config.runs.directory);
    return 3;
  }
  const parts = await providerParts(config);
  // With a live provider, a step that cannot run is diagnosed by the live model, and a person still approves what it proposes.
  const proposer = values["proposal-script"] !== undefined ? ScriptedProposer.fromFile(values["proposal-script"]) : parts.live ? parts.live.newProposer() : undefined;
  const { targetOrigin, site } = await resolveTarget(values.target, defects);
  try {
    let runDir: string | null = null;
    let reason: string | null = null;
    try {
      const result = await orchestrateRun({
        testCase,
        caseSource: casePath,
        targetOrigin,
        config,
        secrets: new StaticSecretStore(FIXTURE_SECRETS),
        modelFor: (c) => (c.id === testCase.id ? new FrozenScriptModel(approved.script) : modelForCase(parts, (x) => ScriptedModelClient.fromFile(`tests/ci/scripts/${x.id}.json`))(c)),
        provider: parts.provider,
        killSwitch: new KillSwitch({ config, targetOrigin }),
        frozen: { script: approved.script, scriptHash: approved.scriptHash, caseHash: approved.caseHash, ...(proposer ? { proposer } : {}) },
      });
      runDir = result.runDir;
      printPreflight(result.preflight);
    } catch (error) {
      if (error instanceof PreflightFailedError) {
        printPreflight(error.report);
        reason = error.message;
      } else if (error instanceof RunnerPausedError) {
        reason = error.message;
      } else {
        throw error;
      }
    }
    if (reason !== null) console.error(reason);
    const report = buildReport({
      reportId: newReportId(),
      generatedAt: new Date().toISOString(),
      plan: [reason !== null ? { ...plan, notRunReason: reason } : plan],
      runs: runDir ? [loadRun(runDir)] : [],
    });
    emit(report, config.runs.directory);
    return exitCodeFor(report);
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
    emit(report, loadConfigIgnoringProvider().runs.directory);
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
      register: { type: "string" },
      "cases-dir": { type: "string" },
      today: { type: "string" },
      "proposal-script": { type: "string" },
      case: { type: "string" },
      out: { type: "string" },
      "for-resume": { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      model: { type: "string" },
      "judge-model": { type: "string" },
      "probe-context": { type: "boolean", default: false },
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
  if (command === "cases") return casesCommand(positionals.slice(1));
  if (command === "provider") return providerCommand(casePath, values);
  if (command === "kill-switch") return killSwitchCommand(casePath, values);
  if (command === "preflight") return preflightCommand(values);
  if (command === "eval") return evalCommand(casePath, values);
  if (command === "golden") return goldenCommand(casePath, values);
  if (command === "frozen") return frozenCommand(casePath, positionals.slice(2), values);
  if (command === "report") return reportCommand(positionals.slice(1), values);
  if (command === "release") return releaseCommand(casePath, values);
  if (command !== "run" || !casePath) usage("Expected: run <case.yaml>..., report, preflight, or kill-switch status|engage|resume");
  return runCommand(positionals.slice(1), values);
}

async function preflightCommand(values: ProviderFlags & { cases?: string; out?: string; target?: string; "for-resume"?: boolean }): Promise<number> {
  const config = configFor(values);
  const parts = await providerParts(config);
  const { targetOrigin, site } = await resolveTarget(values.target, []);
  try {
    const planned = (values.cases ?? "").split(",").map((c) => c.trim()).filter(Boolean).map((p) => loadCase(p));
    const report = await preflightFor({
      config,
      targetOrigin,
      secrets: new StaticSecretStore(FIXTURE_SECRETS),
      modelFor: modelForCase(parts, (c) => ScriptedModelClient.fromFile(`tests/ci/scripts/${c.id}.json`)),
      provider: parts.provider,
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
  const config = loadConfigIgnoringProvider(); // the suites run on the scripted model
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
  const config = loadConfigIgnoringProvider(); // the golden set runs on the scripted model
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
