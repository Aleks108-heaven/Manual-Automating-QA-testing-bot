// The mutant manifest. A mutant is the fixture site with exactly one defect switched on. The mutant eval
// (src/eval/mutants.ts) runs the cases against each mutant and asks: did the bot notice?
//
// Each mutant carries its ground truth:
//   coveredBy   the cases that are MEANT to notice it, because they check the thing that is wrong.
//   equivalent  true if the mutant changes nothing a user or a case could see, so it can never be a miss.
// A mutant that is not equivalent and has no covering case is a COVERAGE GAP: the bot cannot be blamed for it,
// but the case set can. A covered mutant that every covering case passes is a MISS: that is the bot's fault.
import { applyMessageOp, EMAIL_VALIDATORS, INVISIBLE_OPS, MESSAGE_KEYS, MESSAGE_OPS, MESSAGES, type MessageKey } from "./defects.ts";

export const MUTANT_CLASSES = ["lockout", "email-validation", "email-status", "message-text", "status-code", "api-key", "ui-element"] as const;
export type MutantClass = (typeof MUTANT_CLASSES)[number];

export interface Mutant {
  id: string;
  class: MutantClass;
  /** The defect specs to switch on, in the form fixtures/defects.ts accepts. */
  defects: string[];
  description: string;
  coveredBy: string[];
  equivalent: boolean;
  equivalentReason?: string;
}

const FORM_INVALID_CASES = ["TC-FORM-001", "TC-FORM-003", "TC-FORM-004", "TC-FORM-005"];
const FORM_CASES = ["TC-FORM-001", "TC-FORM-002", "TC-FORM-003", "TC-FORM-004", "TC-FORM-005"];

/** Which cases check each message. A message with no case is a coverage gap. */
export const MESSAGE_COVERAGE: Readonly<Record<MessageKey, readonly string[]>> = {
  "email-invalid": FORM_INVALID_CASES,
  "email-ok": ["TC-FORM-002"],
  "login-failed": ["TC-AUTH-003"],
  "login-ok": [],
  "account-locked": ["TC-AUTH-004"],
  welcome: ["TC-ACCT-001"],
  "key-ok": ["TC-KEY-001"],
  "key-bad": ["TC-KEY-002"],
};

function make(m: Omit<Mutant, "id" | "equivalent"> & { equivalent?: boolean; equivalentReason?: string }): Mutant {
  return { id: `${m.class}:${m.defects.join("+")}`, equivalent: false, ...m };
}

export function generateMutants(): Mutant[] {
  const mutants: Mutant[] = [];

  // 1. The lockout threshold. 5 is correct.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15]) {
    mutants.push(
      make({
        class: "lockout",
        defects: [`lockout-threshold=${n}`],
        description: `The account locks on failed attempt ${n} instead of 5`,
        coveredBy: n < 5 ? ["TC-AUTH-003"] : n > 5 ? ["TC-AUTH-004"] : [],
        ...(n === 5 ? { equivalent: true, equivalentReason: "5 is the correct threshold" } : {}),
      }),
    );
  }

  // 2. The email check accepts or rejects the wrong addresses.
  const validatorCases: Record<string, string[]> = {
    "accepts-all": FORM_INVALID_CASES,
    "accepts-no-at": ["TC-FORM-001", "TC-FORM-003", "TC-FORM-004"],
    "accepts-no-domain": ["TC-FORM-003"],
    "accepts-spaces": ["TC-FORM-004"],
    "accepts-empty": ["TC-FORM-005"],
    "rejects-plus": ["TC-FORM-002"],
    "rejects-subdomain": ["TC-FORM-002"],
    "case-sensitive": ["TC-FORM-002"],
  };
  for (const v of EMAIL_VALIDATORS.filter((x) => x !== "correct")) {
    mutants.push(make({ class: "email-validation", defects: [`email-validator=${v}`], description: `The email check is wrong: ${v}`, coveredBy: validatorCases[v] ?? [] }));
  }

  // 3. The status code of a rejected email. 422 is correct.
  for (const code of [200, 201, 400, 404, 422, 500]) {
    mutants.push(
      make({
        class: "email-status",
        defects: [`email-status=${code}`],
        description: `A rejected email is answered with ${code} instead of 422`,
        coveredBy: code === 422 ? [] : FORM_INVALID_CASES,
        ...(code === 422 ? { equivalent: true, equivalentReason: "422 is the correct status" } : {}),
      }),
    );
  }

  // 4. The text of each message, changed in many small ways.
  for (const key of MESSAGE_KEYS) {
    for (const op of MESSAGE_OPS) {
      const correct = MESSAGES[key];
      const changed = applyMessageOp(correct, op);
      const equivalentReason = changed === correct ? "the change leaves this message as it was" : INVISIBLE_OPS.has(op) ? "only white space differs, and a browser collapses white space" : undefined;
      mutants.push(
        make({
          class: "message-text",
          defects: [`message=${key}:${op}`],
          description: `The message "${correct}" becomes "${changed}"`,
          coveredBy: [...MESSAGE_COVERAGE[key]],
          ...(equivalentReason ? { equivalent: true, equivalentReason } : {}),
        }),
      );
    }
  }

  // 5. Status codes that are wrong. The correct one is left out as an equivalent mutant.
  const statuses: Array<[string, string, number[], number, string[]]> = [
    ["login-failed-status", "A failed login", [200, 401, 403, 423, 500], 401, ["TC-AUTH-003"]],
    ["lock-status", "A locked account", [200, 401, 403, 423, 429, 500], 423, ["TC-AUTH-004"]],
    ["apikey-ok-status", "An accepted API key", [200, 201, 204, 403, 500], 200, ["TC-KEY-001"]],
    ["apikey-reject-status", "A rejected API key", [200, 401, 403, 404, 500], 403, ["TC-KEY-002"]],
  ];
  for (const [name, what, codes, correct, cases] of statuses) {
    for (const code of codes) {
      mutants.push(
        make({
          class: "status-code",
          defects: [`${name}=${code}`],
          description: `${what} is answered with ${code} instead of ${correct}`,
          coveredBy: code === correct ? [] : cases,
          ...(code === correct ? { equivalent: true, equivalentReason: `${code} is the correct status` } : {}),
        }),
      );
    }
  }

  // 6. The API key check itself.
  mutants.push(make({ class: "api-key", defects: ["apikey=accepts-any"], description: "Any API key is accepted", coveredBy: ["TC-KEY-002"] }));
  mutants.push(make({ class: "api-key", defects: ["apikey=rejects-all"], description: "No API key is accepted", coveredBy: ["TC-KEY-001"] }));

  // 7. Things on the page.
  mutants.push(make({ class: "ui-element", defects: ["logout-button=missing"], description: "The Log out button is missing from the account page", coveredBy: ["TC-ACCT-001"] }));
  mutants.push(make({ class: "ui-element", defects: ["logout-button=renamed"], description: "The Log out button is called Sign out", coveredBy: ["TC-ACCT-001"] }));
  mutants.push(make({ class: "ui-element", defects: ["lock-banner-testid=missing"], description: "The lockout banner has lost its test marker", coveredBy: ["TC-AUTH-004"] }));
  for (const heading of ["Newsletter sign-up", "Newsletter signup!", "Newsletter"]) {
    mutants.push(make({ class: "ui-element", defects: [`form-heading=${heading}`], description: `The form heading is "${heading}"`, coveredBy: ["TC-JUDGE-001"] }));
  }
  for (const label of ["Sign up", "Subscribe now"]) {
    mutants.push(make({ class: "ui-element", defects: [`subscribe-button=${label}`], description: `The Subscribe button is called "${label}"`, coveredBy: FORM_CASES }));
  }
  for (const label of ["E-mail", "Your email"]) {
    mutants.push(make({ class: "ui-element", defects: [`email-label=${label}`], description: `The Email field is labelled "${label}"`, coveredBy: FORM_CASES }));
  }

  return mutants;
}

export const REAL_MUTANTS = (m: Mutant) => !m.equivalent;
