// Runs one case end to end and writes the run record. This is the runner the CLI and the tests use.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentLoop, type LoopResult } from "../agent/loop.ts";
import type { Config } from "../config.ts";
import type { ModelClient } from "../model/client.ts";
import { FileEvidenceSink } from "../oracle/evidence.ts";
import type { Call, TestCase } from "../schemas/case.ts";
import { ActorOutputSchema, type ActorOutput } from "../schemas/actor.ts";
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

    if (infrastructureFailure === null) {
      tools = await ToolLayer.create({ targetOrigin, config, runDir });
      access = tools.runnerAccess();
      sink = new FileEvidenceSink(runDir, access);
      loop = await runAgentLoop({ testCase, model, tools, access, config, evidence: sink });

      if (loop.runnerStop === null && !loop.guardrailBlock) {
        const raw = await model.finalOutput({ testCase, actorStop: loop.actorStop });
        const parsed = ActorOutputSchema.safeParse(raw);
        if (!parsed.success) {
          fail(`the actor output is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        } else if ((parsed.data.stop_reason ?? null) !== (loop.actorStop?.reason ?? null)) {
          fail("the actor output disagrees with how the run ended");
        } else {
          output = parsed.data;
        }
      }
    }
  } catch (error) {
    runnerStopOverride = "crash";
    fail(`the runner crashed: ${(error as Error).message}`);
  } finally {
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
    await tools?.close();
  }

  const outcomes = loop?.outcomes ?? [];
  const runState = {
    actor_stop_reason: loop?.actorStop?.reason ?? null,
    runner_stop_reason: runnerStopOverride ?? loop?.runnerStop ?? null,
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
    schema_version: 0,
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
    run_state: runState,
    verdict,
    verdict_row: row,
  });
  writeFileSync(join(runDir, "run.json"), JSON.stringify(record, null, 2));
  return { record, runDir };
}
