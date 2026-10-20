import { describe, expect, it } from "vitest";
import { Allowlist } from "../../src/tools/allowlist.ts";

describe("Allowlist", () => {
  const list = new Allowlist(["127.0.0.1:4173", "staging.example.com"]);

  it("allows an exact host:port and any port for a bare host", () => {
    expect(list.check("http://127.0.0.1:4173/form").allowed).toBe(true);
    expect(list.check("https://staging.example.com/x").allowed).toBe(true);
    expect(list.check("http://staging.example.com:8443/x").allowed).toBe(true);
  });

  it("refuses another port on a host:port entry, and other hosts", () => {
    expect(list.check("http://127.0.0.1:9999/").allowed).toBe(false);
    expect(list.check("http://localhost:4173/").allowed).toBe(false);
    expect(list.check("https://evil.example.com/").allowed).toBe(false);
    expect(list.check("https://staging.example.com.evil.net/").allowed).toBe(false);
  });

  it("refuses non-http schemes", () => {
    for (const url of ["file:///C:/Windows/win.ini", "data:text/html,hi", "javascript:alert(1)", "blob:http://127.0.0.1:4173/x", "ftp://127.0.0.1:4173/"]) {
      expect(list.check(url).allowed, url).toBe(false);
    }
  });

  it("refuses URLs with credentials, invalid URLs, and relative URLs", () => {
    expect(list.check("http://user:pw@127.0.0.1:4173/").allowed).toBe(false);
    expect(list.check("not a url").allowed).toBe(false);
    expect(list.check("/form").allowed).toBe(false);
  });

  it("allows only about:blank among non-http URLs", () => {
    expect(list.check("about:blank").allowed).toBe(true);
    expect(list.check("about:srcdoc").allowed).toBe(false);
  });

  it("never allows cloud metadata addresses, even if they are listed", () => {
    const risky = new Allowlist(["169.254.169.254", "metadata.google.internal"]);
    expect(risky.check("http://169.254.169.254/latest/meta-data/").allowed).toBe(false);
    expect(risky.check("http://metadata.google.internal/").allowed).toBe(false);
  });

  it("uses the default port for the scheme", () => {
    const withPort = new Allowlist(["app.example.com:443"]);
    expect(withPort.check("https://app.example.com/").allowed).toBe(true);
    expect(withPort.check("http://app.example.com/").allowed).toBe(false);
  });

  it("rejects a malformed entry", () => {
    expect(() => new Allowlist(["http://bad"])).toThrow();
  });
});
