import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { CaseSchema, type TestCase } from "../schemas/case.ts";

export interface CaseIssue {
  path: string;
  message: string;
}

export class CaseValidationError extends Error {
  readonly issues: CaseIssue[];
  readonly source: string;
  constructor(source: string, issues: CaseIssue[]) {
    super(`Invalid case ${source}:\n` + issues.map((i) => `  - ${i.path || "(case)"}: ${i.message}`).join("\n"));
    this.name = "CaseValidationError";
    this.issues = issues;
    this.source = source;
  }
}

/** Checks the rules that need more than one field. Returns the issues found. */
function crossFieldIssues(c: TestCase): CaseIssue[] {
  const issues: CaseIssue[] = [];
  const seen = new Set<string>();
  c.expected.forEach((e, i) => {
    if (seen.has(e.id)) issues.push({ path: `expected[${i}].id`, message: `duplicate expected result id "${e.id}"` });
    seen.add(e.id);
    if (e.after_step > c.steps.length) {
      issues.push({
        path: `expected[${i}].after_step`,
        message: `after_step ${e.after_step} refers to a step that does not exist (the case has ${c.steps.length} steps)`,
      });
    }
  });
  return issues;
}

/** Validates a parsed case object. Throws CaseValidationError before any run can start. */
export function validateCase(raw: unknown, source = "(inline)"): TestCase {
  const parsed = CaseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CaseValidationError(
      source,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const issues = crossFieldIssues(parsed.data);
  if (issues.length > 0) throw new CaseValidationError(source, issues);
  return parsed.data;
}

export function parseCase(text: string, source = "(inline)"): TestCase {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new CaseValidationError(source, [{ path: "", message: `not valid YAML: ${(error as Error).message}` }]);
  }
  return validateCase(raw, source);
}

export function loadCase(path: string): TestCase {
  return parseCase(readFileSync(path, "utf8"), path);
}
