// The tools the model can use, other than the allowlist (that is T1). Error codes matter because the
// agent loop and, later, the verdict depend on telling "the element is missing" from "the locator is ambiguous".
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { ToolLayer } from "../../src/tools/tool-layer.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";

let site: FixtureSite;
let layer: ToolLayer | undefined;
let runDir = "";

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});
afterEach(async () => {
  await layer?.close();
  layer = undefined;
});

async function newLayer(): Promise<ToolLayer> {
  const config = loadConfig();
  config.tools.actionTimeoutMs = 600;
  runDir = mkdtempSync(join(tmpdir(), "qa-bot-tools-"));
  layer = await ToolLayer.create({ targetOrigin: site.origin, config, runDir, allowedMutations: ["POST /api/subscribe"] });
  return layer;
}

describe("tool results and error codes", () => {
  it("reports element_missing when the target does not exist", async () => {
    const l = await newLayer();
    await l.call("goto", { url: "/form" });
    expect(await l.call("click", { target: { role: "button", name: "No such button" } })).toMatchObject({ ok: false, code: "element_missing" });
    expect(await l.call("fill", { target: { selector: "#nope" }, value: "x" })).toMatchObject({ ok: false, code: "element_missing" });
    expect(await l.call("wait_for", { target: { selector: "#nope" }, state: "visible", timeout_ms: 300 })).toMatchObject({ ok: false, code: "element_missing" });
  });

  it("reports ambiguous when a locator matches more than one element", async () => {
    const l = await newLayer();
    await l.call("goto", { url: "/" });
    expect(await l.call("click", { target: { role: "link" } })).toMatchObject({ ok: false, code: "ambiguous" });
  });

  it("fills, presses a key, and waits for a result", async () => {
    const l = await newLayer();
    await l.call("goto", { url: "/form" });
    expect(await l.call("fill", { target: { role: "textbox", name: "Email" }, value: "nope" })).toMatchObject({ ok: true });
    expect(await l.call("press", { key: "Enter", target: { role: "textbox", name: "Email" } })).toMatchObject({ ok: true });
    expect(await l.call("wait_for", { target: { role: "alert" }, state: "visible" })).toMatchObject({ ok: true });
  });

  it("returns a page snapshot, and saves a screenshot file", async () => {
    const l = await newLayer();
    await l.call("goto", { url: "/form" });
    const snap = await l.call("snapshot", {});
    expect(snap.ok && JSON.stringify(snap.data)).toContain("Newsletter signup");
    const shot = await l.call("screenshot", { label: "form page" });
    expect(shot.ok).toBe(true);
    const files = readdirSync(join(runDir, "shots"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^shot-001-form_page\.png$/);
    expect(existsSync(join(runDir, "shots", files[0] as string))).toBe(true);
  });

  it("reports console errors and failed or error responses", async () => {
    const l = await newLayer();
    await l.call("goto", { url: "/form" });
    await l.runnerAccess().page().evaluate(() => console.error("boom from the page"));
    const consoleResult = await l.call("console_errors", {});
    expect(consoleResult.ok && JSON.stringify(consoleResult.data)).toContain("boom from the page");
    await l.call("goto", { url: "/no-such-page" });
    const network = await l.call("network_errors", {});
    expect(network.ok && JSON.stringify(network.data)).toContain("/no-such-page");
  });

  it("does not let a screenshot label escape the shots directory", async () => {
    const l = await newLayer();
    await l.call("goto", { url: "/form" });
    await l.call("screenshot", { label: "..\\..\\evil" });
    const files = readdirSync(join(runDir, "shots"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/[\\/]/);
  });
});
