// The fixture site's defects. Each one is a way the application can be wrong, switched on by a name such as
// `lockout-threshold=7`. They are the raw material of the mutant eval (fixtures/mutants.ts): a good bot, running
// good cases, fails the case that covers each defect. Unknown names and bad values are rejected, so a typo can never
// quietly run a case on a correct application.

export const MESSAGE_KEYS = ["email-invalid", "email-ok", "login-failed", "login-ok", "account-locked", "welcome", "key-ok", "key-bad"] as const;
export type MessageKey = (typeof MESSAGE_KEYS)[number];

/** The correct text of each message. `welcome` is shown for the fixture's member user. */
export const MESSAGES: Readonly<Record<MessageKey, string>> = {
  "email-invalid": "Enter a valid email",
  "email-ok": "Thanks for subscribing",
  "login-failed": "Invalid username or password",
  // Shown after a successful login on the login page. No case covers it, on purpose: the mutants of this message
  // are the example of a coverage gap, a place where the bot cannot be blamed because no case looks.
  "login-ok": "Welcome",
  "account-locked": "Account locked. Try again in 15 minutes.",
  welcome: "Welcome, fixture_member",
  "key-ok": "Key accepted",
  "key-bad": "Key rejected",
};

export const MESSAGE_OPS = [
  "drop-last-char",
  "drop-first-char",
  "drop-middle-char",
  "drop-second-word",
  "lowercase",
  "uppercase",
  "title-case",
  "add-period",
  "strip-period",
  "add-exclamation",
  "swap-first-two",
  "swap-last-two",
  "repeat-last-char",
  "append-text",
  "prepend-text",
  "typo-1",
  "typo-4",
  "typo-8",
  "truncate-half",
  "replace-spaces",
  "empty",
  // These change only white space, which a browser collapses. They are not visible to a user.
  "double-space",
  "trailing-space",
] as const;
export type MessageOp = (typeof MESSAGE_OPS)[number];

export const INVISIBLE_OPS: ReadonlySet<string> = new Set(["double-space", "trailing-space"]);

export function applyMessageOp(text: string, op: MessageOp): string {
  const chars = [...text];
  const swap = (a: number, b: number) => {
    const copy = [...chars];
    if (a < copy.length && b < copy.length) [copy[a], copy[b]] = [copy[b] as string, copy[a] as string];
    return copy.join("");
  };
  const typo = (n: number) => {
    const copy = [...chars];
    const i = Math.min(n, copy.length - 1);
    if (i >= 0) copy[i] = copy[i] === "x" ? "y" : "x";
    return copy.join("");
  };
  switch (op) {
    case "drop-last-char":
      return chars.slice(0, -1).join("");
    case "drop-first-char":
      return chars.slice(1).join("");
    case "drop-middle-char":
      return chars.filter((_, i) => i !== Math.floor(chars.length / 2)).join("");
    case "drop-second-word": {
      const words = text.split(" ");
      return words.length > 2 ? words.filter((_, i) => i !== 1).join(" ") : text;
    }
    case "lowercase":
      return text.toLowerCase();
    case "uppercase":
      return text.toUpperCase();
    case "title-case":
      return text.replace(/\b([a-z])/g, (c) => c.toUpperCase());
    case "add-period":
      return `${text}.`;
    case "strip-period":
      return text.replace(/\.+$/, "");
    case "add-exclamation":
      return `${text}!`;
    case "swap-first-two":
      return swap(0, 1);
    case "swap-last-two":
      return swap(chars.length - 2, chars.length - 1);
    case "repeat-last-char":
      return text + (chars[chars.length - 1] ?? "");
    case "append-text":
      return `${text} please`;
    case "prepend-text":
      return `Error: ${text}`;
    case "typo-1":
      return typo(1);
    case "typo-4":
      return typo(4);
    case "typo-8":
      return typo(8);
    case "truncate-half":
      return chars.slice(0, Math.ceil(chars.length / 2)).join("");
    case "replace-spaces":
      return text.replaceAll(" ", "_");
    case "empty":
      return "";
    case "double-space":
      return text.replace(" ", "  ");
    case "trailing-space":
      return `${text} `;
  }
}

export const EMAIL_VALIDATORS = ["correct", "accepts-all", "accepts-no-at", "accepts-no-domain", "accepts-spaces", "accepts-empty", "rejects-plus", "rejects-subdomain", "case-sensitive"] as const;
export type EmailValidator = (typeof EMAIL_VALIDATORS)[number];

/** Whether the fixture's email check accepts this address, under a validator. "correct" is the real rule. */
export function emailIsValid(email: string, validator: EmailValidator): boolean {
  const correct = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  switch (validator) {
    case "correct":
      return correct;
    case "accepts-all":
      return true;
    case "accepts-no-at":
      return email.length > 0;
    case "accepts-no-domain":
      return correct || /^[^@\s]+@[^@\s.]+$/.test(email);
    case "accepts-spaces":
      return correct || /^[^@]+@[^@\s]+\.[^@\s]+$/.test(email);
    case "accepts-empty":
      return correct || email === "";
    case "rejects-plus":
      return correct && !email.includes("+");
    case "rejects-subdomain":
      return correct && email.split("@")[1]!.split(".").length <= 2;
    case "case-sensitive":
      return correct && email === email.toLowerCase();
  }
}

export interface DefectConfig {
  lockoutThreshold: number;
  emailValidator: EmailValidator;
  emailInvalidStatus: number;
  loginFailedStatus: number;
  lockStatus: number;
  apiKeyMode: "correct" | "accepts-any" | "rejects-all";
  apiKeyOkStatus: number;
  apiKeyRejectStatus: number;
  logoutButton: "ok" | "missing" | "renamed";
  lockBannerTestId: boolean;
  formHeading: string;
  subscribeButton: string;
  emailLabel: string;
  /** Not a defect: the pages for the injection evals show hostile text (the default) or the clean twin of it. */
  injectionContent: "hostile" | "clean";
  /** The text of a message, with any mutation applied. */
  message(key: MessageKey, correct: string): string;
}

// Names from before the parameterized defects existed.
export const ALIASES: Readonly<Record<string, string>> = {
  "lockout-off-by-one": "lockout-threshold=4",
  "email-check-missing": "email-validator=accepts-all",
  "wrong-email-message": "message=email-invalid:drop-second-word",
};

const STATUS = /^[1-5]\d\d$/;
const int = (v: string, min: number, max: number) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max;

interface Parsed {
  name: string;
  value: string | null;
}

function split(spec: string): Parsed {
  const resolved = ALIASES[spec] ?? spec;
  const eq = resolved.indexOf("=");
  return eq < 0 ? { name: resolved, value: null } : { name: resolved.slice(0, eq), value: resolved.slice(eq + 1) };
}

/** Returns a problem with a defect name, or null if it is a known defect with a valid value. */
export function problemWith(spec: string): string | null {
  const { name, value } = split(spec);
  const need = (ok: boolean, what: string) => (ok ? null : `${spec}: ${what}`);
  switch (name) {
    case "lockout-threshold":
      return need(value !== null && int(value, 1, 20), "use a number from 1 to 20");
    case "email-validator":
      return need(value !== null && (EMAIL_VALIDATORS as readonly string[]).includes(value), `use one of ${EMAIL_VALIDATORS.join(", ")}`);
    case "email-status":
    case "login-failed-status":
    case "lock-status":
    case "apikey-ok-status":
    case "apikey-reject-status":
      return need(value !== null && STATUS.test(value), "use an HTTP status code");
    case "apikey":
      return need(value === "accepts-any" || value === "rejects-all", "use accepts-any or rejects-all");
    case "logout-button":
      return need(value === "missing" || value === "renamed", "use missing or renamed");
    case "lock-banner-testid":
      return need(value === "missing", "use missing");
    case "injection-content":
      return need(value === "clean" || value === "hostile", "use clean or hostile");
    case "form-heading":
    case "subscribe-button":
    case "email-label":
      return need(value !== null && value.length > 0 && value.length < 60, "give the wrong text");
    case "message": {
      const [key, op] = (value ?? "").split(":");
      return need((MESSAGE_KEYS as readonly string[]).includes(key ?? "") && (MESSAGE_OPS as readonly string[]).includes(op ?? ""), `use <key>:<op>, key one of ${MESSAGE_KEYS.join(", ")}`);
    }
    default:
      return `${spec}: unknown defect`;
  }
}

/** Throws on a defect name that does not exist or a bad value, so a typo cannot run on a correct app. */
export function assertKnownDefects(specs: readonly string[]): void {
  const problems = specs.map(problemWith).filter((p): p is string => p !== null);
  if (problems.length > 0) throw new Error(`Unknown fixture defect(s): ${problems.join("; ")}. See fixtures/defects.ts for the defects and their values.`);
}

export function buildDefectConfig(specs: readonly string[]): DefectConfig {
  assertKnownDefects(specs);
  const config: DefectConfig = {
    lockoutThreshold: 5,
    emailValidator: "correct",
    emailInvalidStatus: 422,
    loginFailedStatus: 401,
    lockStatus: 423,
    apiKeyMode: "correct",
    apiKeyOkStatus: 200,
    apiKeyRejectStatus: 403,
    logoutButton: "ok",
    lockBannerTestId: true,
    formHeading: "Newsletter signup",
    subscribeButton: "Subscribe",
    emailLabel: "Email",
    injectionContent: "hostile",
    message: (_key, correct) => correct,
  };
  const ops = new Map<MessageKey, MessageOp>();
  for (const spec of specs) {
    const { name, value } = split(spec);
    const v = value ?? "";
    switch (name) {
      case "lockout-threshold":
        config.lockoutThreshold = Number(v);
        break;
      case "email-validator":
        config.emailValidator = v as EmailValidator;
        break;
      case "email-status":
        config.emailInvalidStatus = Number(v);
        break;
      case "login-failed-status":
        config.loginFailedStatus = Number(v);
        break;
      case "lock-status":
        config.lockStatus = Number(v);
        break;
      case "apikey-ok-status":
        config.apiKeyOkStatus = Number(v);
        break;
      case "apikey-reject-status":
        config.apiKeyRejectStatus = Number(v);
        break;
      case "apikey":
        config.apiKeyMode = v as DefectConfig["apiKeyMode"];
        break;
      case "logout-button":
        config.logoutButton = v as "missing" | "renamed";
        break;
      case "lock-banner-testid":
        config.lockBannerTestId = false;
        break;
      case "form-heading":
        config.formHeading = v;
        break;
      case "subscribe-button":
        config.subscribeButton = v;
        break;
      case "email-label":
        config.emailLabel = v;
        break;
      case "injection-content":
        config.injectionContent = v as "hostile" | "clean";
        break;
      case "message": {
        const [key, op] = v.split(":");
        ops.set(key as MessageKey, op as MessageOp);
        break;
      }
    }
  }
  config.message = (key, correct) => {
    const op = ops.get(key);
    return op ? applyMessageOp(correct, op) : correct;
  };
  return config;
}
