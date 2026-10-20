import { readFileSync } from "node:fs";
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
  }),
  tools: z.strictObject({
    actionTimeoutMs: z.number().int().min(100),
    navigationTimeoutMs: z.number().int().min(100),
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
 */
export function loadConfig(path = "config/default.json", env: NodeJS.ProcessEnv = process.env): Config {
  const config = ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const extraHosts = (env["QA_ALLOWED_HOSTS"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  if (extraHosts.length > 0) config.allowlist.hosts = [...config.allowlist.hosts, ...extraHosts];
  if (env["QA_MAX_TOOL_CALLS_PER_RUN"]) config.budgets.maxToolCallsPerRun = Number(env["QA_MAX_TOOL_CALLS_PER_RUN"]);
  if (env["QA_RUNS_DIR"]) config.runs.directory = env["QA_RUNS_DIR"];
  return ConfigSchema.parse(config);
}
