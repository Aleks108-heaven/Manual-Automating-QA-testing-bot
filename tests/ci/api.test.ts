// The library entry point (src/index.ts): the bot used as part of another application. A host gives it cases (as files, YAML text or
// objects) and a target, and gets a report back. The rules of the bot apply to every run, whatever the host does.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { KillSwitch, QaBot, ScriptedModelClient, TargetError, type Config } from "../../src/index.ts";
import { ScriptedProviderStatus } from "../../src/preflight/provider.ts";
import { StaticSecretStore } from "../../src/secrets/store.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";
import { testConfig } from "./helpers/run.ts";
import { ScriptSchema } from "../../src/model/scripted.ts";

let site: FixtureSite;
const T = { "x-fixture-test": "1", "content-type": "application/json" };
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});
beforeEach(async () => {
  site.setDefects([]);
  await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
});

let fake: FakeLlm | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

/** A configuration without canaries, which keeps these tests quick. The canary pair is tested elsewhere. */
const config = (change: (c: Config) => void = () => undefined) =>
  testConfig((c) => {
    c.preflight.canaryCases = [];
    c.preflight.requireCanaries = false;
    change(c);
  });

const scriptedModel = (c: { id: string }) => ScriptedModelClient.fromFile(`tests/ci/scripts/${c.id}.json`);
const secrets = new StaticSecretStore(FIXTURE_SECRETS);
const formFile = readFileSync("cases/TC-FORM-001.yaml", "utf8");
const formObject = parseYaml(formFile) as Record<string, unknown>;

const bot = (options: { config?: Config; provider?: ScriptedProviderStatus } = {}) =>
  QaBot.create({ config: options.config ?? config(), secrets, modelFor: scriptedModel, ...(options.provider ? { provider: options.provider } : {}) });

describe("QaBot", () => {
  it("runs a case given as a plain object, and the report is stored", async () => {
    const result = await (await bot()).run({ target: site.origin, cases: [{ object: formObject, label: "from-my-app" }] });
    expect(result.exitCode).toBe(0);
    expect(result.report.summary.verified).toBe(1);
    expect(result.report.cases[0]!.verdict).toBe("PASS");
    expect(result.text).toContain("Verdict: PASS");
    expect(result.text).toContain("a scripted fake, not a language model");
    expect(existsSync(result.reportFile)).toBe(true);
    expect(result.runDirs.size).toBe(1);
  });

  it("runs a case given as YAML text or as a file", async () => {
    const b = await bot();
    const yaml = await b.run({ target: site.origin, cases: [{ yaml: formFile, label: "text" }] });
    const file = await b.run({ target: site.origin, cases: [{ file: "cases/TC-FORM-001.yaml" }] });
    expect(yaml.exitCode).toBe(0);
    expect(file.exitCode).toBe(0);
    expect(file.report.cases[0]!.source).toBe("cases/TC-FORM-001.yaml");
  });

  it("the negative control fails, so a host can check that the bot can fail", async () => {
    const result = await (await bot()).run({ target: site.origin, cases: [{ file: "cases/TC-FORM-001.yaml" }], negativeControl: true });
    expect(result.exitCode).toBe(1);
    expect(result.report.cases[0]!.verdict).toBe("FAIL");
  });

  it("a case object that does not validate is reported as not executed, and the rest of the batch runs", async () => {
    const broken = { ...formObject, steps: [] };
    const result = await (await bot()).run({ target: site.origin, cases: [{ object: broken, label: "broken" }, { file: "cases/TC-FORM-001.yaml" }] });
    expect(result.exitCode).toBe(2);
    expect(result.report.summary.planned).toBe(2);
    expect(result.report.summary.executed).toBe(1);
    expect(result.text).toContain("rejected before its run");
  });

  it("refuses a target that is not the fixture site", async () => {
    const b = await bot();
    await expect(b.run({ target: "https://example.com", cases: [{ file: "cases/TC-FORM-001.yaml" }] })).rejects.toThrow(TargetError);
    // A loopback service that is not the fixture is refused too.
    const other = createServer((_req, res) => res.end("{}"));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
      await expect(b.run({ target: url, cases: [{ file: "cases/TC-FORM-001.yaml" }] })).rejects.toThrow(/does not identify itself as the fixture site/);
    } finally {
      other.close();
    }
  });

  it("does not follow a redirect to the fixture, and a /health that is not JSON is a refused target, not a crash", async () => {
    const b = await bot();
    const servers = [
      createServer((_req, res) => {
        res.statusCode = 302;
        res.setHeader("location", `${site.origin}/health`);
        res.end();
      }),
      createServer((_req, res) => res.end("this is not json")),
    ];
    try {
      for (const server of servers) {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        await expect(b.run({ target: url, cases: [{ file: "cases/TC-FORM-001.yaml" }] })).rejects.toThrow(TargetError);
      }
    } finally {
      for (const server of servers) server.close();
    }
  });

  it("refuses an empty batch and two cases with the same id", async () => {
    const b = await bot();
    await expect(b.run({ target: site.origin, cases: [] })).rejects.toThrow(/No cases/);
    await expect(b.run({ target: site.origin, cases: [{ object: formObject, label: "a" }, { object: formObject, label: "b" }] })).rejects.toThrow(/same case id/);
  });

  it("does not start while the kill switch is engaged", async () => {
    const c = config();
    const ks = new KillSwitch({ config: c, targetOrigin: site.origin });
    await ks.engage({ by: "tester", reason: "test" });
    try {
      const result = await (await bot({ config: c })).run({ target: site.origin, cases: [{ file: "cases/TC-FORM-001.yaml" }] });
      expect(result.exitCode).toBe(3);
      expect(result.report.summary.executed).toBe(0);
    } finally {
      await fetch(site.origin + "/__test/restore", { method: "POST", headers: T, body: "{}" });
    }
  });

  it("does not start when the pre-flight check fails (the provider does not answer)", async () => {
    const result = await (await bot({ provider: new ScriptedProviderStatus({ reachable: false }) })).run({ target: site.origin, cases: [{ file: "cases/TC-FORM-001.yaml" }] });
    expect(result.exitCode).toBe(3);
    expect(result.text).toMatch(/pre-flight/i);
  });

  it("lists the cases, with the ones that need a judge marked", async () => {
    const { cases, invalid } = (await bot()).listCases();
    expect(cases.map((c) => c.id)).toContain("TC-FORM-001");
    expect(cases.find((c) => c.id === "TC-JUDGE-001")?.judged).toBe(true);
    expect(cases.find((c) => c.id === "TC-FORM-001")?.judged).toBe(false);
    expect(invalid).toEqual([]);
  });

  it("has no model of its own: without a provider or modelFor it refuses to start", async () => {
    await expect(QaBot.create({ config: config(), secrets })).rejects.toThrow(/No model/);
  });

  it("reads the model server's API key from its own store, and not from the store of the cases' secrets", async () => {
    fake = await FakeLlm.start({ script: ScriptSchema.parse(JSON.parse(readFileSync("tests/ci/scripts/TC-FORM-001.json", "utf8"))) });
    const key = "sk-live-abcdef1234567890";
    const settings = (c: Config) => {
      c.provider.kind = "openai-compatible";
      c.provider.baseUrl = fake!.baseUrl;
      c.provider.modelId = "fake-coder-14b";
      c.provider.apiKeySecret = "provider.key";
    };
    // The cases' store (the fixture's) has no such secret, as in the MCP server. The key comes from the provider's own store.
    const b = await QaBot.create({ config: config(settings), secrets, providerSecrets: new StaticSecretStore({ "provider.key": key }) });
    const result = await b.run({ target: site.origin, cases: [{ file: "cases/TC-FORM-001.yaml" }] });
    expect(result.exitCode).toBe(0);
    expect(fake.seen.every((s) => s.headers["authorization"] === `Bearer ${key}`)).toBe(true);
    expect(JSON.stringify(result.report)).not.toContain(key);
    expect(readFileSync(result.reportFile, "utf8")).not.toContain(key);
  });

  it("uses the live provider from the configuration, and the report says so", async () => {
    fake = await FakeLlm.start({ script: ScriptSchema.parse(JSON.parse(readFileSync("tests/ci/scripts/TC-FORM-001.json", "utf8"))) });
    const live = await QaBot.create({
      config: config((c) => {
        c.provider.kind = "openai-compatible";
        c.provider.baseUrl = fake!.baseUrl;
        c.provider.modelId = "fake-coder-14b";
      }),
      secrets,
    });
    expect(live.live).toBe(true);
    const result = await live.run({ target: site.origin, cases: [{ file: "cases/TC-FORM-001.yaml" }] });
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("fake-coder-14b (live)");
    expect(result.text).not.toContain("a scripted fake, not a language model");
  });
});
