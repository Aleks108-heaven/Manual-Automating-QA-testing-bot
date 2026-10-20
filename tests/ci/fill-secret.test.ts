// fill_secret: the model names a data entry of the case, the tool layer resolves the secret in code,
// and the value never comes back to the model.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { Redactor } from "../../src/redact/redactor.ts";
import { ToolLayer } from "../../src/tools/tool-layer.ts";
import { FIXTURE_SECRETS } from "../../fixtures/secrets.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";

const API_KEY = FIXTURE_SECRETS["fixture_apikey.value"] as string;
let site: FixtureSite;
let layer: ToolLayer | undefined;

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

async function newLayer(): Promise<{ layer: ToolLayer; redactor: Redactor }> {
  const redactor = new Redactor();
  redactor.add(API_KEY, "data.api_key");
  layer = await ToolLayer.create({
    targetOrigin: site.origin,
    config: loadConfig(),
    runDir: mkdtempSync(join(tmpdir(), "qa-bot-fs-")),
    redactor,
    caseData: { api_key: "secret:fixture_apikey.value", note: "plain text", other: "secret:someone_else.password" },
    secretValues: { api_key: API_KEY },
  });
  return { layer, redactor };
}

const apiKeyField = { selector: "#k" };

describe("fill_secret", () => {
  it("fills the field with the secret, and the result contains no value", async () => {
    const { layer: l } = await newLayer();
    await l.call("goto", { url: "/apikey" });
    const result = await l.call("fill_secret", { target: apiKeyField, data_key: "data.api_key" });
    expect(result).toEqual({ ok: true, data: { filled: "selector #k", data_key: "data.api_key" } });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(await l.runnerAccess().page().inputValue("#k")).toBe(API_KEY); // the runner can see it, the model cannot
  });

  it("refuses a data key the case does not declare, and one that is not a secret", async () => {
    const { layer: l } = await newLayer();
    await l.call("goto", { url: "/apikey" });
    expect(await l.call("fill_secret", { target: apiKeyField, data_key: "data.missing" })).toMatchObject({ ok: false, code: "secret_not_declared" });
    expect(await l.call("fill_secret", { target: apiKeyField, data_key: "data.note" })).toMatchObject({ ok: false, code: "secret_not_declared" });
    expect(await l.runnerAccess().page().inputValue("#k")).toBe("");
  });

  it("refuses a secret that is declared but could not be resolved", async () => {
    const { layer: l } = await newLayer();
    await l.call("goto", { url: "/apikey" });
    expect(await l.call("fill_secret", { target: apiKeyField, data_key: "data.other" })).toMatchObject({ ok: false, code: "secret_not_declared" });
  });

  it("refuses a name that is not a data key, so a secret cannot be asked for by name", async () => {
    const { layer: l } = await newLayer();
    await l.call("goto", { url: "/apikey" });
    for (const bad of ["secret:fixture_apikey.value", "fixture_apikey.value", "api_key", "data.", "data.a-b"]) {
      expect(await l.call("fill_secret", { target: apiKeyField, data_key: bad }), bad).toMatchObject({ ok: false, code: "invalid_args" });
    }
  });

  it("hides the value in later snapshots, even in a plain text field", async () => {
    const { layer: l } = await newLayer();
    await l.call("goto", { url: "/apikey" });
    await l.call("fill_secret", { target: apiKeyField, data_key: "data.api_key" });
    const snapshot = await l.call("snapshot", {});
    expect(JSON.stringify(snapshot)).not.toContain(API_KEY);
    // The key really is in the page, so this proves the scrubber did the work.
    expect(await l.runnerAccess().page().locator("body").ariaSnapshot()).toContain(API_KEY);
  });

  it("covers password inputs and filled-secret fields in screenshots", async () => {
    const { layer: l } = await newLayer();
    await l.call("goto", { url: "/apikey" });
    await l.call("fill_secret", { target: apiKeyField, data_key: "data.api_key" });
    const page = l.runnerAccess().page();
    const spy = vi.spyOn(page, "screenshot");
    await l.runnerAccess().screenshot();
    await l.call("screenshot", { label: "key" });
    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      const options = call[0] as { mask?: unknown[]; maskColor?: string } | undefined;
      expect(options?.mask?.length, "a password-input locator plus the filled field").toBe(2);
      expect(options?.maskColor).toBe("#000000");
    }
  });

  it("accepts the key on the page when it is the right one (the secret is real)", async () => {
    const { layer: l } = await newLayer();
    await l.call("goto", { url: "/apikey" });
    await l.call("fill_secret", { target: apiKeyField, data_key: "data.api_key" });
    await l.call("click", { target: { role: "button", name: "Save key" } });
    expect(await l.call("wait_for", { target: { role: "status" }, state: "visible" })).toMatchObject({ ok: true });
  });
});
