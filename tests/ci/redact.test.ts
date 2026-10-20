// The redaction core: unit tests. The end-to-end proof that nothing leaks is T2 (credentials.test.ts).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_SECRET_LENGTH, Redactor, variantsOf } from "../../src/redact/redactor.ts";
import { scanArtifacts } from "../../src/redact/scan.ts";

const PASSWORD = "Pa$$w0rd & <\"x'>/+=";
const COOKIE = "s3ss10n-abc123_DEF";

function redactor(): Redactor {
  const r = new Redactor();
  r.add(PASSWORD, "member.password");
  r.add(COOKIE, "session.cookie");
  return r;
}

describe("Redactor.scrubText", () => {
  it("replaces the raw value and every common encoding of it", () => {
    const r = redactor();
    for (const variant of variantsOf(PASSWORD)) {
      const out = r.scrubText(`before ${variant} after`);
      expect(out, variant).toBe("before [REDACTED:member.password] after");
    }
  });

  it("covers URL, JSON, base64 and HTML forms explicitly", () => {
    const v = variantsOf(PASSWORD);
    expect(v).toContain(encodeURIComponent(PASSWORD));
    expect(v).toContain(JSON.stringify(PASSWORD).slice(1, -1));
    expect(v).toContain(Buffer.from(PASSWORD).toString("base64"));
    expect(v.some((x) => x.includes("&amp;"))).toBe(true);
  });

  it("replaces every occurrence and counts them", () => {
    const r = redactor();
    expect(r.scrubText(`${COOKIE}, ${COOKIE}, ${COOKIE}`)).toBe("[REDACTED:session.cookie], [REDACTED:session.cookie], [REDACTED:session.cookie]");
    expect(r.replacements).toBe(3);
  });

  it("leaves unrelated text alone", () => {
    expect(redactor().scrubText("Welcome, fixture_member")).toBe("Welcome, fixture_member");
  });

  it("refuses a secret too short to redact safely", () => {
    expect(() => new Redactor().add("a".repeat(MIN_SECRET_LENGTH - 1), "tiny")).toThrow(/shorter than/);
  });

  it("never puts the value in a label", () => {
    const out = redactor().scrubText(PASSWORD);
    expect(out).not.toContain("Pa$$");
  });
});

describe("Redactor.scrubUrl", () => {
  it("redacts sensitive query parameters, credentials in the URL, and tracked values", () => {
    const r = redactor();
    const out = r.scrubUrl(`https://user:pw@app.example.com/cb?token=abc123&page=2&q=${COOKIE}`);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("user:pw");
    expect(out).not.toContain(COOKIE);
    expect(out).toContain("page=2");
  });

  it("leaves a plain URL unchanged", () => {
    expect(redactor().scrubUrl("http://127.0.0.1:4173/form?x=1")).toBe("http://127.0.0.1:4173/form?x=1");
  });
});

describe("Redactor.scrubHeaders", () => {
  it.each(["Cookie", "cookie", "Set-Cookie", "AUTHORIZATION", "Proxy-Authorization", "X-Api-Key", "x-auth-token", "X-CSRF-Token"])("redacts the %s header", (name) => {
    const r = new Redactor();
    expect(r.scrubHeaders({ [name]: "anything-here" })[name]).toBe("[REDACTED]");
    expect(r.scrubHeaders([{ name, value: "anything-here" }])[0]?.value).toBe("[REDACTED]");
  });

  it("keeps ordinary headers, and scrubs tracked values inside them", () => {
    const r = redactor();
    const out = r.scrubHeaders({ "content-type": "application/json", "x-note": `value ${COOKIE}` });
    expect(out["content-type"]).toBe("application/json");
    expect(out["x-note"]).toBe("value [REDACTED:session.cookie]");
  });
});

describe("Redactor.scrubJson and scrubHar", () => {
  it("blanks sensitive keys and scrubs tracked values anywhere", () => {
    const out = redactor().scrubJson({ username: "u", password: "whatever", nested: [{ apiKey: "k", note: `x ${COOKIE}` }] });
    expect(JSON.stringify(out)).not.toContain("whatever");
    expect(JSON.stringify(out)).not.toContain(COOKIE);
    expect(out.username).toBe("u");
  });

  it("scrubs a HAR: headers, cookies, query string, post body, URL", () => {
    const har = {
      log: {
        entries: [
          {
            request: {
              url: `http://127.0.0.1:4173/api/login?token=zzz111`,
              headers: [{ name: "Cookie", value: `session=${COOKIE}` }, { name: "Accept", value: "*/*" }],
              cookies: [{ name: "session", value: COOKIE }],
              queryString: [{ name: "token", value: "zzz111" }, { name: "page", value: "1" }],
              postData: { mimeType: "application/json", text: JSON.stringify({ username: "u", password: PASSWORD }) },
            },
            response: {
              headers: [{ name: "Set-Cookie", value: `session=${COOKIE}; HttpOnly` }],
              cookies: [{ name: "session", value: COOKIE }],
              content: { text: `echo ${COOKIE}` },
            },
          },
        ],
      },
    };
    const text = JSON.stringify(redactor().scrubHar(har));
    for (const secret of [COOKIE, PASSWORD, "zzz111", JSON.stringify(PASSWORD).slice(1, -1)]) expect(text).not.toContain(secret);
    expect(text).toContain("Accept");
    expect(text).toContain('"page"');
  });

  it("does not modify the object it was given", () => {
    const har = { log: { entries: [{ request: { url: "http://x/?token=abc", headers: [{ name: "Cookie", value: "a=b" }] } }] } };
    const before = JSON.stringify(har);
    redactor().scrubHar(har);
    expect(JSON.stringify(har)).toBe(before);
  });
});

describe("scanArtifacts", () => {
  function dirWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-scan-"));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it("finds nothing in a clean directory", () => {
    const result = scanArtifacts(dirWith({ "run.json": '{"ok":true}', "evidence/e1-network.json": "[]" }), redactor());
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(2);
  });

  it("finds a planted secret in every encoding, and reports the label but not the value", () => {
    for (const variant of variantsOf(PASSWORD)) {
      const result = scanArtifacts(dirWith({ "sub/a.json": `{"x":"${variant}"}` }), redactor());
      expect(result.findings, variant).toEqual([{ file: "sub/a.json", label: "member.password", kind: "secret_value" }]);
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    }
  });

  it("finds a secret inside a binary-looking file", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-scan-"));
    writeFileSync(join(dir, "shot.png"), Buffer.concat([Buffer.from([137, 80, 78, 71, 0, 1]), Buffer.from(COOKIE), Buffer.from([0, 2])]));
    expect(scanArtifacts(dir, redactor()).findings).toEqual([{ file: "shot.png", label: "session.cookie", kind: "secret_value" }]);
  });

  it("finds unredacted credential headers in HAR form and as plain lines, but not redacted ones", () => {
    const bad1 = dirWith({ "run.har": '{"headers":[{"name":"Cookie","value":"a=b"}]}' });
    const bad2 = dirWith({ "notes.txt": "Authorization: Bearer abc.def" });
    const good = dirWith({ "run.har": '{"headers":[{"name":"Cookie","value":"[REDACTED]"}]}', "n.txt": "Authorization: [REDACTED]" });
    expect(scanArtifacts(bad1, new Redactor()).findings[0]?.kind).toBe("credential_header");
    expect(scanArtifacts(bad2, new Redactor()).findings[0]?.kind).toBe("credential_header");
    expect(scanArtifacts(good, new Redactor()).findings).toEqual([]);
  });
});
