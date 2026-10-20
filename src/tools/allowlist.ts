// The URL allowlist. It lives in code, in the tool layer, never in a prompt
// (manual: Guardrails and security rules).

export interface AllowDecision {
  allowed: boolean;
  reason: string;
}

// Never allowed, even if someone adds them to the allowlist: cloud metadata endpoints.
const ALWAYS_BLOCKED_HOSTS = new Set(["169.254.169.254", "[fd00:ec2::254]", "metadata.google.internal", "metadata"]);

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

export class Allowlist {
  private readonly entries: Array<{ host: string; port: string | null }>;
  private readonly schemes: Set<string>;

  /**
   * @param entries "host" matches that host on any port, "host:port" matches exactly one port.
   *                Prefer host:port. IPv6 entries use brackets, such as "[::1]:8080".
   */
  constructor(entries: readonly string[], schemes: readonly string[] = ["http:", "https:"]) {
    this.schemes = new Set(schemes);
    this.entries = entries.map((entry) => {
      const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry.trim().toLowerCase());
      if (!m) throw new Error(`Invalid allowlist entry: ${entry}`);
      return { host: m[1] as string, port: m[2] ?? null };
    });
  }

  check(rawUrl: string): AllowDecision {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: "not a valid absolute URL" };
    }
    if (rawUrl === "about:blank") return { allowed: true, reason: "blank page" };
    if (!this.schemes.has(url.protocol)) return { allowed: false, reason: `scheme ${url.protocol} is not allowed` };
    if (url.username || url.password) return { allowed: false, reason: "URLs with credentials are not allowed" };
    const host = url.hostname.toLowerCase();
    if (ALWAYS_BLOCKED_HOSTS.has(host)) return { allowed: false, reason: `${host} is a metadata address` };
    const port = effectivePort(url);
    const match = this.entries.some((e) => e.host === host && (e.port === null || e.port === port));
    return match
      ? { allowed: true, reason: `${host}:${port} is on the allowlist` }
      : { allowed: false, reason: `${host}:${port} is not on the allowlist` };
  }
}
