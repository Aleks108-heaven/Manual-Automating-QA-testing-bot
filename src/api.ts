// The library entry point: the bot as a part of another application (an agent app, an MCP server, a script).
//
//   const bot = await QaBot.create();                       // live provider from config/default.json and QA_PROVIDER_* variables
//   const result = await bot.run({ target: "http://127.0.0.1:4173", cases: [{ object: myCaseObject }] });
//   result.report.summary.by_verdict, result.text, result.reportFile
//
// The host gives the bot cases and a target. It cannot change how a verdict is reached: the runner evaluates the expected
// results in code, the allowlist and the mutation rules live in the tool layer, and the pre-flight check and the kill switch
// apply to every run, exactly as on the command line. A host may bring its own model (`modelFor`), but its model is still
// only an actor: it reports observations, and the runner's own evidence decides.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runBatch } from "./batch.ts";
import { CaseValidationError, loadCase, parseCase, validateCase } from "./cases/load.ts";
import { negativeControl } from "./cases/mutate.ts";
import { loadConfig, type Config } from "./config.ts";
import type { JudgeClient } from "./judge/client.ts";
import type { ModelClient } from "./model/client.ts";
import { ScriptedProviderStatus, type ProviderStatus } from "./preflight/provider.ts";
import { createLiveProvider } from "./provider.ts";
import { formatReport } from "./report/format.ts";
import type { Report } from "./report/schema.ts";
import { writeReport } from "./report/write.ts";
import type { TestCase } from "./schemas/case.ts";
import { EnvSecretStore, type SecretStore } from "./secrets/store.ts";
import { assertFixtureTarget } from "./target.ts";

/** One case, given as a file, as YAML text, or as an object that is checked against the case schema before anything runs. */
export type CaseSource = { file: string } | { yaml: string; label?: string } | { object: unknown; label?: string };

export interface QaBotOptions {
  /** Defaults to config/default.json with the QA_* environment overrides. */
  config?: Config;
  /** Where the cases' secret references are resolved. Defaults to environment variables (QA_SECRET_*). */
  secrets?: SecretStore;
  /**
   * Where the model server's API key is read from (config.provider.apiKeySecret). It is a different store from the cases' secrets,
   * because the two have nothing to do with each other: a case's store holds the credentials of the application under test.
   * Defaults to environment variables (QA_SECRET_*).
   */
  providerSecrets?: SecretStore;
  /**
   * The host's own model. Without it the bot uses the live provider named in config.provider. The pre-flight provider check
   * then needs `provider` too, so that it checks the model that will really be used.
   */
  modelFor?: (testCase: TestCase) => ModelClient;
  judge?: JudgeClient;
  provider?: ProviderStatus;
}

export interface RunRequest {
  /** The fixture site's address. Any other target is refused. */
  target: string;
  cases: readonly CaseSource[];
  /** Run each case as its negative control: one expected result made wrong, so the bot must report FAIL. */
  negativeControl?: boolean;
}

export interface RunOutcome {
  report: Report;
  /** The same report as text, as it is stored in report.txt. */
  text: string;
  reportFile: string;
  /** Same meaning as the command line's exit code: 0 all PASS, 1 any FAIL, 2 anything else not verified, 3 nothing ran. */
  exitCode: number;
  /** The run folder of each case that ran, by case id. */
  runDirs: ReadonlyMap<string, string>;
}

export function exitCodeFor(report: Report): number {
  if (report.summary.executed === 0) return 3;
  if (report.summary.by_verdict.FAIL > 0) return 1;
  return report.summary.verified === report.summary.planned ? 0 : 2;
}

export interface CaseListing {
  id: string;
  title: string;
  priority: string;
  role: string;
  file: string;
  judged: boolean;
}

export class QaBot {
  readonly config: Config;
  private readonly secrets: SecretStore;
  private readonly modelFor: (testCase: TestCase) => ModelClient;
  private readonly judgeFor: (cases: readonly TestCase[]) => JudgeClient | undefined;
  private readonly provider: ProviderStatus;
  /** True when a live model (not a scripted fake) is behind the bot. */
  readonly live: boolean;

  private constructor(args: { config: Config; secrets: SecretStore; modelFor: QaBot["modelFor"]; judgeFor: QaBot["judgeFor"]; provider: ProviderStatus; live: boolean }) {
    this.config = args.config;
    this.secrets = args.secrets;
    this.modelFor = args.modelFor;
    this.judgeFor = args.judgeFor;
    this.provider = args.provider;
    this.live = args.live;
  }

  static async create(options: QaBotOptions = {}): Promise<QaBot> {
    const config = options.config ?? loadConfig();
    const secrets = options.secrets ?? new EnvSecretStore();
    if (options.modelFor) {
      const judge = options.judge;
      return new QaBot({ config, secrets, modelFor: options.modelFor, judgeFor: () => judge, provider: options.provider ?? new ScriptedProviderStatus(), live: false });
    }
    if (config.provider.kind === "scripted") {
      throw new Error("No model: config.provider.kind is scripted. Set QA_PROVIDER=openai-compatible with QA_PROVIDER_MODEL (see: node src/cli.ts provider models), or pass your own modelFor.");
    }
    const live = await createLiveProvider(config, { secrets: options.providerSecrets ?? new EnvSecretStore() });
    return new QaBot({
      config,
      secrets,
      modelFor: () => live.newModel(),
      // A live judge is used only for a batch with a judged expected result.
      judgeFor: (cases) => (options.judge ?? (cases.some((c) => c.expected.some((e) => e.kind === "judged")) ? live.newJudge() : undefined)),
      provider: options.provider ?? live.status,
      live: true,
    });
  }

  /** Checks a case given as an object, YAML text or file, and returns it. Throws CaseValidationError. */
  static loadCase(source: CaseSource): { source: string; testCase: TestCase } {
    if ("file" in source) return { source: source.file, testCase: loadCase(source.file) };
    if ("yaml" in source) return { source: source.label ?? "(yaml)", testCase: parseCase(source.yaml, source.label ?? "(yaml)") };
    return { source: source.label ?? "(object)", testCase: validateCase(source.object, source.label ?? "(object)") };
  }

  /** The case files in a folder (default: the configured cases folder). Files that do not validate are left out of the list and named in `invalid`. */
  listCases(directory: string = this.config.release.casesDirectory): { cases: CaseListing[]; invalid: Array<{ file: string; reason: string }> } {
    const cases: CaseListing[] = [];
    const invalid: Array<{ file: string; reason: string }> = [];
    if (!existsSync(directory)) return { cases, invalid };
    for (const name of readdirSync(directory).filter((n) => /\.ya?ml$/.test(n)).sort()) {
      const file = join(directory, name);
      try {
        const c = loadCase(file);
        cases.push({ id: c.id, title: c.title, priority: c.priority, role: c.role, file, judged: c.expected.some((e) => e.kind === "judged") });
      } catch (error) {
        if (!(error instanceof CaseValidationError)) throw error;
        invalid.push({ file, reason: error.message.replace(/\s*\n\s*/g, " ") });
      }
    }
    return { cases, invalid };
  }

  async run(request: RunRequest): Promise<RunOutcome> {
    const targetOrigin = await assertFixtureTarget(request.target);
    const order: string[] = [];
    const invalid = new Map<string, string>();
    const loaded: Array<{ source: string; testCase: TestCase; control: string | null }> = [];
    for (const [index, source] of request.cases.entries()) {
      let item: { source: string; testCase: TestCase };
      try {
        item = QaBot.loadCase(source);
      } catch (error) {
        if (!(error instanceof CaseValidationError)) throw error;
        // As on the command line, a case that does not validate counts as planned and not executed, and the rest of the batch runs.
        const label = `${error.source}#${index + 1}`;
        order.push(label);
        invalid.set(label, error.message.replace(/\s*\n\s*/g, " "));
        continue;
      }
      // The same source twice would make two cases indistinguishable in the report.
      const label = order.includes(item.source) ? `${item.source}#${index + 1}` : item.source;
      order.push(label);
      if (request.negativeControl) {
        const control = negativeControl(item.testCase);
        loaded.push({ source: label, testCase: control.testCase, control: `negative control: ${control.mutatedId} made wrong, expect FAIL` });
      } else {
        loaded.push({ source: label, testCase: item.testCase, control: null });
      }
    }
    const ids = loaded.map((l) => l.testCase.id);
    if (new Set(ids).size !== ids.length) throw new Error("Two of the cases have the same case id.");
    if (request.cases.length === 0) throw new Error("No cases were given.");

    const judge = this.judgeFor(loaded.map((l) => l.testCase));
    const { report, runDirs } = await runBatch({
      order,
      entries: loaded.map((l) => ({ source: l.source, testCase: l.testCase, control: l.control, modelFor: this.modelFor, ...(judge ? { judge } : {}) })),
      invalid,
      targetOrigin,
      config: this.config,
      secrets: this.secrets,
      provider: this.provider,
    });
    const written = writeReport(report, this.config.runs.directory);
    return { report, text: formatReport(report), reportFile: written.json, exitCode: exitCodeFor(report), runDirs };
  }
}
