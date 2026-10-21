// A case's `url matches` pattern cannot freeze the runner: patterns that can backtrack badly are refused when the case is
// validated, and the URL is cut before it is tested.
import { describe, expect, it } from "vitest";
import { validateCase, CaseValidationError } from "../../src/cases/load.ts";
import { MAX_URL_LENGTH_TESTED, MAX_PATTERN_LENGTH, patternProblem } from "../../src/schemas/safe-pattern.ts";

const caseWith = (matches: string) => ({
  id: "TC-TEST-001",
  title: "pattern",
  priority: "P2",
  steps: ["open /form"],
  expected: [{ id: "e1", after_step: 1, kind: "url", matches, description: "the url looks right" }],
});

describe("patterns a case may use", () => {
  it.each(["console-leak", ".*", "^/form$", "^/products/\\d+$", "^/(a|b)/x", "^/a/.*/b/.*$", "^/(?:en|de)/form(?:\\?.*)?$", "(a+)?", "x{2,5}", "[+*]+", "\\(a+\\)+", "a{0}b", "^https?://[^/]+/form"])("accepts %s", (pattern) => {
    expect(patternProblem(pattern)).toBeNull();
    expect(() => validateCase(caseWith(pattern))).not.toThrow();
  });

  it.each([
    ["(a+)+$", "repeated group"],
    ["(a*)*", "repeated group"],
    ["(a|aa)+", "repeated group"],
    ["(.*a){10,}", "repeated group"],
    ["((a+))*", "repeated group"],
    ["(?:a|b+)*c", "repeated group"],
    ["(a)\\1", "back-reference"],
    ["(?<x>a)\\k<x>", "back-reference"],
    [".*.*.*x", "unbounded repeats"],
    ["a+b+c+", "unbounded repeats"],
    ["(", "not a valid"],
    ["x".repeat(MAX_PATTERN_LENGTH + 1), "characters long"],
  ])("refuses %s", (pattern, why) => {
    expect(patternProblem(pattern)).toContain(why);
    expect(() => validateCase(caseWith(pattern))).toThrow(CaseValidationError);
  });

  it("an escaped parenthesis or a repeat inside a character class is not a group or a repeat", () => {
    expect(patternProblem("\\(a\\)+")).toBeNull();
    expect(patternProblem("[(a+]+")).toBeNull();
  });

  it("every pattern it accepts finishes quickly on a hostile URL of the longest length that is tested", () => {
    const hostile = "/" + "a".repeat(MAX_URL_LENGTH_TESTED * 2) + "!";
    for (const pattern of ["^/a/.*/b/.*$", "^.*a.*b$", "x{2,5}", "^/(a|b)/x", "(a+)?b"]) {
      expect(patternProblem(pattern)).toBeNull();
      const started = Date.now();
      new RegExp(pattern).test(hostile.slice(0, MAX_URL_LENGTH_TESTED));
      expect(Date.now() - started, pattern).toBeLessThan(1000);
    }
  });
});
