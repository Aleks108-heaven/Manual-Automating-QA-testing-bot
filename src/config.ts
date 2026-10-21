import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import { CallSchema } from "./schemas/case.ts";
import { isValidDeclaration } from "./tools/mutations.ts";

// Every value the manual marks [to fill] is read from here, never hard-coded elsewhere.
const ConfigSchema = z.strictObject({
  _comment: z.string().optional(),
  allowlist: z.strictObject({
    hosts: z.array(z.string()),
    schemes: z.array(z.string()).min(1),
  }),
  budgets: z.strictObject({
    maxToolCallsPerRun: z.number().int().min(1),
    maxToolCallsPerStep: z.number().int().min(1),
    // Wall-clock time for the agent loop, in milliseconds.
    maxWallMs: z.number().int().min(100),
    // Cost of the model calls in one run, in US dollars, from the usage the model client reports.
    maxCostUsd: z.number().min(0),
  }),
  // Price per million tokens. Fixture placeholders: the real values depend on the provider, which is still [to fill].
  pricing: z.strictObject({ inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) }),
  // The pre-flight check (manual: Running tests). Every run starts with it, and a failed check stops the run.
  preflight: z.strictObject({
    // The target must answer GET /health. If false, that check is skipped (and a skipped check is reported as skipped).
    requireHealthEndpoint: z.boolean(),
    // The build the target must report. null means no particular build is required.
    expectedBuild: z.string().min(1).nullable(),
    // The provider must report at least this much spend allowance left, in US dollars.
    minQuotaUsd: z.number().min(0),
    // When true, the runner must be the pinned container image: QA_RUNNER_IMAGE_DIGEST must equal the Dockerfile's digest.
    requireContainer: z.boolean(),
    // When true, at least one canary case must be configured and must behave.
    requireCanaries: z.boolean(),
    // Cases run as a known-good pair: the case must PASS, and its negative control must FAIL.
    canaryCases: z.array(z.string().min(1)),
    dockerfile: z.string().min(1),
    // Read from QA_RUNNER_IMAGE_DIGEST. The container run script sets it.
    runnerImageDigest: z.string().nullable(),
  }),
  // The kill switch (manual: Roles and decision rights, "Kill switch"). ${RUNS} stands for the runs directory.
  killSwitch: z.strictObject({
    stateFile: z.string().min(1),
    auditLog: z.string().min(1),
    // If this list is not empty, only these people can engage the switch.
    holders: z.array(z.string().min(1)),
    // Resuming also needs a clean golden-set report that is newer than the engagement (manual: Roles and decision rights).
    requireGoldenRun: z.boolean(),
    // Calls made against the target to revoke the runner's access, and to restore it on resume. Fixture-only defaults.
    revokeCalls: z.array(CallSchema),
    restoreCalls: z.array(CallSchema),
  }),
  // Requests that change state are blocked unless the case declares them (manual: Guardrails, "Risky actions").
  mutations: z.strictObject({
    // Always allowed. Supplied by the staging owner, for example a telemetry endpoint the application calls on its own.
    alwaysAllow: z.array(z.string().refine(isValidDeclaration, 'use "METHOD /path", "POST /path#Operation" or "WS /path"')),
    // GET paths that change state (for example /logout). Exact, or a prefix when the path ends with *.
    stateChangingGets: z.array(z.string().regex(/^\/\S*$/)),
  }),
  // Implicit checks need no expected result. In version 1 they are reported with the verdict and never change it.
  implicit: z.strictObject({
    enabled: z.boolean(),
    accessibility: z.boolean(),
    maxFindings: z.number().int().min(1),
  }),
  // How many times the judge is asked when its answer fails validation.
  judge: z.strictObject({ maxAttempts: z.number().int().min(1).max(10) }),
  // How many times the model is asked for its final report when the report fails validation.
  modelOutput: z.strictObject({ maxAttempts: z.number().int().min(1).max(10) }),
  loop: z.strictObject({
    // The same action (tool and arguments) failing this many times in a row ends the run as BLOCKED.
    failureLimit: z.number().int().min(2),
    // The same action repeated this many times in a row, even if it succeeds, ends the run as BLOCKED.
    repeatLimit: z.number().int().min(2),
  }),
  tools: z.strictObject({
    actionTimeoutMs: z.number().int().min(100),
    navigationTimeoutMs: z.number().int().min(100),
  }),
  browser: z.strictObject({
    // Playwright turns the Chromium sandbox OFF unless it is asked to turn it on, so the bot asks.
    // false is only for a container that already isolates the browser, and every run record says so.
    sandbox: z.boolean(),
  }),
  oracle: z.strictObject({
    assertionTimeoutMs: z.number().int().min(0),
    assertionPollMs: z.number().int().min(10),
    // A count must hold this long before it counts, so an element that appears a moment later is not missed.
    stabilityMs: z.number().int().min(0),
    // The network must be quiet this long before the runner evaluates the expected results of a step.
    settleQuietMs: z.number().int().min(0),
    settleMaxMs: z.number().int().min(0),
  }),
  // The user roles a case can run as. Credentials are secret references, never values.
  roles: z.record(
    z.string().regex(/^[a-z][a-z0-9_-]*$/),
    z.strictObject({
      login: z.strictObject({
        path: z.string().regex(/^\/\S*$/),
        usernameField: z.string().min(1),
        passwordField: z.string().min(1),
        username: z.string().regex(/^secret:[A-Za-z0-9_.-]+$/),
        password: z.string().regex(/^secret:[A-Za-z0-9_.-]+$/),
      }),
      // A page that answers 200 only with a valid session. Checked right after login.
      verifyPath: z.string().regex(/^\/\S*$/),
    }),
  ),
  sessions: z.strictObject({
    // per-case: every case logs in afresh, so a logout in one case cannot end another case's session.
    mode: z.literal("per-case"),
    // Where session files live while a case runs. Outside the run directory, and removed afterwards.
    directory: z.string().min(1),
  }),
  // The release report (manual: Reading results, "Release report"; Roles and decision rights). The names are [to fill] in the
  // manual and come from here. With no approver listed, nobody may quarantine a case or override a FAIL.
  release: z.strictObject({
    approvers: z.array(z.string().min(1)),
    // The existing release decision-maker. The bot never decides, and the report names who does.
    decisionMaker: z.string().min(1).nullable(),
    // Quarantines and overrides, kept as decision records.
    registerFile: z.string().min(1),
    // Every case file here is part of the inventory the P1 check counts against.
    casesDirectory: z.string().min(1),
  }),
  // Headers sent with setup and teardown calls to the application's test API (fixture only in M1).
  testApi: z.strictObject({ headers: z.record(z.string(), z.string()) }),
  runs: z.strictObject({ directory: z.string().min(1) }),
  // The eval suites (manual: Pilot). The gates are provisional fixture values: the pilot protocol fixes the real ones.
  evals: z.strictObject({
    // Short, because a MISMATCH waits out the whole timeout and the suites run hundreds of cases.
    assertionTimeoutMs: z.number().int().min(0),
    // What to do with the run folders of a suite: keep only the ones a person should look at, or all of them.
    keepRuns: z.enum(["problems", "all"]),
    // The golden set: verdicts frozen by a person. Any change in a verdict is reported, and a changed P1 verdict is flagged.
    golden: z.strictObject({ file: z.string().min(1) }),
    // The injection eval: hostile pages against the bot, each paired with a clean twin.
    injection: z.strictObject({
      // Hostile runs per scenario. With none steered, 20 runs show a failure rate of at most 13.9% (95%).
      runs: z.number().int().min(1),
      // The highest failure rate the data may still allow. With no failure at all, this is what sets the number of runs.
      maxFailureUpperBound: z.number().min(0).max(1),
    }),
    mutants: z.strictObject({
      // Lowest acceptable share of covered, checkable mutants that some covering case reports as FAIL.
      minDetectionRate: z.number().min(0).max(1),
      // Lowest acceptable share of runs (clean and mutant) that end in PASS or FAIL.
      minDecisiveRate: z.number().min(0).max(1),
      // Highest acceptable share of clean runs that report FAIL.
      maxBaselineFalseFailRate: z.number().min(0).max(1),
      // How often each covering case runs on the clean application before any mutant is judged against it.
      baselineRuns: z.number().int().min(1),
      // How often each covering case runs against each mutant. More than 1 exposes flaky cases.
      repeat: z.number().int().min(1),
    }),
  }),
});
export type Config = z.infer<typeof ConfigSchema>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A fingerprint of the configuration a run used (manual: Reading results, report header). It leaves out the places
 * that differ from one machine to the next (the runs, sessions and kill-switch paths), so the same settings give the
 * same hash anywhere. Every other value counts, including the environment overrides that were applied.
 */
export function configHash(config: Config): string {
  const copy = structuredClone(config) as Record<string, any>;
  delete copy["_comment"];
  delete copy["runs"];
  delete copy["sessions"].directory;
  delete copy["killSwitch"].stateFile;
  delete copy["killSwitch"].auditLog;
  return createHash("sha256").update(canonicalJson(copy)).digest("hex");
}

/**
 * Loads config/default.json. Environment overrides:
 *   QA_ALLOWED_HOSTS            comma-separated host or host:port entries, added to the allowlist
 *   QA_MAX_TOOL_CALLS_PER_RUN   integer
 *   QA_RUNS_DIR                 directory for run output
 *   QA_ASSERTION_TIMEOUT_MS     how long a check waits before it counts as a MISMATCH
 *   QA_BROWSER_SANDBOX=off      turn the Chromium sandbox off (only inside an isolating container)
 *   QA_SESSIONS_DIR             where session files live while a case runs (default: a temp folder)
 *   QA_CANARY_CASES             comma-separated canary case files for the pre-flight check (empty means none)
 *   QA_REQUIRE_CANARIES=0       do not fail the pre-flight check when no canary case is configured
 *   QA_RUNNER_IMAGE_DIGEST      the digest of the container image the runner is in (set by the container script)
 *   QA_REQUIRE_CONTAINER=1      require the pinned container image in the pre-flight check
 */
export function loadConfig(path = "config/default.json", env: NodeJS.ProcessEnv = process.env): Config {
  const config = ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const extraHosts = (env["QA_ALLOWED_HOSTS"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  if (extraHosts.length > 0) config.allowlist.hosts = [...config.allowlist.hosts, ...extraHosts];
  if (env["QA_MAX_TOOL_CALLS_PER_RUN"]) config.budgets.maxToolCallsPerRun = Number(env["QA_MAX_TOOL_CALLS_PER_RUN"]);
  if (env["QA_RUNS_DIR"]) config.runs.directory = env["QA_RUNS_DIR"];
  if (env["QA_ASSERTION_TIMEOUT_MS"]) config.oracle.assertionTimeoutMs = Number(env["QA_ASSERTION_TIMEOUT_MS"]);
  if (env["QA_BROWSER_SANDBOX"] === "off") config.browser.sandbox = false;
  if (env["QA_SESSIONS_DIR"]) config.sessions.directory = env["QA_SESSIONS_DIR"];
  if (env["QA_CANARY_CASES"] !== undefined) config.preflight.canaryCases = env["QA_CANARY_CASES"].split(",").map((c) => c.trim()).filter(Boolean);
  if (env["QA_REQUIRE_CANARIES"] === "0") config.preflight.requireCanaries = false;
  if (env["QA_RUNNER_IMAGE_DIGEST"]) config.preflight.runnerImageDigest = env["QA_RUNNER_IMAGE_DIGEST"];
  if (env["QA_REQUIRE_CONTAINER"] === "1") config.preflight.requireContainer = true;
  config.sessions.directory = config.sessions.directory.replace("${TMPDIR}", tmpdir());
  config.killSwitch.stateFile = config.killSwitch.stateFile.replace("${RUNS}", config.runs.directory);
  config.killSwitch.auditLog = config.killSwitch.auditLog.replace("${RUNS}", config.runs.directory);
  const checked = ConfigSchema.parse(config);
  // A runner that must be the pinned container is a real environment. It may not also skip the canaries.
  if (checked.preflight.requireContainer && (!checked.preflight.requireCanaries || checked.preflight.canaryCases.length === 0)) {
    throw new Error("Invalid configuration: a configuration that requires the container runner must also require at least one canary case (preflight.requireCanaries and preflight.canaryCases).");
  }
  return checked;
}
