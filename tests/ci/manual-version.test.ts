// The manual's version follows the last row of its change log. A script copies it into the two other places, and this test fails
// when they drift apart, so a forgotten edit is caught in CI instead of being found by a reader.
import { describe, expect, it } from "vitest";
import { checkManualVersion, lastLogEntry, ManualVersionError, syncTexts } from "../../scripts/sync-manual-version.ts";

const control = (tableVersion: string, lastRow = "| 6 Nov 2026 | 0.16 | text | [to fill] |") =>
  [
    "## Document control",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Manual version | ${tableVersion} (draft) |`,
    "| Last reviewed | [to fill: date] |",
    "",
    "| Date | Version | Change | Author |",
    "| --- | --- | --- | --- |",
    "| 19 Oct 2026 | 0.1 | First draft | [to fill] |",
    lastRow,
    "",
    "This log is append-only.",
  ].join("\n");
const index = (version: string, date: string) => `# QA Automation Bot Manual\n\nVersion ${version} (draft), ${date}. Runbooks: [x](y).\n\n1. [Document control](01.md)\n`;

describe("manual version", () => {
  it("the repository's manual agrees with its change log (run: npm run docs:sync)", () => {
    expect(checkManualVersion(".").changes).toEqual([]);
  });

  it("takes the version and date from the last row of the change log", () => {
    expect(lastLogEntry(control("0.12"))).toEqual({ date: "6 Nov 2026", version: "0.16" });
    expect(lastLogEntry(control("0.12", "| 7 Nov 2026 | 0.17 | later | [to fill] |"))).toEqual({ date: "7 Nov 2026", version: "0.17" });
  });

  it("fills the table and the index first line, and says what it changed", () => {
    const r = syncTexts(control("0.12"), index("0.15", "21 Oct 2026"));
    expect(r.control).toContain("| Manual version | 0.16 (draft) |");
    expect(r.index).toContain("Version 0.16 (draft), 6 Nov 2026. Runbooks:");
    expect(r.changes).toHaveLength(2);
  });

  it("changes nothing that is already in step", () => {
    const c = control("0.16");
    const i = index("0.16", "6 Nov 2026");
    const r = syncTexts(c, i);
    expect(r.changes).toEqual([]);
    expect(r.control).toBe(c);
    expect(r.index).toBe(i);
  });

  it("never touches Last reviewed, the owner or the status, which say that a person did something", () => {
    const r = syncTexts(control("0.12"), index("0.15", "21 Oct 2026"));
    expect(r.control).toContain("| Last reviewed | [to fill: date] |");
    // Only the one line differs from the input.
    const before = control("0.12").split("\n");
    const after = r.control.split("\n");
    expect(after.filter((line, n) => line !== before[n])).toEqual(["| Manual version | 0.16 (draft) |"]);
  });

  it("never edits the change log, which is append-only", () => {
    const r = syncTexts(control("0.12"), index("0.15", "21 Oct 2026"));
    const rows = (t: string) => t.split("\n").filter((l) => /^\| \d{1,2} [A-Z][a-z]{2} \d{4} \|/.test(l));
    expect(rows(r.control)).toEqual(rows(control("0.12")));
  });

  it("keeps Windows line endings", () => {
    const r = syncTexts(control("0.12").replaceAll("\n", "\r\n"), index("0.15", "21 Oct 2026").replaceAll("\n", "\r\n"));
    expect(r.control).toContain("| Manual version | 0.16 (draft) |\r\n");
    expect(r.control).not.toMatch(/[^\r]\n/);
    expect(r.index).toContain("Version 0.16 (draft), 6 Nov 2026. Runbooks:");
  });

  it("refuses a page it cannot read instead of guessing", () => {
    expect(() => syncTexts("## Document control\n\nno log here", index("0.16", "6 Nov 2026"))).toThrow(ManualVersionError);
    expect(() => syncTexts(control("0.16").replace("| Manual version | 0.16 (draft) |", "| Version | 0.16 |"), index("0.16", "6 Nov 2026"))).toThrow(/Manual version/);
    expect(() => syncTexts(control("0.16"), "no version line")).toThrow(/Version X\.Y/);
  });
});
