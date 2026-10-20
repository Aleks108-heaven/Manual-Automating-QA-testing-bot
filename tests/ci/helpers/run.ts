import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../../src/config.ts";
import { ScriptedModelClient, type Script } from "../../../src/model/scripted.ts";
import { runCase, type BuildProbe, type RunResult } from "../../../src/runner/run-case.ts";
import type { SecretStore } from "../../../src/secrets/store.ts";
import type { TestCase } from "../../../src/schemas/case.ts";
import type { FixtureSite } from "../../../fixtures/site/server.ts";

export function testConfig(change: (c: Config) => void = () => undefined): Config {
  const config = loadConfig();
  config.runs.directory = mkdtempSync(join(tmpdir(), "qa-bot-runs-"));
  // Keep the suite quick: the fixture answers in milliseconds, and a MISMATCH waits out the whole timeout.
  config.oracle.assertionTimeoutMs = 1000;
  change(config);
  return config;
}

export async function runScripted(options: {
  site: FixtureSite;
  testCase: TestCase;
  script: string | Script;
  config?: Config;
  buildProbe?: BuildProbe;
  secrets?: SecretStore;
}): Promise<RunResult> {
  const model = typeof options.script === "string" ? ScriptedModelClient.fromFile(options.script) : new ScriptedModelClient(options.script);
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
