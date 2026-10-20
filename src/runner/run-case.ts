// Runs one case end to end and writes the run record. This is the runner the CLI and the tests use.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetGuard, type BudgetStop } from "../agent/budget.ts";
import { runAgentLoop, type LoopResult } from "../agent/loop.ts";
import { requestFinalOutput } from "./final-output.ts";
import type { Config } from "../config.ts";
import type { ModelClient } from "../model/client.ts";
import { FileEvidenceSink } from "../oracle/evidence.ts";
import { Redactor } from "../redact/redactor.ts";
import { scanArtifacts, type Finding } from "../redact/scan.ts";
import { EnvSecretStore, parseSecretRef, type SecretStore } from "../secrets/store.ts";
import { establishSession, SessionError, type EstablishedSession } from "../sessions/session-setup.ts";
import type { Call, TestCase } from "../schemas/case.ts";
import type { ActorOutput } from "../schemas/actor.ts";
import { RunRecordSchema, type RunRecord } from "../schemas/run-record.ts";
import { ToolLayer, type RunnerAccess } from "../tools/tool-layer.ts";
import { calculateVerdict } from "../verdict/calculate.ts";

export interface HealthProbe {
  /** False when the target has no health endpoint or it did not answer. */
  ok: boolean;
  build: string | null;
}

export type BuildProbe = (origin: string) => Promise<HealthProbe>;

/** Reads GET /health and the x-build header. Targets without a health endpoint give ok: false. */
export const defaultBuildProbe: BuildProbe = async (origin) => {
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    return { ok: response.ok, build: response.headers.get("x-build") };
  } catch {
    return { ok: false, build: null };
  }
};

export interface RunOptions {
  testCase: TestCase;
  caseSource: string;
  targetOrigin: string;
  model: ModelClient;
  config: Config;
  buildProbe?: BuildProbe;
  /** Where secrets come from. Defaults to environment variables. */
  secrets?: SecretStore;
}

export interface RunResult {
  record: RunRecord;
  runDir: string;
}

async function callTestApi(origin: string, call: Call, headers: Record<string, string>): Promise<void> {
  const [method, path] = call.call.split(" ") as [string, string];
  const response = await fetch(origin + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(call.body && method !== "GET" ? { body: JSON.stringify(call.body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${call.call} answered ${response.status}`);
}

function sha256(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

function readVersion(path: string): string {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function newRunId(caseId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return `${stamp}-${caseId}-${randomBytes(2).toString("hex")}`;
}

export async function runCase(options: RunOptions): Promise<RunResult> {
  const { testCase, config, model, targetOrigin } = options;
  const probe = options.buildProbe ?? defaultBuildProbe;
  const runId = newRunId(testCase.id);
  const runDir = join(config.runs.directory, runId);
  mkdirSync(runDir, { recursive: true });
  const startedAt = new Date().toISOString();

  let infrastructureFailure: string | null = null;
  let runnerStopOverride: "crash" | null = null;
  const cleanupErrors: string[] = [];
  let loop: LoopResult | null = null;
  let output: ActorOutput | null = null;
  let tools: ToolLayer | null = null;
  let access: RunnerAccess | null = null;
  let sink: FileEvidenceSink | null = null;
  let session: EstablishedSession | null = null;
  const redactor = new Redactor();
  // One budget for the whole run: the agent loop, the final report and, later, the judge spend from it.
  const guard = new BudgetGuard(config.budgets, config.pricing);
  let finalBudgetStop: BudgetStop | null = null;
  let blocked: RunRecord["blocked"] = null;
  let modelOutput: { attempts: number; valid: boolean; errors: string[] } = { attempts: 0, valid: false, errors: [] };
  // The raw HAR holds cookies and request bodies. It lives here, outside the run directory, until it is scrubbed.
  const harScratchDir = join(config.sessions.directory, `${runId}-har`);

  const before = await probe(targetOrigin);
  const fail = (message: string) => {
    infrastructureFailure ??= message;
  };

  try {
    for (const call of testCase.setup) {
      try {
        await callTestApi(targetOrigin, call, config.testApi.headers);
      } catch (error) {
        fail(`setup failed: ${(error as Error).message}`);
        break;
      }
    }

    // Every secret the case declares is protected from the start, before anything can echo it.
    const secrets = options.secrets ?? new EnvSecretStore();
    const secretValues: Record<string, string> = {};
    if (infrastructureFailure === null) {
      for (const [key, ref] of Object.entries(testCase.data)) {
        const name = parseSecretRef(ref);
        if (!name) continue;
        try {
          const value = await secrets.get(name);
          redactor.add(value, `data.${key}`);
          secretValues[key] = value;
        } catch (error) {
          fail(`secret unavailable: ${(error as Error).message}`);
          break;
        }
      }
    }

    if (infrastructureFailure === null) {
      try {
        session = await establishSession({ role: testCase.role, config, secrets, targetOrigin, runId, runDir, redactor });
      } catch (error) {
        if (!(error instanceof SessionError)) throw error;
        fail(`session setup failed: ${error.message}`);
      }
    }

    if (infrastructureFailure === null && session) {
      tools = await ToolLayer.create({
        targetOrigin,
        config,
        runDir,
        redactor,
        caseData: testCase.data,
        secretValues,
        harPath: join(runDir, "network.har"),
        harScratchDir,
        ...(session.storageStatePath ? { storageStatePath: session.storageStatePath } : {}),
      });
      access = tools.runnerAccess();
      sink = new FileEvidenceSink(runDir, access, redactor);
      loop = await runAgentLoop({
        testCase,
        model,
        tools,
        access,
        config,
        evidence: sink,
        redactor,
        guard,
        transcript: (entry) => appendFileSync(join(runDir, "model-context.jsonl"), `${JSON.stringify(entry)}\n`),
      });

      // A BLOCKED run needs the step, the reason and a screenshot (manual: Definitions). The runner takes the
      // screenshot at the moment of the stop, so it does not depend on what the model reports.
      if (loop.actorStop) {
        const { step, reason } = loop.actorStop;
        const lastFailure = [...(loop.steps[step - 1]?.actions ?? [])].reverse().find((a) => !a.ok);
        const refs = await sink.capture(`blocked-step${step}`, step);
        blocked = {
          step,
          step_text: loop.steps[step - 1]?.text ?? "",
          reason,
          source: loop.stopSource ?? "actor",
          tool_error: lastFailure?.error ? redactor.scrubText(lastFailure.error) : null,
          evidence: refs.map((r) => r.id),
        };
      }

      // A stop decided by the runner (the loop detector) leaves nothing for the model to report.
      if (loop.runnerStop === null && !loop.guardrailBlock && loop.stopSource !== "runner") {
        const final = await requestFinalOutput({ model, testCase, actorStop: loop.actorStop, guard, config, redactor });
        modelOutput = { attempts: final.attempts, valid: final.output !== null, errors: final.errors };
        output = final.output;
        if (final.budgetStop) finalBudgetStop = final.budgetStop;
        else if (!output) fail(`the model's final report stayed invalid after ${final.attempts} attempts (${final.errors[final.errors.length - 1] ?? "no detail"})`);
      }
    }
  } catch (error) {
    runnerStopOverride = "crash";
    fail(`the runner crashed: ${(error as Error).message}`);
  } finally {
    const unanswered = access?.infrastructureFailures() ?? [];
    if (unanswered.length > 0) fail(`the target did not answer: ${unanswered[0]}${unanswered.length > 1 ? ` (and ${unanswered.length - 1} more)` : ""}`);
    const after = await probe(targetOrigin);
    if (before.ok && !after.ok) fail("the health check was failing at the end of the run");
    else if (before.ok && after.ok && before.build !== after.build) fail(`the build changed mid-run (${before.build} to ${after.build})`);

    for (const call of testCase.teardown) {
      try {
        await callTestApi(targetOrigin, call, config.testApi.headers);
      } catch (error) {
        cleanupErrors.push(`teardown failed: ${(error as Error).message}`);
      }
    }
    await tools?.close(); // this scrubs the HAR into the run directory
    rmSync(harScratchDir, { recursive: true, force: true });
    session?.cleanup();
  }

  // The last line of defense: look for any secret or credential header in everything the run stored.
  // A finding means the scrubber has a defect. The offending files are scrubbed or deleted, and the run
  // is INCONCLUSIVE, so a person looks at it.
  const scan = scanArtifacts(runDir, redactor);
  if (scan.findings.length > 0) {
    cleanFindings(runDir, scan.findings, redactor);
    fail(`a credential was found in stored artifacts (${[...new Set(scan.findings.map((f) => f.label))].join(", ")}). This is a scrubber defect. The files were cleaned.`);
  }

  const outcomes = loop?.outcomes ?? [];
  const runState = {
    actor_stop_reason: loop?.actorStop?.reason ?? null,
    stop_source: loop?.stopSource ?? null,
    runner_stop_reason: runnerStopOverride ?? loop?.runnerStop ?? finalBudgetStop?.reason ?? null,
    infrastructure_failure: infrastructureFailure,
    guardrail_block: loop?.guardrailBlock ?? false,
    injection_suspected: output?.injection_suspected ?? false,
  };
  const { verdict, row } = calculateVerdict({
    expectedCount: testCase.expected.length,
    outcomes: outcomes.map((o) => ({ expected_ref: o.expected_ref, outcome: o.outcome })),
    runState: {
      infrastructureFailure: runState.infrastructure_failure,
      guardrailBlock: runState.guardrail_block,
      actorStopReason: runState.actor_stop_reason,
      runnerStopReason: runState.runner_stop_reason,
    },
  });

  const record: RunRecord = RunRecordSchema.parse({
    schema_version: 2,
    run_id: runId,
    case: { id: testCase.id, title: testCase.title, priority: testCase.priority, source: options.caseSource },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    target: targetOrigin,
    versions: {
      bot: readVersion("package.json"),
      node: process.version,
      playwright: readVersion("node_modules/playwright/package.json"),
      browser: access?.browserVersion ?? "not started",
      browser_sandbox: access?.browserSandbox ?? config.browser.sandbox,
      model_client: model.name,
      prompt_hashes: Object.fromEntries(
        ["actor.v1.md", "judge.v1.md"].flatMap((f) => {
          const h = sha256(join("prompts", f));
          return h ? [[f, h]] : [];
        }),
      ),
      build: before.build,
    },
    steps: loop?.steps ?? [],
    observations: output?.observations ?? [],
    outcomes,
    evidence: [...(sink?.all() ?? [])],
    guardrail_events: access ? [...access.guardrails.events] : [],
    cleanup_errors: cleanupErrors,
    session: { role: testCase.role, mode: config.sessions.mode, established: session !== null },
    budget: {
      limits: {
        max_tool_calls_per_run: config.budgets.maxToolCallsPerRun,
        max_tool_calls_per_step: config.budgets.maxToolCallsPerStep,
        max_wall_ms: config.budgets.maxWallMs,
        max_cost_usd: config.budgets.maxCostUsd,
      },
      used: loop ? guard.snapshot() : { tool_calls: 0, wall_ms: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 },
      stop: loop?.budgetStop ?? finalBudgetStop ?? null,
    },
    blocked,
    model_output: modelOutput,
    redaction: { secrets_tracked: redactor.secretCount, replacements: redactor.replacements },
    artifact_scan: { files_scanned: scan.filesScanned, findings: scan.findings.length, cleaned: scan.findings.length > 0 },
    artifacts: {
      har: existsSync(join(runDir, "network.har")) ? "network.har" : null,
      model_context: existsSync(join(runDir, "model-context.jsonl")) ? "model-context.jsonl" : null,
    },
    run_state: runState,
    verdict,
    verdict_row: row,
  });
  writeFileSync(join(runDir, "run.json"), JSON.stringify(redactor.scrubJson(record), null, 2));
  const final = scanArtifacts(runDir, redactor);
  if (final.findings.length > 0) throw new Error(`a credential is still present in the stored run after cleaning (${final.findings.map((f) => `${f.file}: ${f.label}`).join("; ")})`);
  return { record, runDir };
}

/** Scrubs text files that contain a secret, and deletes any other file that does. */
function cleanFindings(runDir: string, findings: readonly Finding[], redactor: Redactor): void {
  for (const file of new Set(findings.map((f) => f.file))) {
    const path = join(runDir, file);
    if (/\.(json|jsonl|har|txt|log|md|html|csv)$/i.test(file)) {
      writeFileSync(path, redactor.scrubText(readFileSync(path, "utf8")));
    } else {
      rmSync(path, { force: true });
    }
  }
}
