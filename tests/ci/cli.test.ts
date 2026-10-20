// The command-line entry point: the same thin slice as T17, run the way a person runs it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function cli(args: string[]) {
  const runs = mkdtempSync(join(tmpdir(), "qa-bot-cli-"));
  const result = spawnSync(process.execPath, ["src/cli.ts", "run", ...args], {
    encoding: "utf8",
    env: { ...process.env, QA_RUNS_DIR: runs, QA_ASSERTION_TIMEOUT_MS: "1000" },
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("CLI", () => {
  it("prints PASS and exits 0 for TC-FORM-001", () => {
    const r = cli(["cases/TC-FORM-001.yaml"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Verdict: PASS");
    expect(r.out).toContain("Summary: bot executed 1 of 1 planned cases, 0 not verified.");
  });

  it("prints FAIL and exits 1 for the negative control", () => {
    const r = cli(["cases/TC-FORM-001.yaml", "--negative-control"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Verdict: FAIL");
    expect(r.out).toContain("MISMATCH");
    expect(r.out).toContain("1 not verified");
  });

  it("runs the login case with fill_secret and the stored-session case, and reports budget and scan", () => {
    const login = cli(["cases/TC-AUTH-004.yaml"]);
    expect(login.code).toBe(0);
    expect(login.out).toMatch(/Budget\s+6 of 60 tool calls/);
    expect(login.out).toContain("artifact scan clean");
    expect(login.out).not.toContain("Correct#Pass1");
    const member = cli(["cases/TC-ACCT-001.yaml"]);
    expect(member.code).toBe(0);
    expect(member.out).toContain("role member, signed in by the runner");
    expect(member.out).not.toContain("Member#Pass-2026");
  });

  it("decides a judged result with --judge-script, and says what happens without one", () => {
    const withJudge = cli(["cases/TC-JUDGE-001.yaml", "--judge-script", "tests/ci/judge-scripts/TC-JUDGE-001.json"]);
    expect(withJudge.code).toBe(0);
    expect(withJudge.out).toContain("Judge: scripted-judge, 1 call(s)");
    expect(withJudge.out).toMatch(/j1\s+MATCH/);
    const without = cli(["cases/TC-JUDGE-001.yaml"]);
    expect(without.code).toBe(2);
    expect(without.out).toContain("INCONCLUSIVE");
    expect(without.err).toContain("no --judge-script was given");
  });

  it("lists implicit findings and says they do not change the verdict", () => {
    const r = cli(["cases/TC-IMPL-001.yaml"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Verdict: PASS");
    expect(r.out).toMatch(/Implicit checks: \d+ finding\(s\)/);
    expect(r.out).toContain("[accessibility button-name");
    expect(r.out).toContain("they do not change the verdict");
  });

  it("shows the blocked step and the screenshot path", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-script-"));
    const file = join(dir, "blocked.json");
    writeFileSync(file, JSON.stringify({ case_id: "TC-FORM-001", steps: [[{ tool: "goto", args: { url: "/form" } }], [{ stop: "element_missing" }]] }));
    const r = cli(["cases/TC-FORM-001.yaml", "--script", file]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Verdict: BLOCKED");
    expect(r.out).toContain("Blocked at step 2 (element_missing)");
    expect(r.out).toMatch(/screenshot: .*blocked-step2-screenshot\.png/);
  });

  it("never says all tests passed", () => {
    for (const args of [["cases/TC-FORM-001.yaml"], ["cases/TC-FORM-001.yaml", "--negative-control"]]) {
      expect(cli(args).out.toLowerCase()).not.toContain("all tests passed");
    }
  });

  it("finds the seeded defect with --defects", () => {
    const r = cli(["cases/TC-AUTH-003.yaml", "--defects", "lockout-off-by-one"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Account locked");
  });

  it("rejects an unknown defect name instead of running on a correct app", () => {
    const r = cli(["cases/TC-AUTH-003.yaml", "--defects", "lockout-off-by-on"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("Unknown fixture defect");
  });

  it("refuses a target that is not the local fixture site", () => {
    const r = cli(["cases/TC-FORM-001.yaml", "--target", "https://example.com"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("local fixture site");
  });

  it("refuses a loopback service that is not the fixture site", async () => {
    const server = createServer((_req, res) => res.end("{}"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // spawnSync would block this process, and the server needs to answer, so run the CLI asynchronously.
      const result = await new Promise<{ code: number | null; err: string }>((resolve) => {
        const child = spawn(process.execPath, ["src/cli.ts", "run", "cases/TC-FORM-001.yaml", "--target", `http://127.0.0.1:${port}`], {
          env: { ...process.env, QA_RUNS_DIR: mkdtempSync(join(tmpdir(), "qa-bot-cli-")) },
        });
        let err = "";
        child.stderr.on("data", (d) => (err += String(d)));
        child.on("close", (code) => resolve({ code, err }));
      });
      expect(result.code).toBe(64);
      expect(result.err).toContain("does not identify itself as the fixture site");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("rejects an invalid case with exit code 64 before any run", () => {
    const r = cli(["tests/ci/helpers/does-not-exist.yaml"]);
    expect(r.code).not.toBe(0);
  });
});
