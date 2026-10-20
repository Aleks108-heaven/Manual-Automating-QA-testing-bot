import type { ExpectedResult, TestCase } from "../schemas/case.ts";

/** Returns a copy of an expected result whose expected value is deliberately wrong, or null if it has none. */
export function mutateExpected(e: ExpectedResult): ExpectedResult | null {
  switch (e.kind) {
    case "text_visible":
      return { ...e, text: `${e.text} (mutated)` };
    case "url":
      return e.equals !== undefined ? { ...e, equals: `${e.equals}-mutated` } : { ...e, matches: `^/mutated${e.matches ?? ""}` };
    case "status":
      return { ...e, status: e.status === 598 ? 597 : e.status + 1 };
    case "count":
      return { ...e, equals: e.equals + 1 };
    case "element_state": {
      const opposite = { visible: "hidden", hidden: "visible", enabled: "disabled", disabled: "enabled", checked: "unchecked", unchecked: "checked" } as const;
      return { ...e, state: opposite[e.state] };
    }
    case "judged":
      return null;
  }
}

/**
 * The negative control: the same case with one expected result made wrong. The bot must report
 * FAIL for it. A PASS means the bot is broken (manual: Quick start, step 5). With no id given,
 * the first result that can be mutated is used.
 */
export function negativeControl(testCase: TestCase, expectedId?: string): { testCase: TestCase; mutatedId: string } {
  for (const [index, e] of testCase.expected.entries()) {
    if (expectedId !== undefined && e.id !== expectedId) continue;
    const mutated = mutateExpected(e);
    if (!mutated) continue;
    const expected = testCase.expected.slice();
    expected[index] = mutated;
    return { testCase: { ...testCase, expected }, mutatedId: e.id };
  }
  throw new Error(expectedId ? `expected result ${expectedId} cannot be mutated` : "the case has no expected result that can be mutated");
}
