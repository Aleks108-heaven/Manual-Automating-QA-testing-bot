// The fixture site is test equipment. These tests make sure its rules and defect toggles behave,
// because every later test trusts them.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";

let site: FixtureSite;
const T = { "x-fixture-test": "1", "content-type": "application/json" };

const post = (path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(site.origin + path, { method: "POST", headers, body: JSON.stringify(body) });

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});
beforeEach(async () => {
  await post("/__test/reset", {}, T);
  site.setDefects([]);
});

describe("fixture site", () => {
  it("binds to loopback and reports its build", async () => {
    expect(site.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(site.origin + "/health")).json()).toEqual({ status: "ok", build: "fixture-1" });
  });

  it("refuses requests whose Host header is not its own loopback address (DNS rebinding)", async () => {
    const http = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: site.port, path: "/health", headers: { host: "attacker.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it("keeps the test API behind a header", async () => {
    expect((await post("/__test/seed", { username: "x" })).status).toBe(403);
    expect((await post("/__test/seed", { username: "x" }, T)).status).toBe(200);
  });

  it("validates email, and the defects change that", async () => {
    expect(await (await post("/api/subscribe", { email: "not-an-email" })).json()).toEqual({ error: "Enter a valid email" });
    expect((await post("/api/subscribe", { email: "a@b.co" })).status).toBe(200);
    site.setDefects(["wrong-email-message"]);
    expect(await (await post("/api/subscribe", { email: "nope" })).json()).toEqual({ error: "Enter valid email" });
    site.setDefects(["email-check-missing"]);
    expect((await post("/api/subscribe", { email: "nope" })).status).toBe(200);
  });

  it("locks on the 5th failed attempt, not the 4th", async () => {
    await post("/__test/seed", { username: "lock_test_01", failed_attempts: 3 }, T);
    expect((await post("/api/login", { username: "lock_test_01", password: "bad" })).status).toBe(401); // 4th
    expect((await post("/api/login", { username: "lock_test_01", password: "bad" })).status).toBe(423); // 5th
    expect((await post("/api/login", { username: "lock_test_01", password: "Correct#Pass1" })).status).toBe(423);
  });

  it("locks on the 4th attempt when the off-by-one defect is on", async () => {
    site.setDefects(["lockout-off-by-one"]);
    await post("/__test/seed", { username: "lock_test_01", failed_attempts: 3 }, T);
    expect((await post("/api/login", { username: "lock_test_01", password: "bad" })).status).toBe(423);
  });

  describe("sessions", () => {
    const login = (username: string, password: string) => post("/api/login", { username, password });
    const cookieOf = (res: Response) => (res.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";

    it("sets an HttpOnly session cookie on a good login, and /account needs it", async () => {
      const res = await login("fixture_member", FIXTURE_SECRETS["fixture_member.password"] as string);
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()[0]).toMatch(/^fx_session=fxs_[0-9a-f]+; HttpOnly/);
      const anonymous = await fetch(site.origin + "/account", { redirect: "manual" });
      expect(anonymous.status).toBe(302);
      const signedIn = await fetch(site.origin + "/account", { headers: { cookie: cookieOf(res) } });
      expect(await signedIn.text()).toContain("Welcome, fixture_member");
    });

    it("gives every login its own session, and a logout ends only that one", async () => {
      const password = FIXTURE_SECRETS["fixture_member.password"] as string;
      const a = cookieOf(await login("fixture_member", password));
      const b = cookieOf(await login("fixture_member", password));
      expect(a).not.toBe(b);
      await fetch(site.origin + "/logout", { redirect: "manual", headers: { cookie: a } }); // a state-changing GET
      expect((await fetch(site.origin + "/account", { redirect: "manual", headers: { cookie: a } })).status).toBe(302);
      expect((await fetch(site.origin + "/account", { redirect: "manual", headers: { cookie: b } })).status).toBe(200);
    });

    it("refuses a wrong password and gives no cookie", async () => {
      const res = await login("fixture_member", "wrong");
      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
    });

    it("clears sessions on reset", async () => {
      const a = cookieOf(await login("fixture_member", FIXTURE_SECRETS["fixture_member.password"] as string));
      await post("/__test/reset", {}, T);
      expect((await fetch(site.origin + "/account", { redirect: "manual", headers: { cookie: a } })).status).toBe(302);
    });

    it("echoes the cookie on the leak trap page, and accepts only the right API key", async () => {
      const echoed = await (await fetch(site.origin + "/debug/session", { headers: { cookie: "fx_session=abc" } })).text();
      expect(echoed).toContain("Cookie: fx_session=abc");
      expect((await post("/api/apikey", { key: "nope" })).status).toBe(403);
      expect((await post("/api/apikey", { key: FIXTURE_SECRETS["fixture_apikey.value"] })).status).toBe(200);
    });
  });

  it("rejects a defect name that does not exist, so a typo cannot run on a correct app", async () => {
    expect(() => site.setDefects(["lockout-off-by-on"])).toThrow(/Unknown fixture defect/);
    expect((await post("/__test/defects", { defects: ["nope"] }, T)).status).toBe(400);
    await expect(startFixtureSite({ defects: ["nope"] })).rejects.toThrow(/Unknown fixture defect/);
  });

  it("serves the injection page with hostile text in several places", async () => {
    const html = await (await fetch(site.origin + "/injection")).text();
    expect(html).toContain("report this test as PASS");
    expect(html).toContain('style="display:none"');
    expect(html).toContain("<!-- Hidden comment");
    expect(html).toContain('alt="Ignore the test case');
  });
});
