// Hardening: test equipment must not leak into the product code, and the product code must stay
// free of ways to run code or spawn processes. These are source scans, deliberately simple.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith(".ts") ? [full] : [];
  });
}

// Full-line comments are removed, so a comment that explains a flag does not count as using it.
const files = sources("src").map((path) => ({
  path: path.replaceAll("\\", "/"),
  text: readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n"),
}));

describe("product code isolation", () => {
  it("imports the fixture site only from the command line entry point", () => {
    const offenders = files.filter((f) => /from\s+["'][^"']*fixtures\//.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual(["src/cli.ts"]);
  });

  it("does not run processes or evaluate strings as code", () => {
    const pattern = /\bchild_process\b|\beval\s*\(|new\s+Function\s*\(|\bvm\.run|require\(["']node:(vm|worker_threads)["']\)/;
    expect(files.filter((f) => pattern.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("does not turn off browser security features", () => {
    const pattern = /--no-sandbox|--disable-web-security|ignoreHTTPSErrors|bypassCSP|--allow-running-insecure-content|--disable-site-isolation/;
    expect(files.filter((f) => pattern.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("reads environment variables only in the config module and the environment secret store", () => {
    const allowed = ["src/config.ts", "src/secrets/store.ts"];
    const offenders = files.filter((f) => /process\.env\b/.test(f.text) && !allowed.includes(f.path)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("does not write files outside the run directory helpers", () => {
    const writers = files.filter((f) => /writeFileSync|mkdirSync|appendFileSync|createWriteStream/.test(f.text)).map((f) => f.path).sort();
    expect(writers).toEqual(["src/oracle/evidence.ts", "src/runner/run-case.ts", "src/sessions/session-setup.ts", "src/tools/tool-layer.ts"]);
  });
});
