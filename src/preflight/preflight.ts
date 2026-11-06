// The pre-flight check (manual: Running tests). A run does not start unless the provider is reachable, quota is
// left, secrets are valid, each needed role's session is fresh, the runner is the pinned image, the target is
// healthy and is the expected build, and the canary cases behave. The runner is also not paused.
// Every check is an injected dependency, so a test can make each one fail. Details never contain a credential.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../config.ts";
import { loadCase } from "../cases/load.ts";
import { negativeControl } from "../cases/mutate.ts";
import type { PauseSource } from "../ops/kill-switch.ts";
import { Redactor } from "../redact/redactor.ts";
import type { BuildProbe } from "../runner/run-case.ts";
import type { TestCase } from "../schemas/case.ts";
import type { Verdict } from "../schemas/common.ts";
import { parseSecretRef, type SecretStore } from "../secrets/store.ts";
import { establishSession, SessionError } from "../sessions/session-setup.ts";
import type { ProviderStatus } from "./provider.ts";
import { PreflightReportSchema, type CheckStatus, type PreflightReport } from "./report.ts";

export interface PreflightDeps {
  config: Config;
  targetOrigin: string;
  /** The kill switch. */
  pause?: PauseSource;
  provider: ProviderStatus;
  secrets: SecretStore;
  probe: BuildProbe;
  /** The cases about to run. Their secrets and roles are checked. */
  plannedCases: readonly TestCase[];
  /** Runs a case the way a real run would, and returns its verdict. Used for the canary pair. */
  runCanary: (testCase: TestCase) => Promise<Verdict>;
  /** Text added to the canary check's detail when it passed, for example to say that a result from earlier in the batch was reused. */
  canaryNote?: () => string;
  /** What is being tested. For an external target the report says so and who attested to it, and the health and build checks are skipped. */
  target?: { kind: "fixture" | "external"; note: string };
  /** Where a role's login is tried. For an external target this is the fixture site that the canary cases run on: a login is never sent to the external site. */
  sessionsOrigin?: string;
  /** For tests: where the Dockerfile text comes from. */
  dockerfileText?: () => string | null;
  now?: () => Date;
  /** "resume" is the check made to show a problem is fixed. It does not fail because the kill switch is engaged. */
  purpose?: "run" | "resume";
}

interface CheckResult {
  status: CheckStatus;
  detail: string;
}

const passed = (detail: string): CheckResult => ({ status: "passed", detail });
const failed = (detail: string): CheckResult => ({ status: "failed", detail });
const skipped = (detail: string): CheckResult => ({ status: "skipped", detail });

function digestFromDockerfile(text: string | null): string | null {
  return text ? (/^FROM\s+\S+@(sha256:[0-9a-f]{64})/im.exec(text)?.[1] ?? null) : null;
}

function defaultDockerfile(path: string): () => string | null {
  return () => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const { config, targetOrigin } = deps;
  const redactor = new Redactor();
  const checks: PreflightReport["checks"] = [];
  const clock = deps.now ?? (() => new Date());

  const record = async (name: string, run: () => Promise<CheckResult>): Promise<CheckStatus> => {
    const started = Date.now();
    let result: CheckResult;
    try {
      result = await run();
    } catch (error) {
      result = failed(`the check itself failed: ${(error as Error).name}: ${(error as Error).message.split("\n")[0]}`);
    }
    checks.push({ name, status: result.status, detail: redactor.scrubText(result.detail), ms: Date.now() - started });
    return result.status;
  };

  // Everything the planned cases would use: their secrets, and the roles they run as.
  const canaryPaths = config.preflight.canaryCases;
  const canaryCases: TestCase[] = [];
  const canaryLoadProblems: string[] = [];
  for (const path of canaryPaths) {
    try {
      canaryCases.push(loadCase(path));
    } catch (error) {
      canaryLoadProblems.push(`${path}: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  const allCases = [...deps.plannedCases, ...canaryCases];
  const roles = [...new Set(allCases.map((c) => c.role).filter((r) => r !== "none"))];

  const purpose = deps.purpose ?? "run";
  await record("runner is not paused", async () => {
    if (!deps.pause) return passed("no kill switch is attached");
    if (!deps.pause.isPaused()) return passed("the kill switch is not engaged");
    return purpose === "resume" ? passed("the kill switch is engaged, as expected: this check is for resuming it") : failed("the kill switch is engaged");
  });

  await record("provider reachable", async () => {
    await deps.provider.ping();
    return passed(`${deps.provider.name} answered`);
  });

  await record("quota left", async () => {
    const remaining = await deps.provider.remainingQuotaUsd();
    if (remaining === null) return skipped(`${deps.provider.name} does not report a quota`);
    return remaining >= config.preflight.minQuotaUsd ? passed(`${remaining} USD left, at least ${config.preflight.minQuotaUsd} needed`) : failed(`${remaining} USD left, ${config.preflight.minQuotaUsd} needed`);
  });

  await record("secrets valid", async () => {
    // Every secret must resolve. Values are scrubbed from the report, except role usernames: a username is an
    // identifier, not a secret, and scrubbing it would also change the names of the secrets in the messages.
    const names = new Map<string, boolean>(); // name -> scrub its value from the report
    for (const c of allCases) for (const ref of Object.values(c.data)) {
      const n = parseSecretRef(ref);
      if (n) names.set(n, true);
    }
    const unknownRoles: string[] = [];
    for (const role of roles) {
      const r = config.roles[role];
      if (!r) unknownRoles.push(role);
      else {
        const user = parseSecretRef(r.login.username);
        const pass = parseSecretRef(r.login.password);
        if (user && !names.has(user)) names.set(user, false);
        if (pass) names.set(pass, true);
      }
    }
    const missing: string[] = [];
    for (const [name, scrub] of names) {
      try {
        const value = await deps.secrets.get(name);
        if (scrub && value.length >= 4) redactor.add(value, name);
      } catch {
        missing.push(name);
      }
    }
    if (unknownRoles.length > 0) return failed(`unknown role(s): ${unknownRoles.join(", ")}`);
    if (missing.length > 0) return failed(`secret(s) not available: ${missing.join(", ")}`);
    return passed(`${names.size} secret(s) resolve`);
  });

  await record("sessions fresh", async () => {
    if (roles.length === 0) return passed("no case needs a signed-in role");
    const problems: string[] = [];
    for (const role of roles) {
      try {
        const session = await establishSession({ role, config, secrets: deps.secrets, targetOrigin: deps.sessionsOrigin ?? targetOrigin, runId: `preflight-${role}`, runDir: join(config.runs.directory, "preflight"), redactor });
        session.cleanup();
      } catch (error) {
        problems.push(`role ${role}: ${error instanceof SessionError ? error.message : (error as Error).name}`);
      }
    }
    return problems.length > 0 ? failed(problems.join("; ")) : passed(`${roles.length} role(s) log in and the session verifies`);
  });

  await record("runner image is the pinned one", async () => {
    if (!config.preflight.requireContainer) return skipped("a container is not required in this configuration");
    const expected = digestFromDockerfile((deps.dockerfileText ?? defaultDockerfile(resolve(config.preflight.dockerfile)))());
    const actual = config.preflight.runnerImageDigest;
    if (!expected) return failed("the Dockerfile has no pinned digest to compare with");
    if (!actual) return failed("QA_RUNNER_IMAGE_DIGEST is not set, so this does not look like the pinned container");
    return actual === expected ? passed("the image digest matches the Dockerfile") : failed("the image digest does not match the Dockerfile");
  });

  // A target of the owner's own, not the fixture. The statement of who allows the test is recorded here, in the report that every run keeps.
  const external = deps.target?.kind === "external";
  if (external) await record("target is allowed", async () => passed(deps.target!.note));

  let probe: Awaited<ReturnType<BuildProbe>> | null = null;
  await record("target healthy", async () => {
    // Nothing is asked of an external site before the run: it has no health endpoint of ours, and the bot sends it only what the case's steps send.
    if (external) return skipped("an external target has no health endpoint of the bot's, and nothing is asked of it before the run");
    probe = await deps.probe(targetOrigin);
    if (!config.preflight.requireHealthEndpoint) return skipped("a health endpoint is not required in this configuration");
    return probe.ok ? passed("GET /health answered") : failed("GET /health did not answer");
  });

  await record("build is the expected one", async () => {
    if (external) return skipped("an external target does not report a build of the bot's");
    if (config.preflight.expectedBuild === null) return skipped("no particular build is required");
    const build = (probe as Awaited<ReturnType<BuildProbe>> | null)?.build ?? null;
    return build === config.preflight.expectedBuild ? passed(`the target reports build ${build}`) : failed(`the target reports build ${build ?? "none"}, expected ${config.preflight.expectedBuild}`);
  });

  await record("canary cases behave", async () => {
    if (checks.some((c) => c.status === "failed")) return skipped("an earlier check failed, so the canaries would not be trustworthy");
    if (canaryLoadProblems.length > 0) return failed(`a canary case could not be loaded (${canaryLoadProblems.join("; ")})`);
    if (canaryCases.length === 0) return config.preflight.requireCanaries ? failed("no canary case is configured") : skipped("no canary case is configured, and none is required here");
    const lines: string[] = [];
    const problems: string[] = [];
    for (const c of canaryCases) {
      const good = await deps.runCanary(c);
      const { testCase: wrong } = negativeControl(c);
      const bad = await deps.runCanary(wrong);
      lines.push(`${c.id}: ${good}; negative control: ${bad}`);
      if (good !== "PASS") problems.push(`${c.id} gave ${good}, expected PASS`);
      if (bad !== "FAIL") problems.push(`the negative control of ${c.id} gave ${bad}, expected FAIL${bad === "PASS" ? " (the bot passes a wrong expected result)" : ""}`);
    }
    return problems.length > 0 ? failed(problems.join("; ")) : passed(`${lines.join("; ")}${deps.canaryNote?.() ?? ""}`);
  });

  const report = {
    schema_version: 1 as const,
    purpose,
    at: clock().toISOString(),
    target: targetOrigin,
    ok: checks.every((c) => c.status === "passed"),
    checks,
  };
  return PreflightReportSchema.parse(report);
}

/** The checks that stop a run. A skipped check does not block a run, but it makes the report unusable for resuming. */
export function failedChecks(report: PreflightReport): PreflightReport["checks"] {
  return report.checks.filter((c) => c.status === "failed");
}

export function writePreflightReport(report: PreflightReport, path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}
