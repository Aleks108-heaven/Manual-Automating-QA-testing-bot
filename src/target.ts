// Until the security review of a real target is done, the only allowed target is the local fixture site (CLAUDE.md). A loopback
// address is not enough: another local service (an admin panel, a database UI) is not the fixture. So the target must also say
// who it is: GET /health must report a build that starts with "fixture-". The command line, the library and the MCP server all
// check it here.

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export function isLoopbackTarget(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Returns the origin of a target that is the local fixture site, or throws TargetError. */
export async function assertFixtureTarget(target: string): Promise<string> {
  if (!isLoopbackTarget(target)) throw new TargetError("The target must be the local fixture site (a loopback address). See CLAUDE.md.");
  const origin = new URL(target).origin;
  // A redirect is refused (the answer must come from this address), and a body that is not JSON is the same as no answer.
  const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000), redirect: "error" })
    .then((r) => r.json() as Promise<{ build?: unknown } | null>)
    .catch(() => null);
  if (!health || typeof health !== "object" || typeof health.build !== "string" || !health.build.startsWith("fixture-")) {
    throw new TargetError(`${origin} does not identify itself as the fixture site (GET /health must report a build starting with "fixture-").`);
  }
  return origin;
}
