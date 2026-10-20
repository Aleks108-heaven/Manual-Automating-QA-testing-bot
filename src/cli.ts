// Command-line entry point. In M1 it runs one case against the local fixture site with a scripted
// fake model, so no API key and no cost are involved.
//
//   node src/cli.ts run cases/TC-FORM-001.yaml [--script <file>] [--defects a,b]
//                        [--negative-control] [--mutate <expected id>] [--target <url>]
//
// Exit codes: 0 PASS, 1 FAIL, 2 any other verdict (BLOCKED, INCONCLUSIVE, INCOMPLETE), 64 usage error.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CaseValidationError, loadCase } from "./cases/load.ts";
import { negativeControl } from "./cases/mutate.ts";
import { loadConfig } from "./config.ts";
import { ScriptedModelClient } from "./model/scripted.ts";
import { runCase } from "./runner/run-case.ts";
import { StaticSecretStore } from "./secrets/store.ts";
import { FIXTURE_SECRETS } from "../fixtures/secrets.ts";
import type { RunRecord } from "./schemas/run-record.ts";
import { assertKnownDefects, startFixtureSite, type FixtureSite } from "../fixtures/site/server.ts";

const USAGE = `Usage: node src/cli.ts run <case.yaml> [options]

Options:
  --script <file>        Scripted model actions (default: tests/ci/scripts/<case id>.json)
  --defects a,b          Turn on fixture defects: lockout-off-by-one, email-check-missing, wrong-email-message
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

function printSummary(record: RunRecord, runDir: string, note: string | null): void {
  const line = (text = "") => console.log(text);
  line(`Case     ${record.case.id}  ${record.case.title}  (${record.case.priority})${note ? `  [${note}]` : ""}`);
  line(`Run      ${record.run_id}`);
  line(`Target   ${record.target}  build ${record.versions.build ?? "unknown"}`);
  line(`Versions model client ${record.versions.model_client}, Playwright ${record.versions.playwright}, browser ${record.versions.browser}`);
  if (!record.versions.browser_sandbox) line("WARNING  the browser sandbox was OFF for this run. Use that only inside an isolating container.");
  const b = record.budget;
  line(`Budget   ${b.used.tool_calls} of ${b.limits.max_tool_calls_per_run} tool calls, ${(b.used.wall_ms / 1000).toFixed(1)} s of ${b.limits.max_wall_ms / 1000} s, cost ${b.used.cost_usd.toFixed(4)} of ${b.limits.max_cost_usd} USD`);
  line(`Session  role ${record.session.role}${record.session.role === "none" ? " (no login)" : ", signed in by the runner"}`);
  line(`Secrets  ${record.redaction.secrets_tracked} tracked, ${record.redaction.replacements} replacements, artifact scan ${record.artifact_scan.findings === 0 ? "clean" : `FOUND ${record.artifact_scan.findings} (cleaned)`} over ${record.artifact_scan.files_scanned} files`);
  line();
  line(`Verdict: ${record.verdict}  (precedence row ${record.verdict_row})`);
  for (const o of record.outcomes) {
    line(`  ${o.expected_ref.padEnd(4)} ${o.outcome.padEnd(11)} ${o.expected}${o.outcome === "MATCH" ? "" : `   actual: ${o.actual ?? "n/a"}`}`);
  }
  if (record.outcomes.length === 0) line("  (no expected result was evaluated)");
  if (record.run_state.actor_stop_reason) line(`  Stopped: ${record.run_state.stop_source === "runner" ? "the runner's loop detection" : "the actor"} reported ${record.run_state.actor_stop_reason}`);
  if (record.run_state.runner_stop_reason) line(`  Stopped: the runner reported ${record.run_state.runner_stop_reason}${record.budget.stop ? ` (${record.budget.stop.detail})` : ""}`);
  if (record.run_state.infrastructure_failure) line(`  Infrastructure: ${record.run_state.infrastructure_failure}`);
  for (const e of record.guardrail_events.filter((g) => g.decision === "blocked")) line(`  Guardrail blocked ${e.type}: ${e.url} (${e.detail})`);
  for (const c of record.cleanup_errors) line(`  Cleanup: ${c}`);
  line();
  const notVerified = record.verdict === "PASS" ? 0 : 1;
  line(`Summary: bot executed 1 of 1 planned cases, ${notVerified} not verified.`);
  line(`Record:  ${join(runDir, "run.json")}`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      script: { type: "string" },
      defects: { type: "string" },
      "negative-control": { type: "boolean", default: false },
      mutate: { type: "string" },
      target: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) usage();
  const [command, casePath] = positionals;
  if (command !== "run" || !casePath) usage("Expected: run <case.yaml>");

  let testCase;
  try {
    testCase = loadCase(casePath);
  } catch (error) {
    if (error instanceof CaseValidationError) {
      console.error(error.message);
      return 64;
    }
    throw error;
  }

  const scriptPath = values.script ?? `tests/ci/scripts/${testCase.id}.json`;
  if (!existsSync(scriptPath)) usage(`No script found at ${scriptPath}. Pass --script <file>.`);

  let note: string | null = null;
  if (values["negative-control"]) {
    const control = negativeControl(testCase, values.mutate);
    testCase = control.testCase;
    note = `negative control: ${control.mutatedId} made wrong, expect FAIL`;
  }

  const defects = (values.defects ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  try {
    assertKnownDefects(defects);
  } catch (error) {
    usage((error as Error).message);
  }
  // Until M5 passes and the security review is done, the only allowed target is the local fixture site.
  if (values.target && !isLoopback(values.target)) usage("In M1 the target must be the local fixture site (a loopback address). See CLAUDE.md.");

  let site: FixtureSite | null = null;
  let targetOrigin: string;
  if (values.target) {
    targetOrigin = new URL(values.target).origin;
    // A loopback address is not enough: another local service (an admin panel, a database UI) is not the fixture.
    const health = await fetch(`${targetOrigin}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<{ build?: string }>, () => null);
    if (!health || typeof health.build !== "string" || !health.build.startsWith("fixture-")) {
      usage(`${targetOrigin} does not identify itself as the fixture site (GET /health must report a build starting with "fixture-").`);
    }
    if (defects.length > 0) {
      const config = loadConfig();
      await fetch(`${targetOrigin}/__test/defects`, {
        method: "POST",
        headers: { "content-type": "application/json", ...config.testApi.headers },
        body: JSON.stringify({ defects }),
      });
    }
  } else {
    site = await startFixtureSite({ defects });
    targetOrigin = site.origin;
  }

  try {
    const config = loadConfig();
    const { record, runDir } = await runCase({
      testCase,
      caseSource: casePath,
      targetOrigin,
      model: ScriptedModelClient.fromFile(scriptPath),
      config,
      // In M1 and M2 the only valid target is the fixture site, whose credentials are fake.
      secrets: new StaticSecretStore(FIXTURE_SECRETS),
    });
    printSummary(record, runDir, note);
    return record.verdict === "PASS" ? 0 : record.verdict === "FAIL" ? 1 : 2;
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
