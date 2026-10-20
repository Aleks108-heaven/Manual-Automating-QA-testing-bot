import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../../src/config.ts";
import type { FinalContext, ModelAction, ModelClient, ModelContext, ModelUsage } from "../../../src/model/client.ts";
import { ScriptedModelClient, type Script } from "../../../src/model/scripted.ts";
import { runCase, type BuildProbe, type RunResult } from "../../../src/runner/run-case.ts";
import type { SecretStore } from "../../../src/secrets/store.ts";
import type { TestCase } from "../../../src/schemas/case.ts";
import type { FixtureSite } from "../../../fixtures/site/server.ts";

export function testConfig(change: (c: Config) => void = () => undefined): Config {
  const config = loadConfig();
  config.runs.directory = mkdtempSync(join(tmpdir(), "qa-bot-runs-"));
  // A private folder per test for session files and the raw HAR, never inside the runs directory.
  config.sessions.directory = mkdtempSync(join(tmpdir(), "qa-bot-sessions-"));
  // Keep the suite quick: the fixture answers in milliseconds, and a MISMATCH waits out the whole timeout.
  config.oracle.assertionTimeoutMs = 1000;
  change(config);
  return config;
}

/** Wraps a model and keeps a copy of everything the loop hands to it, which is everything the model is shown. */
export class RecordingModel implements ModelClient {
  readonly name: string;
  readonly seen: string[] = [];
  private readonly inner: ModelClient;
  constructor(inner: ModelClient) {
    this.inner = inner;
    this.name = inner.name;
  }
  async nextAction(context: ModelContext): Promise<ModelAction> {
    this.seen.push(JSON.stringify(context));
    return this.inner.nextAction(context);
  }
  async finalOutput(context: FinalContext): Promise<unknown> {
    this.seen.push(JSON.stringify(context));
    return this.inner.finalOutput(context);
  }
  consumeUsage(): ModelUsage | undefined {
    return this.inner.consumeUsage?.();
  }
}

export async function runScripted(options: {
  site: FixtureSite;
  testCase: TestCase;
  script: string | Script;
  config?: Config;
  buildProbe?: BuildProbe;
  secrets?: SecretStore;
  /** Use this model instead of building one from `script`. */
  model?: ModelClient;
}): Promise<RunResult> {
  const model = options.model ?? (typeof options.script === "string" ? ScriptedModelClient.fromFile(options.script) : new ScriptedModelClient(options.script));
  return runCase({
    testCase: options.testCase,
    caseSource: "test",
    targetOrigin: options.site.origin,
    model,
    config: options.config ?? testConfig(),
    ...(options.buildProbe ? { buildProbe: options.buildProbe } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  });
}
