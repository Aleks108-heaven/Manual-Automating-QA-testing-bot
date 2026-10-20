// The command-line entry point: the same thin slice as T17, run the way a person runs it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startFixtureSite } from "../../fixtures/site/server.ts";

// Most tests here are about the CLI itself, so they run with no canary cases, which keeps them quick. The tests in
// "operations" turn the canaries back on.
function cli(args: string[], options: { env?: Record<string, string>; runs?: string; command?: string } = {}) {
  const runs = options.runs ?? mkdtempSync(join(tmpdir(), "qa-bot-cli-"));
  const result = spawnSync(process.execPath, ["src/cli.ts", options.command ?? "run", ...args], {
    encoding: "utf8",
    env: { ...process.env, QA_RUNS_DIR: runs, QA_ASSERTION_TIMEOUT_MS: "1000", QA_CANARY_CASES: "", QA_REQUIRE_CANARIES: "0", ...options.env },
    timeout: 120_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr, runs };
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

// The operations commands, as a person would use them. An in-process fixture is shared by several commands,
// so these use an asynchronous runner (spawnSync would block the fixture while it waits).
function cliAsync(command: string, args: string[], runs: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.ts", command, ...args], {
      env: { ...process.env, QA_RUNS_DIR: runs, QA_ASSERTION_TIMEOUT_MS: "1000", QA_CANARY_CASES: "", QA_REQUIRE_CANARIES: "0", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("operations: pre-flight and the kill switch", () => {
  it("every run starts with the pre-flight check, including the canary pair", async () => {
    const r = cli(["cases/TC-FORM-001.yaml"], { env: { QA_CANARY_CASES: "cases/TC-FORM-001.yaml", QA_REQUIRE_CANARIES: "1" } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PASSED\s+canary cases behave\s+TC-FORM-001: PASS; negative control: FAIL/);
    expect(r.out).toContain("Verdict: PASS");
  });

  it("a failed pre-flight check stops the run before it starts, and names the check", () => {
    const r = cli(["cases/TC-FORM-001.yaml"], { env: { QA_CANARY_CASES: "cases/NO-SUCH-CASE.yaml", QA_REQUIRE_CANARIES: "1" } });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/FAILED\s+canary cases behave/);
    expect(r.err).toContain("The run did not start");
    expect(r.out).not.toContain("Verdict:");
    // Nothing was run: the only file is the pre-flight report.
    expect(readdirSync(r.runs).filter((n) => n.includes("TC-FORM-001"))).toEqual([]);
  });

  it("the kill switch pauses, refuses runs, and resumes only with a review, a fix and a clean report", async () => {
    const site = await startFixtureSite();
    const runs = mkdtempSync(join(tmpdir(), "qa-bot-ops-"));
    const target = ["--target", site.origin];
    const digest = /@(sha256:[0-9a-f]{64})/.exec(readFileSync("Dockerfile", "utf8"))?.[1] as string;
    const strict = { QA_REQUIRE_CONTAINER: "1", QA_RUNNER_IMAGE_DIGEST: digest, QA_CANARY_CASES: "cases/TC-FORM-001.yaml", QA_REQUIRE_CANARIES: "1" };
    try {
      expect((await cliAsync("kill-switch", ["status", ...target], runs)).out).toContain("Not engaged");

      const engage = await cliAsync("kill-switch", ["engage", "--by", "alex", "--reason", "an incident", ...target], runs);
      expect(engage.code).toBe(0);
      expect(engage.out).toContain("PAUSED");
      expect(engage.out).toContain("POST /__test/revoke ok");

      const refused = await cliAsync("run", ["cases/TC-FORM-001.yaml", ...target], runs);
      expect(refused.code).toBe(3);
      expect(refused.err).toContain("paused by the kill switch");

      const notClean = await cliAsync("preflight", [...target], runs);
      expect(notClean.code).toBe(2);
      expect(notClean.out).toMatch(/FAILED\s+runner is not paused/);

      const noRefs = await cliAsync("kill-switch", ["resume", "--by", "sam", ...target], runs);
      expect(noRefs.code).toBe(3);
      expect(noRefs.err).toContain("completed review is required");

      const reportPath = join(runs, "resume-report.json");
      const ready = await cliAsync("preflight", ["--for-resume", "--out", reportPath, ...target], runs, strict);
      expect(ready.code).toBe(0);
      expect(ready.out).toContain("All checks passed.");

      const resumed = await cliAsync("kill-switch", ["resume", "--by", "sam", "--review", "REVIEW-1", "--fix", "PR-2", "--preflight-report", reportPath, ...target], runs);
      expect(resumed.code).toBe(0);
      expect(resumed.out).toContain("Resumed");

      const again = await cliAsync("run", ["cases/TC-FORM-001.yaml", ...target], runs);
      expect(again.code).toBe(0);
      expect(again.out).toContain("Verdict: PASS");

      const audit = readFileSync(join(runs, ".kill-switch-audit.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { action: string }).action);
      expect(audit).toEqual(["engage", "revoke", "resume-refused", "restore", "resume"]);
    } finally {
      await site.close();
    }
  });
});
