// `node src/cli.ts cases`: list the cases, or check files, without running anything. It is what a tester runs after writing a case.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function cli(args: string[]) {
  const r = spawnSync(process.execPath, ["src/cli.ts", "cases", ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const folder = mkdtempSync(join(tmpdir(), "qa-bot-cases-"));
const write = (name: string, text: string) => {
  const path = join(folder, name);
  writeFileSync(path, text);
  return path;
};
const good = readFileSync("cases/TC-FORM-001.yaml", "utf8");

describe("cases", () => {
  it("lists every case in the cases folder with its priority, checks and what it may send", () => {
    const r = cli([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Cases in cases:");
    expect(r.out).toMatch(/ok\s+TC-FORM-001\s+P1\s+Reject an invalid email on the newsletter form/);
    expect(r.out).toContain("3 step(s), 3 expected result(s) (text_visible, url, status), role none, may send POST /api/subscribe");
    expect(r.out).toContain("sends no state-changing request");
    expect(r.out).toContain("with a problem.");
  });

  it("checks the given files, and says what to do next", () => {
    const r = cli(["cases/TC-FORM-001.yaml"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Cases in cases:");
    expect(r.out).toContain("1 case file(s), 0 with a problem. Next: node src/cli.ts run <file> --negative-control");
  });

  it("shows why a case is invalid, and exits 64", () => {
    const broken = write("TC-BAD-001.yaml", good.replace("id: TC-FORM-001", "id: TC-BAD-001").replace("after_step: 3\n    kind: url", "after_step: 9\n    kind: url").replace(/steps:[\s\S]*?expected:/, "steps:\n  - open /form\nexpected:"));
    const r = cli([broken]);
    expect(r.code).toBe(64);
    expect(r.out).toContain("INVALID");
    expect(r.out).toMatch(/after_step \d+ refers to a step that does not exist/);
  });

  it("says when a field is missing or wrong, by name", () => {
    const noExpected = write("TC-BAD-002.yaml", "id: TC-BAD-002\ntitle: x\npriority: P1\nsteps:\n  - open /form\n");
    const wrongId = write("TC-BAD-003.yaml", good.replace("id: TC-FORM-001", "id: form-1"));
    const r = cli([noExpected, wrongId]);
    expect(r.code).toBe(64);
    expect(r.out).toMatch(/expected: .*(at least one|Invalid|expected)/i);
    expect(r.out).toContain("an id looks like TC-AUTH-003");
  });

  it("finds two files that use the same id", () => {
    const a = write("TC-DUP-001.yaml", good.replace("id: TC-FORM-001", "id: TC-DUP-001"));
    const b = write("TC-DUP-002.yaml", good.replace("id: TC-FORM-001", "id: TC-DUP-001"));
    const r = cli([a, b]);
    expect(r.code).toBe(64);
    expect(r.out).toContain("the id TC-DUP-001 is also used by");
  });

  it("says when a case needs a judge, and when it cannot have a negative control", () => {
    // TC-JUDGE-001 has a checkable result next to its judged one, so a negative control is possible there.
    const mixed = cli(["cases/TC-JUDGE-001.yaml"]);
    expect(mixed.code).toBe(0);
    expect(mixed.out).toContain("has judged results");
    expect(mixed.out).not.toContain("--negative-control cannot be used");
    // A case with only judged results has nothing that code can make wrong.
    const only = write("TC-JONLY-001.yaml", "id: TC-JONLY-001\ntitle: Only judged\npriority: P3\nsteps:\n  - open /form\nexpected:\n  - id: j1\n    after_step: 1\n    kind: judged\n    description: The page looks like a signup form\n");
    const r = cli([only]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("has judged results");
    expect(r.out).toContain("--negative-control cannot be used on this case");
  });

  it("runs nothing: no run folder, no browser, no model", () => {
    const r = cli(["cases/TC-FORM-001.yaml"]);
    expect(r.out).not.toMatch(/Pre-flight|Verdict:|Report /);
  });
});
