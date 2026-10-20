// T16: undeclared state changes are blocked.
// An undeclared non-GET request, GraphQL mutation, websocket send and state-changing GET are each blocked and
// logged, the run ends INCONCLUSIVE, and a declared one is allowed. The proof of a block is the fixture's own
// record: a blocked request never reaches the server.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCase, validateCase, CaseValidationError } from "../../src/cases/load.ts";
import { ToolLayer } from "../../src/tools/tool-layer.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted, testConfig } from "./helpers/run.ts";

let site: FixtureSite;
let layer: ToolLayer | undefined;
const T = { "x-fixture-test": "1", "content-type": "application/json" };

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});
beforeEach(async () => {
  await fetch(site.origin + "/__test/reset", { method: "POST", headers: T, body: "{}" });
});
const opened: ToolLayer[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((l) => l.close()));
  layer = undefined;
});

async function open(allowed: string[], change: (c: ReturnType<typeof testConfig>) => void = () => undefined): Promise<ToolLayer> {
  const config = testConfig(change);
  config.tools.actionTimeoutMs = 1500;
  layer = await ToolLayer.create({ targetOrigin: site.origin, config, runDir: mkdtempSync(join(tmpdir(), "qa-bot-t16-")), allowedMutations: allowed });
  opened.push(layer);
  await layer.call("goto", { url: "/mutations" });
  return layer;
}

const hits = async () => ((await (await fetch(site.origin + "/__test/hits", { headers: T })).json()) as { hits: string[] }).hits;
const mutationBlocks = (l: ToolLayer) => l.guardrails.blockedEvents().filter((e) => e.type === "mutation");
const click = (l: ToolLayer, name: string) => l.call("click", { target: { role: name === "Log out link" ? "link" : "button", name } });
const out = async (l: ToolLayer) => l.runnerAccess().page().locator("#out").innerText();

async function eventually(check: () => boolean | Promise<boolean>, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe("T16 undeclared state changes are blocked", () => {
  it.each([
    ["Send POST", "POST /api/m1"],
    ["Send PUT", "PUT /api/m1"],
    ["Send PATCH", "PATCH /api/m1"],
    ["Send DELETE", "DELETE /api/m1"],
  ])("%s is blocked and logged, and never reaches the server", async (button, label) => {
    const l = await open([]);
    await click(l, button);
    expect(await eventually(() => mutationBlocks(l).length > 0)).toBe(true);
    expect(mutationBlocks(l)[0]?.detail).toContain(`${label} is not declared in allowed_mutations`);
    expect(await hits()).toEqual([]);
  });

  it.each([
    ["Send POST", "POST /api/m1"],
    ["Send PUT", "PUT /api/m1"],
    ["Send PATCH", "PATCH /api/m1"],
    ["Send DELETE", "DELETE /api/m1"],
  ])("%s is allowed when declared", async (button, label) => {
    const l = await open([label]);
    await click(l, button);
    expect(await eventually(async () => (await out(l)).endsWith("200"))).toBe(true);
    expect(await hits()).toEqual([label]);
    expect(mutationBlocks(l)).toEqual([]);
  });

  it("declaring one method or path does not allow another", async () => {
    const l = await open(["POST /api/m1"]);
    await click(l, "Send PUT");
    expect(await eventually(() => mutationBlocks(l).length > 0)).toBe(true);
    expect(await hits()).toEqual([]);
  });

  it("a form submission (a navigation POST) is covered", async () => {
    const l = await open([]);
    await click(l, "Submit form");
    expect(await eventually(() => mutationBlocks(l).length > 0)).toBe(true);
    expect(mutationBlocks(l)[0]?.detail).toContain("POST /api/form-post");
    expect(await hits()).toEqual([]);

    const ok = await open(["POST /api/form-post"]);
    await click(ok, "Submit form");
    expect(await eventually(async () => (await ok.runnerAccess().page().locator("body").innerText()).includes("The form was posted."))).toBe(true);
  });

  it("a beacon is covered", async () => {
    const l = await open([]);
    await click(l, "Send beacon");
    expect(await eventually(() => mutationBlocks(l).length > 0)).toBe(true);
    expect(await hits()).toEqual([]);
  });

  it("a GET that changes state (the logout link) needs a declaration", async () => {
    const l = await open([]);
    await click(l, "Log out link");
    expect(await eventually(() => mutationBlocks(l).length > 0)).toBe(true);
    expect(mutationBlocks(l)[0]?.detail).toContain("GET /logout");
    expect(await hits()).toEqual([]);

    const ok = await open(["GET /logout"]);
    await click(ok, "Log out link");
    expect(await eventually(async () => (await hits()).includes("GET /logout"))).toBe(true);
    expect(mutationBlocks(ok)).toEqual([]);
  });

  it("the always-allow list, from the configuration, needs no declaration", async () => {
    const without = await open([]);
    await click(without, "Send telemetry");
    expect(await eventually(() => mutationBlocks(without).length > 0)).toBe(true);
    await without.close();

    const l = await open([], (c) => c.mutations.alwaysAllow.push("POST /api/telemetry"));
    await click(l, "Send telemetry");
    expect(await eventually(async () => (await out(l)).endsWith("204"))).toBe(true);
    expect(mutationBlocks(l)).toEqual([]);
  });
});

describe("T16 GraphQL", () => {
  it("a query needs no declaration, even though it is a POST", async () => {
    const l = await open([]);
    await click(l, "GraphQL query");
    expect(await eventually(async () => (await out(l)).endsWith("200"))).toBe(true);
    expect(mutationBlocks(l)).toEqual([]);
  });

  it("a mutation is blocked unless its operation name is declared", async () => {
    const l = await open([]);
    await click(l, "GraphQL mutation CreateOrder");
    expect(await eventually(() => mutationBlocks(l).length > 0)).toBe(true);
    expect(mutationBlocks(l)[0]?.detail).toContain("POST /graphql#CreateOrder");
    expect(await hits()).toEqual([]);
  });

  it("declaring one operation does not declare another", async () => {
    const l = await open(["POST /graphql#CreateOrder"]);
    await click(l, "GraphQL mutation CreateOrder");
    expect(await eventually(async () => (await out(l)).endsWith("200"))).toBe(true);
    await click(l, "GraphQL mutation DeleteOrder");
    expect(await eventually(() => mutationBlocks(l).length > 0)).toBe(true);
    expect(mutationBlocks(l)[0]?.detail).toContain("POST /graphql#DeleteOrder");
    expect(await hits()).toEqual(["POST /graphql"]); // only the declared one arrived
  });

  it("declaring the path alone does not declare its mutations, but the star does", async () => {
    const plain = await open(["POST /graphql"]);
    await click(plain, "GraphQL mutation CreateOrder");
    expect(await eventually(() => mutationBlocks(plain).length > 0)).toBe(true);
    await plain.close();

    const star = await open(["POST /graphql#*"]);
    await click(star, "GraphQL mutation CreateOrder");
    expect(await eventually(async () => (await out(star)).endsWith("200"))).toBe(true);
    expect(mutationBlocks(star)).toEqual([]);
  });
});

describe("T16 websockets", () => {
  it("a message sent by the page is blocked unless 'WS <path>' is declared", async () => {
    const l = await open([]);
    await click(l, "Open socket and send");
    expect(await eventually(() => mutationBlocks(l).length > 0)).toBe(true);
    expect(mutationBlocks(l)[0]?.detail).toContain("WS /socket");
    expect(await hits()).not.toContain("WS /socket message");
  });

  it("a declared websocket works both ways", async () => {
    const l = await open(["WS /socket"]);
    await click(l, "Open socket and send");
    expect(await eventually(async () => (await out(l)).includes("socket echo hello"))).toBe(true);
    expect(await hits()).toContain("WS /socket message");
    expect(mutationBlocks(l)).toEqual([]);
  });
});

describe("T16 redirects", () => {
  it("a declared POST that is redirected (307) to an undeclared path is stopped at the hop", async () => {
    const l = await open(["POST /api/redirect-post"]);
    await click(l, "POST that redirects");
    expect(await eventually(() => mutationBlocks(l).length > 0)).toBe(true);
    expect(mutationBlocks(l)[0]?.detail).toContain("POST /api/other");
    expect(mutationBlocks(l)[0]?.detail).toContain("redirect hop");
    const arrived = await hits();
    expect(arrived).toContain("POST /api/redirect-post"); // the declared request did happen
    expect(arrived).not.toContain("POST /api/other"); // the undeclared one did not
  });

  it("when both are declared the redirect is followed", async () => {
    const l = await open(["POST /api/redirect-post", "POST /api/other"]);
    await click(l, "POST that redirects");
    expect(await eventually(async () => (await out(l)).endsWith("200"))).toBe(true);
    expect(await hits()).toEqual(["POST /api/redirect-post", "POST /api/other"]);
    expect(mutationBlocks(l)).toEqual([]);
  });

  it("a longer chain is noticed after the fact (the limit of this guardrail), and the run still ends INCONCLUSIVE", async () => {
    const l = await open(["POST /api/redirect-chain", "POST /api/redirect-post"]);
    await click(l, "POST chain of redirects");
    expect(await eventually(() => mutationBlocks(l).length > 0)).toBe(true);
    expect(mutationBlocks(l)[0]?.detail).toMatch(/POST \/api\/other.*noticed after it was sent/);
    expect(l.guardrails.blocked).toBe(true);
  });
});

describe("T16 in a full run", () => {
  const caseWith = (allowed: string[]) =>
    validateCase({
      id: "TC-TEST-040",
      title: "Send a POST from the mutations page",
      priority: "P3",
      allowed_mutations: allowed,
      steps: ["open /mutations", "click the Send POST button"],
      expected: [{ id: "e1", after_step: 2, kind: "text_visible", where: { selector: "#out" }, text: "POST /api/m1 200", description: "The POST was answered" }],
    });
  const script = { case_id: "TC-TEST-040", steps: [[{ tool: "goto", args: { url: "/mutations" } }], [{ tool: "click", args: { target: { role: "button", name: "Send POST" } } }]] as never, observations: [], injection_suspected: false, notes: "" };

  it("an undeclared state change ends the run as INCONCLUSIVE, with the request named", async () => {
    const { record } = await runScripted({ site, testCase: caseWith([]), script });
    expect(record.verdict).toBe("INCONCLUSIVE");
    expect(record.verdict_row).toBe(2);
    const blocked = record.guardrail_events.filter((e) => e.decision === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ type: "mutation" });
    expect(blocked[0]?.detail).toContain("POST /api/m1 is not declared");
    expect(await hits()).toEqual([]);
  });

  it("the same case passes when it declares the request", async () => {
    const { record } = await runScripted({ site, testCase: caseWith(["POST /api/m1"]), script });
    expect(record.verdict).toBe("PASS");
    expect(record.guardrail_events.filter((e) => e.decision === "blocked")).toEqual([]);
  });

  it("a case that declares everything it needs has no block recorded", async () => {
    const { record } = await runScripted({ site, testCase: loadCase("cases/TC-FORM-001.yaml"), script: "tests/ci/scripts/TC-FORM-001.json" });
    expect(record.guardrail_events.filter((e) => e.decision === "blocked")).toEqual([]);
  });

  it("a malformed declaration is rejected when the case is loaded", () => {
    expect(() => validateCase({ id: "TC-TEST-041", title: "x", priority: "P3", allowed_mutations: ["post /api/x"], steps: ["a"], expected: [{ id: "e1", after_step: 1, kind: "url", equals: "/", description: "d" }] })).toThrow(CaseValidationError);
  });
});
