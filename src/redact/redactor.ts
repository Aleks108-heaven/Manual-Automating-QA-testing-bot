// Redaction: replaces secret values and session tokens with [REDACTED:label] before anything is
// shown to the model or written to disk (manual: Guardrails, "Secrets and sessions" and "Tracing and HAR").
// The labels name the secret (for example member.password), never its value.

export const SENSITIVE_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
]);

const SENSITIVE_PARAM = /^(token|access_token|refresh_token|id_token|api[_-]?key|apikey|key|secret|client_secret|password|passwd|pwd|session|sessionid|sid|auth|authorization|signature|sig|code)$/i;
const SENSITIVE_KEY = /pass(word|wd)?|pwd|secret|token|authorization|cookie|api[_-]?key|session/i;

/** A secret shorter than this would corrupt ordinary text when replaced everywhere, so it is refused. */
export const MIN_SECRET_LENGTH = 4;

export function redactedLabel(label: string): string {
  return `[REDACTED:${label}]`;
}

/** Every form in which a value is likely to appear in a URL, a JSON body, a header or a page. */
export function variantsOf(value: string): string[] {
  const candidates = [
    value,
    encodeURIComponent(value),
    encodeURI(value),
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"),
    Buffer.from(value, "utf8").toString("base64").replace(/=+$/, ""),
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
  ];
  return [...new Set(candidates)].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

export class Redactor {
  private readonly tracked = new Map<string, string>(); // variant -> label
  private readonly labels = new Set<string>();
  private ordered: Array<[string, string]> = [];
  replacements = 0;

  /** Starts protecting a value. Call it as soon as the value is known (a password, a session cookie). */
  add(value: string, label: string): void {
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(`secret "${label}" is shorter than ${MIN_SECRET_LENGTH} characters and cannot be redacted safely`);
    }
    this.labels.add(label);
    for (const variant of variantsOf(value)) this.tracked.set(variant, label);
    // Longest first, so a long variant is never split by a shorter one.
    this.ordered = [...this.tracked.entries()].sort((a, b) => b[0].length - a[0].length);
  }

  get secretCount(): number {
    return this.labels.size;
  }

  /** Every tracked variant. Used by the artifact scan. */
  trackedVariants(): ReadonlyArray<{ variant: string; label: string }> {
    return this.ordered.map(([variant, label]) => ({ variant, label }));
  }

  scrubText(text: string): string {
    let out = text;
    for (const [variant, label] of this.ordered) {
      if (!out.includes(variant)) continue;
      const parts = out.split(variant);
      this.replacements += parts.length - 1;
      out = parts.join(redactedLabel(label));
    }
    return out;
  }

  /** Redacts credentials in the URL, sensitive query parameter values, and any tracked value. */
  scrubUrl(url: string): string {
    let out = url;
    try {
      const parsed = new URL(url);
      let changed = false;
      if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
        changed = true;
      }
      for (const key of [...parsed.searchParams.keys()]) {
        if (SENSITIVE_PARAM.test(key)) {
          parsed.searchParams.set(key, "[REDACTED]");
          changed = true;
        }
      }
      if (changed) {
        this.replacements += 1;
        out = parsed.toString().replace(/%5BREDACTED%5D/g, "[REDACTED]");
      }
    } catch {
      /* not a parseable URL: fall through to text scrubbing */
    }
    return this.scrubText(out);
  }

  scrubHeaderValue(name: string, value: string): string {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
      this.replacements += 1;
      return "[REDACTED]";
    }
    return this.scrubText(value);
  }

  scrubHeaders(headers: Record<string, string>): Record<string, string>;
  scrubHeaders(headers: Array<{ name: string; value: string }>): Array<{ name: string; value: string }>;
  scrubHeaders(headers: Record<string, string> | Array<{ name: string; value: string }>): unknown {
    if (Array.isArray(headers)) return headers.map((h) => ({ ...h, value: this.scrubHeaderValue(h.name, h.value) }));
    return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, this.scrubHeaderValue(k, v)]));
  }

  /** Scrubs every string in a JSON-like value, and blanks the value of keys that look sensitive. */
  scrubJson<T>(value: T): T {
    const walk = (node: unknown, key?: string): unknown => {
      if (typeof node === "string") {
        if (key !== undefined && SENSITIVE_KEY.test(key) && node !== "") {
          this.replacements += 1;
          return "[REDACTED]";
        }
        return this.scrubText(node);
      }
      if (Array.isArray(node)) return node.map((n) => walk(n, key));
      if (node && typeof node === "object") {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
      }
      return node;
    };
    return walk(value) as T;
  }

  /**
   * Scrubs a HAR object: every header, cookie, query string entry, post body and URL, then every
   * remaining string. Response bodies are normally omitted when the HAR is recorded.
   */
  scrubHar<T>(har: T): T {
    const copy = structuredClone(har) as unknown as { log?: { entries?: Array<Record<string, any>> } };
    for (const entry of copy.log?.entries ?? []) {
      const req = entry["request"];
      const res = entry["response"];
      if (req) {
        req.url = this.scrubUrl(String(req.url ?? ""));
        req.headers = this.scrubHeaders(req.headers ?? []);
        req.cookies = (req.cookies ?? []).map((c: { value?: string }) => ({ ...c, value: "[REDACTED]" }));
        req.queryString = (req.queryString ?? []).map((q: { name: string; value: string }) => ({
          ...q,
          value: SENSITIVE_PARAM.test(q.name) ? "[REDACTED]" : this.scrubText(q.value),
        }));
        if (req.postData) {
          const text = typeof req.postData.text === "string" ? req.postData.text : "";
          let scrubbed = this.scrubText(text);
          try {
            scrubbed = JSON.stringify(this.scrubJson(JSON.parse(text)));
            scrubbed = this.scrubText(scrubbed);
          } catch {
            /* not JSON: text scrubbing is all that applies */
          }
          req.postData = {
            ...req.postData,
            text: scrubbed,
            params: (req.postData.params ?? []).map((p: { name: string; value?: string }) => ({
              ...p,
              value: SENSITIVE_KEY.test(p.name) ? "[REDACTED]" : this.scrubText(p.value ?? ""),
            })),
          };
        }
      }
      if (res) {
        res.headers = this.scrubHeaders(res.headers ?? []);
        res.cookies = (res.cookies ?? []).map((c: { value?: string }) => ({ ...c, value: "[REDACTED]" }));
        if (res.redirectURL) res.redirectURL = this.scrubUrl(String(res.redirectURL));
        if (res.content?.text) res.content.text = this.scrubText(String(res.content.text));
      }
    }
    return this.scrubJson(copy) as unknown as T;
  }
}
