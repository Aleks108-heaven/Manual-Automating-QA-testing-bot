// The fixture's defects and the mutant manifest built from them. The mutant eval is only worth anything if every
// non-equivalent mutant really changes what the application does, and every equivalent one really does not.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMessageOp, assertKnownDefects, buildDefectConfig, emailIsValid, EMAIL_VALIDATORS, MESSAGE_OPS, MESSAGES, problemWith } from "../../fixtures/defects.ts";
import { generateMutants, MUTANT_CLASSES } from "../../fixtures/mutants.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";

describe("defect names and values", () => {
  it("accepts the documented forms and the old names", () => {
    for (const ok of ["lockout-threshold=7", "email-validator=accepts-no-at", "message=email-invalid:drop-last-char", "email-status=500", "apikey=accepts-any", "logout-button=missing", "form-heading=Anything", "lockout-off-by-one", "email-check-missing", "wrong-email-message"]) {
      expect(problemWith(ok), ok).toBeNull();
    }
  });

  it("rejects unknown names and bad values, with the defect named", () => {
    for (const bad of ["lockout-threshold", "lockout-threshold=0", "lockout-threshold=21", "lockout-threshold=x", "email-validator=nope", "email-status=42", "message=nokey:drop-last-char", "message=email-invalid:nope", "message=email-invalid", "apikey=maybe", "logout-button=ok", "form-heading=", "nonsense", "lockout-off-by-on"]) {
      expect(problemWith(bad), bad).not.toBeNull();
      expect(() => assertKnownDefects([bad])).toThrow(/Unknown fixture defect/);
    }
  });

  it("the old names mean what they meant", () => {
    expect(buildDefectConfig(["lockout-off-by-one"]).lockoutThreshold).toBe(4);
    expect(buildDefectConfig(["email-check-missing"]).emailValidator).toBe("accepts-all");
    expect(buildDefectConfig(["wrong-email-message"]).message("email-invalid", MESSAGES["email-invalid"])).toBe("Enter valid email");
  });

  it("with no defects everything is correct", () => {
    const c = buildDefectConfig([]);
    expect(c.lockoutThreshold).toBe(5);
    expect(c.emailInvalidStatus).toBe(422);
    for (const key of Object.keys(MESSAGES) as Array<keyof typeof MESSAGES>) expect(c.message(key, MESSAGES[key])).toBe(MESSAGES[key]);
  });
});

describe("message mutations", () => {
  const text = "Enter a valid email";
  it.each([
    ["drop-last-char", "Enter a valid emai"],
    ["drop-first-char", "nter a valid email"],
    ["drop-second-word", "Enter valid email"],
    ["lowercase", "enter a valid email"],
    ["uppercase", "ENTER A VALID EMAIL"],
    ["title-case", "Enter A Valid Email"],
    ["add-period", "Enter a valid email."],
    ["add-exclamation", "Enter a valid email!"],
    ["swap-first-two", "nEter a valid email"],
    ["swap-last-two", "Enter a valid emali"],
    ["repeat-last-char", "Enter a valid emaill"],
    ["append-text", "Enter a valid email please"],
    ["prepend-text", "Error: Enter a valid email"],
    ["typo-1", "Exter a valid email"],
    ["truncate-half", "Enter a va"],
    ["replace-spaces", "Enter_a_valid_email"],
    ["empty", ""],
    ["double-space", "Enter  a valid email"],
    ["trailing-space", "Enter a valid email "],
  ] as const)("%s", (op, expected) => {
    expect(applyMessageOp(text, op)).toBe(expected);
  });

  it("strip-period removes only a trailing period", () => {
    expect(applyMessageOp("Account locked. Try again.", "strip-period")).toBe("Account locked. Try again");
    expect(applyMessageOp(text, "strip-period")).toBe(text);
  });

  it("every operation is covered by the table above or the one after it", () => {
    expect(MESSAGE_OPS.length).toBe(23);
  });
});

describe("the email check variants", () => {
  const inputs = ["not-an-email", "a@b", "a b@c.co", "", "user+tag@example.co", "User@Example.co", "a@mail.example.co", "a@b.co"];
  it("only the correct check accepts exactly the valid addresses", () => {
    expect(inputs.filter((i) => emailIsValid(i, "correct"))).toEqual(["user+tag@example.co", "User@Example.co", "a@mail.example.co", "a@b.co"]);
  });
  it("each defective check differs from the correct one on at least one input", () => {
    for (const v of EMAIL_VALIDATORS.filter((x) => x !== "correct")) {
      expect(inputs.some((i) => emailIsValid(i, v) !== emailIsValid(i, "correct")), v).toBe(true);
    }
  });
});

describe("the mutant manifest", () => {
  const mutants = generateMutants();

  it("is big enough, spread over several classes, with unique ids", () => {
    const real = mutants.filter((m) => !m.equivalent && m.coveredBy.length > 0);
    expect(real.length).toBeGreaterThanOrEqual(150);
    expect(new Set(real.map((m) => m.class)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(mutants.map((m) => m.id)).size).toBe(mutants.length);
    expect(new Set(mutants.map((m) => m.class))).toEqual(new Set(MUTANT_CLASSES));
  });

  it("is stable: the same ids in the same order every time", () => {
    expect(generateMutants().map((m) => m.id)).toEqual(mutants.map((m) => m.id));
    expect(mutants[0]?.id).toBe("lockout:lockout-threshold=1");
  });

  it("every defect spec in it is one the fixture accepts", () => {
    for (const m of mutants) expect(() => assertKnownDefects(m.defects), m.id).not.toThrow();
  });

  it("every covering case exists, with a script", () => {
    const ids = new Set(mutants.flatMap((m) => m.coveredBy));
    for (const id of ids) {
      expect(existsSync(`cases/${id}.yaml`), `cases/${id}.yaml`).toBe(true);
      expect(existsSync(`tests/ci/scripts/${id}.json`), `tests/ci/scripts/${id}.json`).toBe(true);
    }
  });

  it("an equivalent mutant says why, and a mutant without a covering case is a coverage gap, not a miss", () => {
    for (const m of mutants.filter((x) => x.equivalent)) expect(m.equivalentReason, m.id).toBeTruthy();
    const gaps = mutants.filter((m) => !m.equivalent && m.coveredBy.length === 0);
    expect(gaps.length).toBeGreaterThan(0);
    expect(new Set(gaps.map((m) => m.defects[0]?.split(":")[0]))).toEqual(new Set(["message=login-ok"]));
  });
});

describe("every mutant changes the application, and every equivalent one does not", () => {
  let site: FixtureSite;
  const T = { "x-fixture-test": "1", "content-type": "application/json" };
  beforeAll(async () => {
    site = await startFixtureSite();
  });
  afterAll(async () => {
    await site.close();
  });

  // Everything a user or a case could see, gathered by plain HTTP.
  async function observe(): Promise<string> {
    await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(site.origin + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual" });
      return { status: r.status, body: await r.text(), cookie: r.headers.getSetCookie()[0]?.split(";")[0] ?? "" };
    };
    const seen: unknown[] = [];
    for (const email of ["not-an-email", "a@b", "a b@c.co", "", "User+Tag@Mail.Example.co", "plain@example.co"]) {
      const { status, body } = await post("/api/subscribe", { email });
      seen.push(["subscribe", email, status, body]);
    }
    // The lockout threshold shows as the attempt on which the account locks. Sixteen attempts cover every threshold.
    for (let i = 1; i <= 16; i += 1) {
      const { status, body } = await post("/api/login", { username: "obs_user", password: "wrong" });
      seen.push(["login-attempt", i, status, body]);
    }
    const login = await post("/api/login", { username: "fixture_member", password: FIXTURE_SECRETS["fixture_member.password"] });
    seen.push(["login-ok", login.status, login.body]);
    seen.push(["account", await (await fetch(site.origin + "/account", { headers: { cookie: login.cookie } })).text()]);
    for (const path of ["/form", "/login", "/apikey"]) seen.push([path, await (await fetch(site.origin + path)).text()]);
    for (const key of ["wrong", FIXTURE_SECRETS["fixture_apikey.value"]]) {
      const { status, body } = await post("/api/apikey", { key });
      seen.push(["apikey", status, body]);
    }
    return JSON.stringify(seen);
  }

  // White space is collapsed by a browser, so it is not a difference a user can see. Strings that hold JSON are
  // opened first, so white space inside a message is collapsed too.
  const normalise = (value: unknown): unknown => {
    if (typeof value === "string") {
      try {
        const inner: unknown = JSON.parse(value);
        if (inner && typeof inner === "object") return normalise(inner);
      } catch {
        /* not JSON */
      }
      // In a page, white space before a closing tag is not shown either.
      return value.replace(/\s+/g, " ").replace(/ <\//g, "</").trim();
    }
    if (Array.isArray(value)) return value.map(normalise);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v)]));
    return value;
  };
  const visible = (snapshot: string) => JSON.stringify(normalise(JSON.parse(snapshot)));

  it("holds for all of them", async () => {
    const mutants = generateMutants();
    site.setDefects([]);
    const baseline = await observe();
    const wrong: string[] = [];
    for (const m of mutants) {
      site.setDefects(m.defects);
      const changed = (await observe()) !== baseline;
      const changedVisibly = visible(await observe()) !== visible(baseline);
      if (!m.equivalent && !changed) wrong.push(`${m.id} is not equivalent but changes nothing`);
      if (m.equivalent && changedVisibly) wrong.push(`${m.id} is called equivalent but changes what a user sees`);
    }
    site.setDefects([]);
    expect(wrong).toEqual([]);
  }, 120_000);
});
