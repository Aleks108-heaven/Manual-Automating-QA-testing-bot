// What the bot may test (manual: Guardrails and security rules, "Targets"; CLAUDE.md).
//
// By default the only target is the local fixture site. A loopback address is not enough: another local service (an admin panel, a
// database UI) is not the fixture. So the target must also say who it is: GET /health must report a build that starts with "fixture-".
//
// A person can add other targets, their own sites, in one controlled way: list the exact origins and write down who owns the site or
// allows the test (config targets.external). Then a run may target one of those origins and no other. The bot cannot know that the
// statement is true; it records it, shows it in the pre-flight report, and makes the run safe in every way it can: the browser reaches
// only the listed origins, cases are read-only unless the owner of the bot says otherwise, no secrets and no signed-in roles, no calls to
// a test API, and the canary pair runs on a local fixture site and never on the external one.
import { allowlistEntryFor, externalTargetsEnabled, isLoopbackUrl, type Config } from "./config.ts";
import type { TestCase } from "./schemas/case.ts";

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export function isLoopbackTarget(url: string): boolean {
  return isLoopbackUrl(url);
}

export type TargetKind = "fixture" | "external";

export interface ResolvedTarget {
  origin: string;
  kind: TargetKind;
  /** One line for the pre-flight report: what the target is and, for an external one, who attested to it. */
  note: string;
}

/** True if the origin answers GET /health as the fixture site does. A redirect is refused, and a body that is not JSON is the same as no answer. */
async function isFixture(origin: string): Promise<boolean> {
  const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000), redirect: "error" })
    .then((r) => r.json() as Promise<{ build?: unknown } | null>)
    .catch(() => null);
  return !!health && typeof health === "object" && typeof health.build === "string" && health.build.startsWith("fixture-");
}

/** Returns the origin of a target that is the local fixture site, or throws TargetError. */
export async function assertFixtureTarget(target: string): Promise<string> {
  if (!isLoopbackTarget(target)) throw new TargetError("The target must be the local fixture site (a loopback address). See CLAUDE.md.");
  const origin = new URL(target).origin;
  if (!(await isFixture(origin))) {
    throw new TargetError(`${origin} does not identify itself as the fixture site (GET /health must report a build starting with "fixture-").`);
  }
  return origin;
}

const HOW_TO_ALLOW = "To test a site of your own, list its origin and say who owns it or allows the test: docs/runbooks/external-targets.md.";

/**
 * Decides whether a target may be tested: the local fixture site, or an origin that a person listed in targets.external.origins
 * together with an attestation. Anything else is refused, with the way to allow it.
 */
export async function assertTarget(target: string, config: Config): Promise<ResolvedTarget> {
  let origin: string;
  try {
    origin = new URL(target).origin;
  } catch {
    throw new TargetError(`${target} is not a full address such as http://127.0.0.1:4173.`);
  }
  const external = config.targets.external;
  const enabled = externalTargetsEnabled(external);
  // A listed origin is an external target, and nothing is sent to it to find out: it is not asked for /health.
  if (enabled && external.origins.includes(origin)) {
    return { origin, kind: "external", note: `external target ${origin}, listed in targets.external.origins; attested by: ${external.attestation}` };
  }
  if (isLoopbackTarget(target)) {
    // Not listed: it may be the fixture. The only way to know is to ask it GET /health, which the fixture answers with its build.
    if (await isFixture(origin)) return { origin, kind: "fixture", note: "the local fixture site" };
    throw new TargetError(`${origin} does not identify itself as the fixture site (GET /health must report a build starting with "fixture-"). ${HOW_TO_ALLOW}`);
  }
  throw new TargetError(
    enabled
      ? `${origin} is not one of the external targets (targets.external.origins: ${external.origins.join(", ")}). The target must be the local fixture site or a listed origin. See CLAUDE.md.`
      : `The target must be the local fixture site (a loopback address). See CLAUDE.md. ${HOW_TO_ALLOW}`,
  );
}

/**
 * The extra hosts the browser may reach in one run (besides the target itself), worked out for that run.
 * An external run gets exactly the listed origins, each with its port, and nothing from allowlist.hosts. A fixture run, and its canary pair,
 * never get a listed external origin, whatever allowlist.hosts holds, so a link or a case there cannot reach the external site.
 */
export function runAllowlist(config: Config, kind: TargetKind): string[] {
  const listed = externalTargetsEnabled(config.targets.external) ? config.targets.external.origins.map(allowlistEntryFor) : [];
  if (kind === "external") return listed;
  return config.allowlist.hosts.filter((h) => !listed.includes(h.trim().toLowerCase()));
}

/** The allowlist entry the browser gets for a target: host and port, never the host alone. */
export function targetAllowlistEntry(origin: string): string {
  return allowlistEntryFor(origin);
}

/**
 * Why a case may not run on an external target, or an empty list. A case for the fixture can sign in with the fixture's fake accounts,
 * call the fixture's test API and send state-changing requests. None of that is safe or possible on someone's real site.
 */
export function externalCaseProblems(testCase: TestCase, config: Config): string[] {
  const problems: string[] = [];
  if (testCase.role !== "none") problems.push(`it runs as the role "${testCase.role}", and signed-in roles use the fixture's login (an external target gets no signed-in role)`);
  const secret = Object.entries(testCase.data).find(([, value]) => value.startsWith("secret:"));
  if (secret) problems.push(`its data uses a secret (data.${secret[0]}); no credentials are used on an external target`);
  if (testCase.setup.length > 0 || testCase.teardown.length > 0) problems.push("it has setup or teardown calls, which go to the fixture's test API");
  if (testCase.allowed_mutations.length > 0 && !config.targets.external.allowMutations) {
    problems.push(`it declares allowed_mutations (${testCase.allowed_mutations.join(", ")}), and an external target is read-only unless targets.external.allowMutations is set`);
  }
  return problems;
}
