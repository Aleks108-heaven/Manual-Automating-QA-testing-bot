// Command-line entry point. It runs cases against the local fixture site with a scripted fake model, so no API
// key and no cost are involved.
//
//   node src/cli.ts run cases/TC-FORM-001.yaml [--script <file>] [--defects a,b]
//                        [--negative-control] [--mutate <expected id>] [--target <url>]
//   node src/cli.ts preflight [--cases a.yaml,b.yaml] [--out <file>] [--target <url>]
//   node src/cli.ts kill-switch status | engage | resume
//
// Every run starts with the pre-flight check and refuses to start if the kill switch is engaged.
// Exit codes: 0 PASS, 1 FAIL, 2 any other verdict (BLOCKED, INCONCLUSIVE, INCOMPLETE), 3 the run was refused
// (kill switch engaged, or a pre-flight check failed), 64 usage error, 70 unexpected error.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CaseValidationError, loadCase } from "./cases/load.ts";
import { negativeControl } from "./cases/mutate.ts";
import { loadConfig } from "./config.ts";
import { ScriptedJudge } from "./judge/scripted.ts";
import { ScriptedModelClient } from "./model/scripted.ts";
import { KillSwitch, KillSwitchError, RunnerPausedError } from "./ops/kill-switch.ts";
import { failedChecks } from "./preflight/preflight.ts";
import { ScriptedProviderStatus } from "./preflight/provider.ts";
import type { PreflightReport } from "./preflight/report.ts";
import { orchestrateRun, PreflightFailedError, preflightFor } from "./runner/orchestrate.ts";
import { StaticSecretStore } from "./secrets/store.ts";
import { FIXTURE_SECRETS } from "../fixtures/secrets.ts";
import type { RunRecord } from "./schemas/run-record.ts";
import { assertKnownDefects, startFixtureSite, type FixtureSite } from "../fixtures/site/server.ts";

const USAGE = `Usage: node src/cli.ts run <case.yaml> [options]
       node src/cli.ts preflight [--cases a.yaml,b.yaml] [--out <file>] [--for-resume]
       node src/cli.ts kill-switch status
       node src/cli.ts kill-switch engage --by <name> --reason <text>
       node src/cli.ts kill-switch resume --by <name> --review <ref> --fix <ref> --preflight-report <file>

Options:
  --script <file>        Scripted model actions (default: tests/ci/scripts/<case id>.json)
  --judge-script <file>  Scripted judge answers, for cases with judged expected results
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

async function killSwitchCommand(action: string | undefined, v: { by?: string; reason?: string; review?: string; fix?: string; "preflight-report"?: string; target?: string }): Promise<number> {
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
      await ks.resume({ by: v.by ?? "", review: v.review ?? "", fix: v.fix ?? "", preflightReport: v["preflight-report"] ?? "" });
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
  if (record.blocked) {
    const shot = record.evidence.find((e) => e.id === record.blocked?.evidence.find((id) => id.endsWith("-screenshot")));
    line(`  Blocked at step ${record.blocked.step} (${record.blocked.reason}): ${record.blocked.step_text}`);
    if (record.blocked.tool_error) line(`    last tool error: ${record.blocked.tool_error}`);
    if (shot) line(`    screenshot: ${join(runDir, shot.path)}`);
  }
  if (record.run_state.actor_stop_reason) line(`  Stopped: ${record.run_state.stop_source === "runner" ? "the runner's loop detection" : "the actor"} reported ${record.run_state.actor_stop_reason}`);
  if (record.run_state.runner_stop_reason) line(`  Stopped: the runner reported ${record.run_state.runner_stop_reason}${record.budget.stop ? ` (${record.budget.stop.detail})` : ""}`);
  if (record.run_state.infrastructure_failure) line(`  Infrastructure: ${record.run_state.infrastructure_failure}`);
  for (const e of record.guardrail_events.filter((g) => g.decision === "blocked")) line(`  Guardrail blocked ${e.type}: ${e.url} (${e.detail})`);
  for (const c of record.cleanup_errors) line(`  Cleanup: ${c}`);
  if (record.model_output.attempts > 1 || !record.model_output.valid) {
    line(`  Model report: ${record.model_output.valid ? "accepted" : "rejected"} after ${record.model_output.attempts} attempt(s)${record.model_output.errors.length ? ` (${record.model_output.errors[record.model_output.errors.length - 1]})` : ""}`);
  }
  if (record.judge.configured) {
    line(`  Judge: ${record.judge.name}, ${record.judge.calls} call(s), ${record.judge.attempts} attempt(s)${record.judge.injection_reports ? `, ${record.judge.injection_reports} injection report(s)` : ""}`);
  }
  if (record.run_state.injection_suspected) line("  ALERT: an attempt to influence the bot was reported. The security reviewer should look at this run.");
  const imp = record.implicit;
  if (imp.enabled) {
    const total = imp.findings.length;
    line(`  Implicit checks: ${total} finding(s)${total ? ` (console ${imp.counts.console_error}, HTTP ${imp.counts.http_error}, failed requests ${imp.counts.failed_request}, images ${imp.counts.broken_image}, accessibility ${imp.counts.accessibility})` : ""}. Reported only: they do not change the verdict.`);
    for (const f of imp.findings.slice(0, 8)) line(`    - [${f.kind}${f.rule ? ` ${f.rule}` : ""}${f.impact ? `, ${f.impact}` : ""}] ${f.detail}${f.count > 1 ? ` (x${f.count})` : ""}`);
    if (total > 8) line(`    ... and ${total - 8} more in run.json${imp.truncated ? " (the list was capped)" : ""}`);
  }
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
      cases: { type: "string" },
      out: { type: "string" },
      "for-resume": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) usage();
  const [command, casePath] = positionals;
  if (command === "kill-switch") return killSwitchCommand(casePath, values);
  if (command === "preflight") return preflightCommand(values);
  if (command !== "run" || !casePath) usage("Expected: run <case.yaml>, preflight, or kill-switch status|engage|resume");

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
  const judgePath = values["judge-script"];
  if (judgePath !== undefined && !existsSync(judgePath)) usage(`No judge script found at ${judgePath}.`);
  const hasJudged = testCase.expected.some((e) => e.kind === "judged");
  if (hasJudged && judgePath === undefined) {
    console.error("Note: this case has judged expected results and no --judge-script was given, so they will get NO_EVIDENCE and the run will be INCONCLUSIVE.\n");
  }

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
  const { targetOrigin, site } = await resolveTarget(values.target, defects);

  try {
    const config = loadConfig();
    const planned = testCase;
    const { record, runDir, preflight } = await orchestrateRun({
      testCase: planned,
      caseSource: casePath,
      targetOrigin,
      config,
      // The only valid target is the fixture site, whose credentials are fake.
      secrets: new StaticSecretStore(FIXTURE_SECRETS),
      // The canary cases use the same kind of model as the real run.
      modelFor: (c) => ScriptedModelClient.fromFile(c.id === planned.id ? scriptPath : `tests/ci/scripts/${c.id}.json`),
      ...(judgePath !== undefined ? { judge: ScriptedJudge.fromFile(judgePath) } : {}),
      provider: new ScriptedProviderStatus(),
      killSwitch: new KillSwitch({ config, targetOrigin }),
    });
    printPreflight(preflight);
    printSummary(record, runDir, note);
    return record.verdict === "PASS" ? 0 : record.verdict === "FAIL" ? 1 : 2;
  } catch (error) {
    if (error instanceof PreflightFailedError) {
      printPreflight(error.report);
      console.error(error.message);
      return 3;
    }
    if (error instanceof RunnerPausedError) {
      console.error(error.message);
      return 3;
    }
    throw error;
  } finally {
    await site?.close();
  }
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

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(70);
  },
);
