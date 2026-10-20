// Hardening: the Chromium sandbox must be ON. Playwright adds --no-sandbox unless it is told
// chromiumSandbox: true, so this test looks at the real browser processes' command lines.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { ToolLayer } from "../../src/tools/tool-layer.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";

function browserCommandLines(): string[] {
  const result =
    process.platform === "win32"
      ? spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" })
      : spawnSync("ps", ["-eo", "args"], { encoding: "utf8" });
  return result.stdout.split(/\r?\n/).filter((l) => l.includes("ms-playwright") && l.includes("--remote-debugging-pipe") && !l.includes("--type="));
}

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

async function launched(sandbox: boolean): Promise<string[]> {
  const config = loadConfig();
  config.browser.sandbox = sandbox;
  const layer = await ToolLayer.create({ targetOrigin: site.origin, config, runDir: mkdtempSync(join(tmpdir(), "qa-bot-sandbox-")) });
  try {
    expect(layer.runnerAccess().browserSandbox).toBe(sandbox);
    return browserCommandLines();
  } finally {
    await layer.close();
  }
}

describe("browser sandbox", () => {
  it("is on by default in the shipped configuration", () => {
    expect(loadConfig().browser.sandbox).toBe(true);
  });

  it("starts the browser without --no-sandbox when the sandbox is on", async () => {
    const lines = await launched(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain("--no-sandbox");
  });

  it("the check can see --no-sandbox, so the test above is meaningful", async () => {
    const lines = await launched(false);
    expect(lines.some((l) => l.includes("--no-sandbox"))).toBe(true);
  });

  it("can only be turned off explicitly through the environment", () => {
    expect(loadConfig("config/default.json", { QA_BROWSER_SANDBOX: "off" }).browser.sandbox).toBe(false);
    expect(loadConfig("config/default.json", { QA_BROWSER_SANDBOX: "0" }).browser.sandbox).toBe(true);
  });
});
