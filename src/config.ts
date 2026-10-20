import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";

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
  // Headers sent with setup and teardown calls to the application's test API (fixture only in M1).
  testApi: z.strictObject({ headers: z.record(z.string(), z.string()) }),
  runs: z.strictObject({ directory: z.string().min(1) }),
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Loads config/default.json. Environment overrides:
 *   QA_ALLOWED_HOSTS            comma-separated host or host:port entries, added to the allowlist
 *   QA_MAX_TOOL_CALLS_PER_RUN   integer
 *   QA_RUNS_DIR                 directory for run output
 *   QA_ASSERTION_TIMEOUT_MS     how long a check waits before it counts as a MISMATCH
 *   QA_BROWSER_SANDBOX=off      turn the Chromium sandbox off (only inside an isolating container)
 *   QA_SESSIONS_DIR             where session files live while a case runs (default: a temp folder)
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
  config.sessions.directory = config.sessions.directory.replace("${TMPDIR}", tmpdir());
  return ConfigSchema.parse(config);
}
