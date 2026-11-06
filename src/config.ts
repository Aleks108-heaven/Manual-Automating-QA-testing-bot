import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import { CallSchema } from "./schemas/case.ts";
import { isValidDeclaration } from "./tools/mutations.ts";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True for an address on this machine. A model server there keeps every prompt on the machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Ollama runs a ":cloud" model on its own servers, so the prompt leaves the machine even though the address is local. */
export function isRemoteModelId(id: string): boolean {
  return /[:\-]cloud$/i.test(id);
}

// The model provider (manual: Data handling rules, "Provider register"; build brief: LLM provider and model). "scripted" is the
// fake model of the CI tests. "openai-compatible" is any server that answers POST {baseUrl}/chat/completions, which covers
// LM Studio, Ollama, llama.cpp and vLLM. The model is chosen by name from what the server lists (`provider models`).
const ProviderSchema = z
  .strictObject({
    kind: z.enum(["scripted", "openai-compatible"]),
    // The server's base address including its version prefix, for example http://127.0.0.1:1234/v1 (LM Studio) or http://127.0.0.1:11434/v1 (Ollama).
    baseUrl: z.string().min(1),
    // The actor's model, exactly as the server lists it. null means none is chosen yet.
    modelId: z.string().min(1).nullable(),
    // The judge is a separate call and may use another model. null means the same model as the actor.
    judgeModelId: z.string().min(1).nullable(),
    // json: the model answers with one JSON action per turn (works with any model that can follow instructions).
    // tools: the server's native tool calling (needs a model and a chat template that support it).
    actionMode: z.enum(["json", "tools"]),
    // Ask the server to constrain the answer to a JSON schema (response_format json_schema). Turn it off if the server rejects it.
    structuredOutput: z.boolean(),
    // True only for a model that can read images. Then the judge receives the screenshots. Otherwise it gets the text evidence only.
    vision: z.boolean(),
    temperature: z.number().min(0).max(2),
    seed: z.number().int().nullable(),
    maxOutputTokens: z.number().int().min(16),
    requestTimeoutMs: z.number().int().min(1000),
    maxResponseBytes: z.number().int().min(1000),
    // A tool result (a page snapshot) longer than this is cut before it is shown to the model, and the cut is marked.
    maxToolResultChars: z.number().int().min(200),
    // The same for one piece of evidence shown to the judge, or to the proposer. A prompt longer than the server's context window is
    // cut by the server, often from the front, which would drop the rules. Keep this well under the context length you set there.
    maxEvidenceChars: z.number().int().min(200),
    // The context length you set on the server for this model, in tokens (Ollama: OLLAMA_CONTEXT_LENGTH or num_ctx; LM Studio: the
    // context length when the model is loaded). The server cuts a longer prompt without an error, from the front, which drops the
    // rules. So the client fits each prompt into this size (cutting page text, and saying so) or refuses to send it.
    contextTokens: z.number().int().min(1024),
    // What a million tokens cost with this provider. Used instead of the global `pricing` whenever a live provider is used. A model on
    // this machine costs nothing, so the default is zero and the cost budget then never stops a run (the time budget still does).
    // A provider that charges must say so here. null means use the global pricing.
    pricing: z.strictObject({ inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) }).nullable(),
    // Name of the secret that holds the server's API key, or null for a server that needs none. The key is never in this file.
    apiKeySecret: z.string().regex(/^[A-Za-z0-9_.-]+$/).nullable(),
    // Where the provider register entry for this provider is kept. Needed before any prompt may leave this machine.
    registerEntry: z.string().min(1).nullable(),
  })
  .superRefine((p, ctx) => {
    let parsed: URL | null = null;
    try {
      parsed = new URL(p.baseUrl);
    } catch {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl must be a full URL such as http://127.0.0.1:1234/v1" });
    }
    if (parsed) {
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl must be http or https" });
      if (parsed.username || parsed.password) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl must not carry a user name or password (use apiKeySecret)" });
      if (parsed.search || parsed.hash) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl must not have a query or a fragment" });
    }
    if (p.kind === "scripted") return;
    if (p.modelId === null) ctx.addIssue({ code: "custom", path: ["modelId"], message: "a live provider needs modelId (list the choices with: node src/cli.ts provider models)" });
    // The data handling page: a prompt may leave this machine only for a provider that has a register entry.
    const leaves = (parsed !== null && !isLoopbackUrl(p.baseUrl)) || [p.modelId, p.judgeModelId].some((m) => m !== null && isRemoteModelId(m));
    if (leaves && p.registerEntry === null) {
      ctx.addIssue({ code: "custom", path: ["registerEntry"], message: "this provider would send prompts off this machine (a non-local address or a :cloud model), so registerEntry must name its provider register entry" });
    }
    // Page text and the API key must not cross a network in clear.
    if (parsed && !isLoopbackUrl(p.baseUrl) && parsed.protocol !== "https:") {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "a provider off this machine must be reached over https" });
    }
  });

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
  provider: ProviderSchema,
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
    // Show the browser window, to watch a run. Nothing else changes: the same tools, rules and checks apply.
    headed: z.boolean(),
    // Pause between browser actions, in milliseconds, so a watched run can be followed. 0 for none.
    slowMoMs: z.number().int().min(0).max(5000),
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
  // Frozen scripts (manual: Purpose, "Hybrid path"; Guardrails, "Frozen scripts"). A person from release.approvers approves each one.
  frozen: z.strictObject({
    // Approved scripts live under here, and drafts (not yet approved, so they cannot run) under drafts/.
    directory: z.string().min(1),
    // Who approved which script hash. A script that is not here, or whose file no longer has the hash here, does not run.
    registerFile: z.string().min(1),
    // How many identical passing runs a case needs before it may be frozen. A provisional value: the manual's page on freezing
    // cases (still to write) fixes the real one.
    minPassingRuns: z.number().int().min(1),
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
 *   QA_RELEASE_APPROVERS        comma-separated approver names (release.approvers), for trying the approval steps without editing the file
 *   QA_RELEASE_DECISION_MAKER   the release decision-maker's name (release.decisionMaker)
 *   QA_PROVIDER                 scripted or openai-compatible (provider.kind)
 *   QA_PROVIDER_URL             provider.baseUrl, for example http://127.0.0.1:11434/v1
 *   QA_PROVIDER_MODEL           provider.modelId, the model chosen from the server's list
 *   QA_PROVIDER_JUDGE_MODEL     provider.judgeModelId
 *   QA_PROVIDER_MODE            json or tools (provider.actionMode)
 *   QA_PROVIDER_VISION=1        the model can read images (provider.vision)
 *   QA_PROVIDER_REGISTER_ENTRY  provider.registerEntry
 *   QA_PROVIDER_CONTEXT         provider.contextTokens, the context length set on the model server
 *   QA_PROVIDER_TIMEOUT_MS      provider.requestTimeoutMs
 *   QA_MAX_WALL_MS              budgets.maxWallMs, the time one run may take
 *   QA_BROWSER_HEADED=1         show the browser window (to watch a run)
 *   QA_BROWSER_SLOWMO_MS        pause between browser actions, in milliseconds
 */
/**
 * The configuration for a command that has nothing to do with a model (the kill switch, reports, the release report, the eval suites,
 * the golden set). It ignores every QA_PROVIDER* variable, so a provider setting that is wrong cannot stop the emergency stop or a
 * report from working.
 */
export function loadConfigIgnoringProvider(path = "config/default.json"): Config {
  return loadConfig(path, Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("QA_PROVIDER"))));
}

/** The configuration for listing a server's models, which has to work before a model is chosen: the kind and the model names are ignored, the address is not. */
export function loadConfigForListing(path = "config/default.json"): Config {
  const skip = new Set(["QA_PROVIDER", "QA_PROVIDER_MODEL", "QA_PROVIDER_JUDGE_MODEL"]);
  return loadConfig(path, Object.fromEntries(Object.entries(process.env).filter(([name]) => !skip.has(name))));
}

/** The model named in QA_PROVIDER_MODEL, or null. The model listing marks it. */
export function modelChosenInEnvironment(): string | null {
  return process.env["QA_PROVIDER_MODEL"]?.trim() || null;
}

/** The configuration with some environment overrides given in code, for example by a command-line flag. The real environment still applies. */
export function loadConfigWith(overrides: Record<string, string>, path = "config/default.json"): Config {
  return loadConfig(path, { ...process.env, ...overrides });
}

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
  const approvers = (env["QA_RELEASE_APPROVERS"] ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  if (approvers.length > 0) config.release.approvers = approvers;
  if (env["QA_RELEASE_DECISION_MAKER"]?.trim()) config.release.decisionMaker = env["QA_RELEASE_DECISION_MAKER"].trim();
  if (env["QA_PROVIDER"]) config.provider.kind = env["QA_PROVIDER"] as typeof config.provider.kind;
  if (env["QA_PROVIDER_URL"]) config.provider.baseUrl = env["QA_PROVIDER_URL"];
  if (env["QA_PROVIDER_MODEL"]) config.provider.modelId = env["QA_PROVIDER_MODEL"];
  if (env["QA_PROVIDER_JUDGE_MODEL"]) config.provider.judgeModelId = env["QA_PROVIDER_JUDGE_MODEL"];
  if (env["QA_PROVIDER_MODE"]) config.provider.actionMode = env["QA_PROVIDER_MODE"] as typeof config.provider.actionMode;
  if (env["QA_PROVIDER_VISION"] === "1") config.provider.vision = true;
  if (env["QA_PROVIDER_REGISTER_ENTRY"]) config.provider.registerEntry = env["QA_PROVIDER_REGISTER_ENTRY"];
  if (env["QA_PROVIDER_CONTEXT"]) config.provider.contextTokens = Number(env["QA_PROVIDER_CONTEXT"]);
  if (env["QA_PROVIDER_TIMEOUT_MS"]) config.provider.requestTimeoutMs = Number(env["QA_PROVIDER_TIMEOUT_MS"]);
  if (env["QA_MAX_WALL_MS"]) config.budgets.maxWallMs = Number(env["QA_MAX_WALL_MS"]);
  if (env["QA_BROWSER_HEADED"] === "1") config.browser.headed = true;
  if (env["QA_BROWSER_SLOWMO_MS"]) config.browser.slowMoMs = Number(env["QA_BROWSER_SLOWMO_MS"]);
  // A live provider has its own prices. The global ones are placeholders for the fixture and are used only with the scripted fake.
  if (config.provider.kind !== "scripted" && config.provider.pricing) config.pricing = { ...config.provider.pricing };
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
