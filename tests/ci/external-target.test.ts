// External targets: a site of the owner's own, besides the fixture. Off unless a person lists the exact origins and writes down who allows
// the test. The tests use a small site on a loopback port that is not the fixture (it has no /health and answers only what a shop would).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { allowlistEntryFor, externalOriginProblem, loadConfig, loadConfigIgnoringProvider, type Config } from "../../src/config.ts";
import { Allowlist } from "../../src/tools/allowlist.ts";
import { QaBot } from "../../src/api.ts";
import { loadCase } from "../../src/cases/load.ts";
import { ScriptedModelClient, ScriptSchema, type Script } from "../../src/model/scripted.ts";
import { ScriptedProviderStatus } from "../../src/preflight/provider.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
import type { TestCase } from "../../src/schemas/case.ts";
import { runBatch } from "../../src/batch.ts";
import { assertTarget, externalCaseProblems, runAllowlist, TargetError } from "../../src/target.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { testConfig } from "./helpers/run.ts";

const ATTESTATION = "Test Owner, owner of this local test server, ticket T-1, 6 Nov 2026";

let fixture: FixtureSite;
let own: { origin: string; requests: string[]; close(): Promise<void> };

/** A site that is not the fixture: a search page, no /health, and a log of every request that reached it. */
async function startOwnSite(): Promise<typeof own> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://own.local");
    if (url.pathname !== "/favicon.ico") requests.push(`${req.method} ${url.pathname}${url.search}`);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/") {
      res.end('<!doctype html><title>My shop</title><main><h1>My shop</h1><form method="get" action="/find"><label for="q">Search</label><input id="q" name="q" type="search"><button type="submit">Search</button></form></main>');
    } else if (url.pathname === "/find") {
      res.end(`<!doctype html><title>Results</title><main><h1>Results</h1><p role="status">${url.searchParams.get("q") === "cats" ? "2 results" : "0 results"}</p></main>`);
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

beforeAll(async () => {
  fixture = await startFixtureSite();
  own = await startOwnSite();
});
afterAll(async () => {
  await fixture.close();
  await own.close();
});
afterEach(() => {
  own.requests.length = 0;
});

/** A configuration that lists the own site as an external target. (The allowlist of a run is worked out per run, not stored in the configuration.) */
const external = (change: (c: Config) => void = () => undefined) =>
  testConfig((c) => {
    c.targets.external = { origins: [own.origin], attestation: ATTESTATION, allowMutations: false };
    change(c);
  });

const searchCase = (extra: Record<string, unknown> = {}) => ({
  id: "TC-EXT-001",
  title: "Search finds the items",
  priority: "P2",
  role: "none",
  steps: ["open /", "fill the Search field with data.q", "click the Search button"],
  data: { q: "cats" },
  expected: [
    { id: "e1", after_step: 3, kind: "url", equals: "/find?q=cats", description: "The address shows the query" },
    { id: "e2", after_step: 3, kind: "text_visible", where: { role: "status" }, text: "2 results", exact: true, description: "The count is shown" },
  ],
  ...extra,
});

const searchScript = (steps?: Script["steps"]): Script =>
  ScriptSchema.parse({
    case_id: "TC-EXT-001",
    steps: steps ?? [[{ tool: "goto", args: { url: "/" } }], [{ tool: "fill", args: { target: { role: "searchbox", name: "Search" }, value: "cats" } }], [{ tool: "click", args: { target: { role: "button", name: "Search" } } }]],
    observations: [],
  });

const botFor = (config: Config, script = searchScript()) =>
  QaBot.create({
    config,
    secrets: new StaticSecretStore({}),
    modelFor: (c: TestCase) => (c.id === "TC-EXT-001" ? new ScriptedModelClient(script) : ScriptedModelClient.fromFile(`tests/ci/scripts/${c.id}.json`)),
    provider: new ScriptedProviderStatus(),
  });

describe("the origins a person may list", () => {
  it("accepts https origins and this machine over http, and says why it refuses the rest", () => {
    for (const ok of ["https://shop.example.com", "https://shop.example.com:8443", "http://localhost:3000", "http://127.0.0.1:8080", "https://203.0.113.9", "https://[2606:4700::1111]", "https://xn--e1afmkfd.xn--p1ai"]) {
      expect(externalOriginProblem(ok), ok).toBeNull();
    }
    const refused: Array<[string, RegExp]> = [
      ["http://shop.example.com", /must be https/],
      ["https://shop.example.com/search", /no path/],
      ["https://shop.example.com/?q=1", /no path, query/],
      ["https://user:pw@shop.example.com", /user name or password/],
      ["https://*.example.com", /wildcard|not a full origin/],
      ["shop.example.com", /not a full origin/],
      ["ftp://shop.example.com", /must be https/],
      ["https://10.0.0.5", /private, link-local or reserved/],
      ["https://192.168.1.20", /private/],
      ["https://172.20.0.3", /private/],
      ["https://169.254.169.254", /private/],
      ["https://100.64.0.1", /private/],
      ["https://[fd00::1]", /private/],
      ["https://[fe80::1]", /private/],
      ["http://127.0.0.2:3000", /must be https|private/],
      // Found by the audit: names that are local, and address forms that are not public.
      ["https://x.localhost", /local or private/],
      ["https://localhost.", /may not end with a dot/],
      ["https://shop.example.com.", /may not end with a dot/],
      ["https://metadata.google.internal.", /may not end with a dot/],
      ["https://metadata.google.internal", /local or private/],
      ["https://intranet", /needs a full domain/],
      ["https://nas.lan", /local or private/],
      ["https://printer.local", /local or private/],
      ["https://[::a00:1]", /private/],
      ["https://[::ffff:a00:1]", /private/],
      ["https://[64:ff9b::a00:1]", /private/],
      ["https://[fec0::1]", /private/],
      ["https://[2002:a00:1::]", /private/],
      ["https://[2001::1]", /private/],
      ["https://10.1", /private/], // 10.0.0.1 written short
      ["https://0xa.1", /private/], // 10.0.0.1 in hex
      ["https://167772161", /private/], // 10.0.0.1 as one number
    ];
    for (const [origin, why] of refused) expect(externalOriginProblem(origin), origin).toMatch(why);
  });

  it("reads 127.0.0.1 written as one number or in hex as what it is: this machine, which is allowed, and keeps it in its normal form", () => {
    for (const spelled of ["https://2130706433", "https://0x7f.1", "http://127.1:3000"]) {
      expect(externalOriginProblem(spelled), spelled).toBeNull();
      expect(new URL(spelled).hostname).toBe("127.0.0.1");
    }
    const c = loadConfig("config/default.json", { QA_EXTERNAL_ORIGINS: "http://127.1:3000", QA_EXTERNAL_ATTESTATION: ATTESTATION });
    expect(c.targets.external.origins).toEqual(["http://127.0.0.1:3000"]);
  });

  it("is off by default, and needs both the origins and a statement of who allows the test", () => {
    const load = (env: NodeJS.ProcessEnv) => loadConfig("config/default.json", env);
    expect(load({}).targets.external).toEqual({ origins: [], attestation: null, allowMutations: false });
    expect(() => load({ QA_EXTERNAL_ORIGINS: "https://shop.example.com" })).toThrow(/attestation must say who owns the site/);
    expect(() => load({ QA_EXTERNAL_ORIGINS: "https://shop.example.com", QA_EXTERNAL_ATTESTATION: "me" })).toThrow(/attestation/);
    expect(() => load({ QA_EXTERNAL_ORIGINS: "http://shop.example.com", QA_EXTERNAL_ATTESTATION: ATTESTATION })).toThrow(/must be https/);
    const c = load({ QA_EXTERNAL_ORIGINS: "https://Shop.Example.com/, https://shop.example.com", QA_EXTERNAL_ATTESTATION: ATTESTATION });
    expect(c.targets.external.origins).toEqual(["https://shop.example.com"]); // one origin, however it is spelled
  });

  it("does not put the listed origins into the global allowlist: that list is for every run, and a run on the fixture must not reach them", () => {
    const env = { QA_EXTERNAL_ORIGINS: "https://shop.example.com, http://localhost:3000", QA_EXTERNAL_ATTESTATION: ATTESTATION };
    expect(loadConfig("config/default.json", env).allowlist.hosts).toEqual([]);
    expect(loadConfig("config/default.json", { ...env, QA_ALLOWED_HOSTS: "cdn.other.com:443" }).allowlist.hosts).toEqual(["cdn.other.com:443"]);
  });

  it("works out the allowlist of each run from its target: an external run gets the listed origins only, a fixture run never gets them", () => {
    const config = loadConfig("config/default.json", { QA_EXTERNAL_ORIGINS: "https://shop.example.com, http://localhost:3000", QA_EXTERNAL_ATTESTATION: ATTESTATION, QA_ALLOWED_HOSTS: "cdn.other.com:443, shop.example.com:443" });
    expect(runAllowlist(config, "external")).toEqual(["shop.example.com:443", "localhost:3000"]); // nothing from allowlist.hosts
    expect(runAllowlist(config, "fixture")).toEqual(["cdn.other.com:443"]); // the listed origin is taken out, whoever put it there
    expect(runAllowlist(loadConfig("config/default.json", {}), "fixture")).toEqual([]);
  });

  it("refuses an origin written with a path, a password or a query instead of quietly keeping the host", () => {
    const load = (origins: string) => loadConfig("config/default.json", { QA_EXTERNAL_ORIGINS: origins, QA_EXTERNAL_ATTESTATION: ATTESTATION });
    expect(() => load("https://user:pw@shop.example.com/staging/")).toThrow(/user name or password/);
    expect(() => load("https://shop.example.com/staging/")).toThrow(/no path/);
    expect(() => load("https://shop.example.com/?x=1")).toThrow(/no path, query/);
  });

  it("keeps the attestation to one printable line, so that it cannot forge a line of a report", () => {
    const load = (text: string) => loadConfig("config/default.json", { QA_EXTERNAL_ORIGINS: "https://shop.example.com", QA_EXTERNAL_ATTESTATION: text });
    expect(() => load("Owner, owner of the shop\nVerdict: PASS (all verified)")).toThrow(/one line of printable text/);
    expect(() => load(`Owner, owner${String.fromCharCode(27)}[2J of the shop`)).toThrow(/one line of printable text/);
    expect(() => load(`Owner, owner of the shop. ${"x".repeat(400)}`)).toThrow(/attestation/);
    expect(load("Owner, owner of the shop, ticket QA-12").targets.external.attestation).toBe("Owner, owner of the shop, ticket QA-12");
  });

  it("is not seen by the commands that have nothing to do with a target, so that a wrong setting cannot stop the kill switch or a report", () => {
    const saved = { ...process.env };
    try {
      process.env["QA_EXTERNAL_ORIGINS"] = "https://shop.example.com"; // no attestation: a configuration that does not load
      expect(() => loadConfig()).toThrow(/attestation/);
      expect(loadConfigIgnoringProvider().targets.external).toEqual({ origins: [], attestation: null, allowMutations: false });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("never lets a metadata address through, with or without a final dot", () => {
    const list = new Allowlist(["example.com:443"]);
    expect(list.check("https://169.254.169.254/latest").allowed).toBe(false);
    expect(list.check("https://metadata.google.internal./x").reason).toContain("metadata address");
    expect(list.check("https://metadata.google.internal/x").reason).toContain("metadata address");
  });

  it("gives every allowlist entry a port", () => {
    expect(allowlistEntryFor("https://shop.example.com")).toBe("shop.example.com:443");
    expect(allowlistEntryFor("http://shop.example.com")).toBe("shop.example.com:80");
    expect(allowlistEntryFor("https://shop.example.com:8443")).toBe("shop.example.com:8443");
    expect(allowlistEntryFor("http://localhost:3000")).toBe("localhost:3000");
    expect(allowlistEntryFor("http://[::1]:3000")).toBe("[::1]:3000");
  });
});

describe("which targets are allowed", () => {
  it("allows the fixture, with no configuration", async () => {
    const t = await assertTarget(fixture.origin, testConfig());
    expect(t).toMatchObject({ origin: fixture.origin, kind: "fixture" });
  });

  it("refuses any other site, and says how to allow a site of one's own", async () => {
    await expect(assertTarget("https://example.com", testConfig())).rejects.toThrow(/must be the local fixture site.*docs\/runbooks\/external-targets\.md/s);
    await expect(assertTarget(own.origin, testConfig())).rejects.toThrow(/does not identify itself as the fixture site.*external-targets\.md/s);
    await expect(assertTarget("not a url", testConfig())).rejects.toThrow(TargetError);
  });

  it("allows an origin that is listed, and no other: not another port, not another host, not the same host over http", async () => {
    const config = external();
    expect(await assertTarget(own.origin, config)).toMatchObject({ origin: own.origin, kind: "external", note: expect.stringContaining(ATTESTATION) });
    await expect(assertTarget("https://example.com", config)).rejects.toThrow(/not one of the external targets/);
    await expect(assertTarget(own.origin.replace(/:\d+$/, ":1"), config)).rejects.toThrow(TargetError);
    const remote = testConfig((c) => Object.assign(c.targets.external, { origins: ["https://shop.example.com"], attestation: ATTESTATION }));
    await expect(assertTarget("http://shop.example.com", remote)).rejects.toThrow(/not one of the external targets/);
  });

  it("does not turn the fixture into an external target, and does not let the fixture's /health stand in for a listed site", async () => {
    const t = await assertTarget(fixture.origin, external());
    expect(t.kind).toBe("fixture");
  });
});

describe("what a case may do on an external target", () => {
  const caseOf = (extra: Record<string, unknown>): TestCase => ({ ...loadCase("cases/TC-FORM-001.yaml"), ...extra }) as TestCase;

  it("is read-only, with no signed-in role, no secret, and no calls to a test API", () => {
    const config = external();
    expect(externalCaseProblems(caseOf({ allowed_mutations: [] }), config)).toEqual([]);
    expect(externalCaseProblems(caseOf({}), config).join(" ")).toMatch(/declares allowed_mutations \(POST \/api\/subscribe\).*read-only/);
    expect(externalCaseProblems(caseOf({ allowed_mutations: [], role: "member" }), config).join(" ")).toMatch(/role "member"/);
    expect(externalCaseProblems(caseOf({ allowed_mutations: [], data: { p: "secret:x.password" } }), config).join(" ")).toMatch(/uses a secret \(data\.p\)/);
    expect(externalCaseProblems(caseOf({ allowed_mutations: [], setup: [{ call: "POST /__test/seed" }] }), config).join(" ")).toMatch(/setup or teardown/);
    expect(externalCaseProblems(caseOf({ allowed_mutations: [], teardown: [{ call: "POST /__test/reset" }] }), config).join(" ")).toMatch(/setup or teardown/);
  });

  it("may send declared requests only when the owner of the bot allows it", () => {
    const allowing = external((c) => (c.targets.external.allowMutations = true));
    expect(externalCaseProblems(caseOf({}), allowing)).toEqual([]);
  });
});

describe("a run on an external target", () => {
  it("passes, asks the site only for what the steps ask, records who allowed it, and runs the canary pair on the fixture", async () => {
    const config = external();
    const bot = await botFor(config);
    const result = await bot.run({ target: own.origin, canaryTarget: fixture.origin, cases: [{ object: searchCase(), label: "mine" }] });
    expect(result.exitCode, result.text).toBe(0);
    expect(result.report.cases[0]!.verdict).toBe("PASS");
    // The site saw the page and the search, and nothing else: no /health before or after, no unrequested path, no write.
    expect(own.requests).toEqual(["GET /", "GET /find?q=cats"]);
    // The report itself says what the target was and who attested to it: in the JSON, in the text, and so in what the MCP server returns.
    expect(result.report.header.notes).toEqual([expect.stringContaining(ATTESTATION)]);
    expect(result.text).toMatch(/TARGET   external target http:\/\/127\.0\.0\.1:\d+, listed in targets\.external\.origins; attested by: Test Owner/);
    expect(readFileSync(result.reportFile, "utf8")).toContain(ATTESTATION);
    // The browser was allowed the listed origin and nothing else.
    const record = JSON.parse(readFileSync(join([...result.runDirs.values()][0]!, "run.json"), "utf8")) as { guardrail_events: Array<{ detail: string }> };
    const allowed = record.guardrail_events[0]!.detail.replace("allowlist: ", "").split(", ");
    expect(new Set(allowed)).toEqual(new Set([allowlistEntryFor(own.origin)]));
    // The pre-flight report names the external target and who attested to it, skips what is the fixture's, and passed the canary pair.
    const preflight = JSON.parse(readFileSync(join(config.runs.directory, "preflight-latest.json"), "utf8")) as { checks: Array<{ name: string; status: string; detail: string }> };
    const byName = Object.fromEntries(preflight.checks.map((c) => [c.name, c]));
    expect(byName["target is allowed"]).toMatchObject({ status: "passed" });
    expect(byName["target is allowed"]!.detail).toContain(ATTESTATION);
    expect(byName["target healthy"]!.status).toBe("skipped");
    expect(byName["build is the expected one"]!.status).toBe("skipped");
    expect(byName["canary cases behave"]).toMatchObject({ status: "passed" });
    // The canary ran on the fixture: its state-changing request reached the fixture, and nothing like it reached the own site.
    const hits = (await (await fetch(`${fixture.origin}/__test/hits`, { headers: { "x-fixture-test": "1" } })).json()) as { hits: string[] };
    expect(hits.hits).toContain("POST /api/subscribe");
    expect(own.requests.some((r) => r.startsWith("POST"))).toBe(false);
  });

  it("needs a fixture site for the canary pair, and does not run without one", async () => {
    const bot = await botFor(external());
    await expect(bot.run({ target: own.origin, cases: [{ object: searchCase() }] })).rejects.toThrow(/needs canaryTarget/);
    // The site cannot stand in for the fixture, and nothing at all is sent to it to find out: the address is compared before any request.
    await expect(bot.run({ target: own.origin, canaryTarget: own.origin, cases: [{ object: searchCase() }] })).rejects.toThrow(/must be a fixture site of its own/);
    await expect(bot.run({ target: own.origin, canaryTarget: `${own.origin}/`, cases: [{ object: searchCase() }] })).rejects.toThrow(/must be a fixture site of its own/);
    expect(own.requests).toEqual([]);
  });

  it("does not let a run on the fixture reach a listed external origin, whatever a case or a page says", async () => {
    // External targets are on, and the own site is listed. A case that runs on the fixture opens the own site: it is blocked, not reached.
    const bot = await botFor(external(), searchScript([[{ tool: "goto", args: { url: `${own.origin}/` } }], [{ tool: "goto", args: { url: "/" } }], [{ tool: "goto", args: { url: "/" } }]]));
    const result = await bot.run({ target: fixture.origin, cases: [{ object: searchCase({ id: "TC-EXT-001" }), label: "on the fixture" }] });
    expect(result.report.cases[0]!.verdict).toBe("INCONCLUSIVE");
    expect(own.requests).toEqual([]);
    const record = JSON.parse(readFileSync(join([...result.runDirs.values()][0]!, "run.json"), "utf8")) as { guardrail_events: Array<{ decision: string; url: string; detail: string }> };
    expect(record.guardrail_events.some((e) => e.decision === "blocked" && e.url === `${own.origin}/`)).toBe(true);
    expect(record.guardrail_events[0]!.detail).not.toContain(allowlistEntryFor(own.origin));
    expect(result.report.header.notes).toBeUndefined(); // a fixture run has no external target to report
  });

  it("logs the canary cases' roles in on the fixture, never on the external site", async () => {
    const config = external((c) => (c.preflight.canaryCases = ["cases/TC-ACCT-001.yaml"]));
    const bot = await QaBot.create({
      config,
      secrets: new StaticSecretStore(FIXTURE_SECRETS),
      modelFor: (c: TestCase) => (c.id === "TC-EXT-001" ? new ScriptedModelClient(searchScript()) : ScriptedModelClient.fromFile(`tests/ci/scripts/${c.id}.json`)),
      provider: new ScriptedProviderStatus(),
    });
    const result = await bot.run({ target: own.origin, canaryTarget: fixture.origin, cases: [{ object: searchCase() }] });
    expect(result.exitCode, result.text).toBe(0);
    const preflight = JSON.parse(readFileSync(join(config.runs.directory, "preflight-latest.json"), "utf8")) as { checks: Array<{ name: string; status: string; detail: string }> };
    expect(preflight.checks.find((c) => c.name === "sessions fresh")).toMatchObject({ status: "passed", detail: expect.stringContaining("log in") });
    expect(own.requests).toEqual(["GET /", "GET /find?q=cats"]); // no login, no /api/login, nothing of the canary
  });

  it("is not reachable through runBatch by leaving the target out: an address that is not on this machine needs assertTarget", async () => {
    const entry = { source: "cases/TC-FORM-001.yaml", testCase: loadCase("cases/TC-FORM-001.yaml"), modelFor: () => new ScriptedModelClient(searchScript()) };
    await expect(
      runBatch({ order: [entry.source], entries: [entry], targetOrigin: "https://shop.example.com", config: external(), secrets: new StaticSecretStore({}), provider: new ScriptedProviderStatus() }),
    ).rejects.toThrow(/needs the result of assertTarget/);
    // With nothing to run (every case file was invalid) there is no target to check, and the batch just reports.
    const empty = await runBatch({ order: ["bad.yaml"], entries: [], invalid: new Map([["bad.yaml", "invalid"]]), targetOrigin: "", config: external(), secrets: new StaticSecretStore({}), provider: new ScriptedProviderStatus() });
    expect(empty.report.summary.executed).toBe(0);
  });

  it("does not run a case that is not safe there, lists it as not executed with the reasons, and runs the rest", async () => {
    const bot = await botFor(external());
    const unsafe = searchCase({ id: "TC-EXT-002", role: "member", allowed_mutations: ["POST /api/x"], setup: [{ call: "POST /__test/seed" }] });
    const result = await bot.run({ target: own.origin, canaryTarget: fixture.origin, cases: [{ object: unsafe, label: "unsafe" }, { object: searchCase(), label: "safe" }] });
    expect(result.report.summary.planned).toBe(2);
    expect(result.report.summary.executed).toBe(1);
    expect(result.text).toContain("not run on an external target:");
    expect(result.text).toMatch(/role "member"/);
    expect(result.text).toMatch(/setup or teardown/);
    expect(result.text).toMatch(/declares allowed_mutations \(POST \/api\/x\)/);
    expect(own.requests).toEqual(["GET /", "GET /find?q=cats"]);
  });

  it("blocks a page, or a model, that tries to leave the listed origins: the run is INCONCLUSIVE and the other host is never reached", async () => {
    const config = external();
    const bot = await botFor(config, searchScript([[{ tool: "goto", args: { url: `${fixture.origin}/form` } }], [{ tool: "goto", args: { url: "https://example.com/" } }], [{ tool: "goto", args: { url: "/" } }]]));
    const result = await bot.run({ target: own.origin, canaryTarget: fixture.origin, cases: [{ object: searchCase() }] });
    expect(result.report.cases[0]!.verdict).toBe("INCONCLUSIVE");
    const run = JSON.parse(readFileSync(join([...result.runDirs.values()][0]!, "run.json"), "utf8")) as { guardrail_events: Array<{ decision: string; url: string }> };
    expect(run.guardrail_events.filter((e) => e.decision === "blocked").map((e) => e.url)).toContain(`${fixture.origin}/form`);
  });

  it("does not use the fixture's kill-switch calls on the external site", async () => {
    const config = external();
    const bot = await botFor(config);
    await bot.run({ target: own.origin, canaryTarget: fixture.origin, cases: [{ object: searchCase() }] });
    expect(own.requests.some((r) => r.includes("__test"))).toBe(false);
  });

  it("is refused outright when the site is not listed", async () => {
    const bot = await botFor(testConfig());
    await expect(bot.run({ target: own.origin, canaryTarget: fixture.origin, cases: [{ object: searchCase() }] })).rejects.toThrow(TargetError);
    // A local address that is not listed is asked GET /health, to learn whether it is the fixture. Nothing else is sent.
    expect(own.requests.filter((r) => r !== "GET /health")).toEqual([]);
  });
});

/** Runs the command line, with the environment given, and collects its output. */
function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.ts", ...args], { env: { ...process.env, QA_RUNS_DIR: mkdtempSync(join(tmpdir(), "qa-bot-ext-cli-")), QA_ASSERTION_TIMEOUT_MS: "1000", ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("the command line with an external target", () => {
  const write = (name: string, text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "qa-bot-ext-")), name);
    writeFileSync(path, text);
    return path;
  };
  const caseYaml = `id: TC-EXT-001
title: Search finds the items
priority: P2
steps:
  - open /
  - fill the Search field with data.q
  - click the Search button
data:
  q: cats
expected:
  - id: e1
    after_step: 3
    kind: url
    equals: "/find?q=cats"
    description: The address shows the query
  - id: e2
    after_step: 3
    kind: text_visible
    where: {role: status}
    text: "2 results"
    exact: true
    description: The count is shown
`;

  it("refuses a site that is not listed, with the way to allow it, and sends it nothing but the question whether it is the fixture", async () => {
    const file = write("TC-EXT-001.yaml", caseYaml);
    const r = await cli(["run", file, "--script", write("s.json", JSON.stringify(searchScript())), "--target", own.origin]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("external-targets.md");
    expect(own.requests.filter((q) => q !== "GET /health")).toEqual([]);
    const remote = await cli(["run", file, "--script", write("s2.json", JSON.stringify(searchScript())), "--target", "https://example.com"]);
    expect(remote.code).toBe(64);
    expect(remote.err).toContain("The target must be the local fixture site");
  });

  it("runs a listed site: the canary pair on a fixture of its own, the case on the site, and says so", async () => {
    const file = write("TC-EXT-001.yaml", caseYaml);
    const r = await cli(["run", file, "--script", write("s.json", JSON.stringify(searchScript())), "--target", own.origin], { QA_EXTERNAL_ORIGINS: own.origin, QA_EXTERNAL_ATTESTATION: ATTESTATION });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`External target ${own.origin}`);
    expect(r.out).toContain("The canary pair runs on a local fixture site, never on the external one.");
    expect(r.out).toMatch(/target is allowed\s+external target/);
    expect(r.out).toContain("Verdict: PASS");
    expect(own.requests).toEqual(["GET /", "GET /find?q=cats"]);
  });

  it("does not take --defects for an external target", async () => {
    const file = write("TC-EXT-001.yaml", caseYaml);
    const r = await cli(["run", file, "--script", write("s.json", JSON.stringify(searchScript())), "--target", own.origin, "--defects", "email-check-missing"], { QA_EXTERNAL_ORIGINS: own.origin, QA_EXTERNAL_ATTESTATION: ATTESTATION });
    expect(r.code).toBe(64);
    expect(r.err).toContain("--defects switch on defects of the fixture site");
  });

  it("keeps the kill switch and the reports working when the external settings are wrong (origins with no attestation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-ext-ks-"));
    const wrong = { QA_EXTERNAL_ORIGINS: "https://shop.example.com", QA_RUNS_DIR: dir };
    const status = await cli(["kill-switch", "status"], wrong);
    expect(status.code).toBe(0);
    expect(status.out).toContain("Not engaged");
    const cases = await cli(["cases", "cases/TC-FORM-001.yaml"], wrong);
    expect(cases.code).toBe(0);
    // A run with the same wrong settings is refused with the reason, not run.
    const run = await cli(["run", "cases/TC-FORM-001.yaml"], wrong);
    expect(run.code).not.toBe(0);
  });

  it("never sends the kill switch's calls to a system that is not on this machine", async () => {
    const r = await cli(["kill-switch", "engage", "--by", "tester", "--reason", "x", "--target", "https://example.com"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("never sent to an external system");
  });
});
