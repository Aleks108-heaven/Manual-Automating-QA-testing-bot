// A browser shared by many runs, each in its own context. The guardrails must hold exactly as they do for a
// browser of its own: the allowlist, the host rule that stops redirect hops, and the sandbox.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { loadConfig } from "../../src/config.ts";
import { launchSharedBrowser, ToolLayer, type SharedBrowser } from "../../src/tools/tool-layer.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted } from "./helpers/run.ts";
import { startOutsideServer, type OutsideServer } from "./helpers/outside-server.ts";

let site: FixtureSite;
let outside: OutsideServer;
let shared: SharedBrowser;

beforeAll(async () => {
  outside = await startOutsideServer();
  site = await startFixtureSite({ outsideOrigin: outside.origin });
  shared = await launchSharedBrowser(loadConfig(), [new URL(site.origin).host]);
});
afterAll(async () => {
  await shared.close();
  await site.close();
  await outside.close();
});

const layer = (extra: Partial<Parameters<typeof ToolLayer.create>[0]> = {}) =>
  ToolLayer.create({ targetOrigin: site.origin, config: loadConfig(), runDir: mkdtempSync(join(tmpdir(), "qa-bot-shared-")), sharedBrowser: shared, ...extra });

describe("a shared browser", () => {
  it("serves several runs one after another, and is still running afterwards", async () => {
    for (let i = 0; i < 3; i += 1) {
      const { record } = await runScripted({ site, testCase: loadCase("cases/TC-FORM-001.yaml"), script: "tests/ci/scripts/TC-FORM-001.json", sharedBrowser: shared });
      expect(record.verdict, `run ${i}`).toBe("PASS");
    }
    expect(shared.browser.isConnected()).toBe(true);
    expect(shared.browser.contexts()).toHaveLength(0); // every run closed its own context
  });

  it("serves runs at the same time, each in its own context", async () => {
    const [a, b] = await Promise.all([
      runScripted({ site, testCase: loadCase("cases/TC-FORM-001.yaml"), script: "tests/ci/scripts/TC-FORM-001.json", sharedBrowser: shared }),
      runScripted({ site, testCase: loadCase("cases/TC-IMPL-001.yaml"), script: "tests/ci/scripts/TC-IMPL-001.json", sharedBrowser: shared }),
    ]);
    expect(a.record.verdict).toBe("PASS");
    expect(b.record.verdict).toBe("PASS");
    expect(a.record.versions.browser).toBe(b.record.versions.browser);
  });

  it("keeps runs apart: cookies from one run do not reach another", async () => {
    const one = await layer();
    const two = await layer();
    try {
      await one.runnerAccess().page().context().addCookies([{ name: "secret_cookie", value: "only-in-one", url: site.origin }]);
      await two.call("goto", { url: "/debug/session" });
      expect(await two.runnerAccess().page().locator("#cookie-echo").innerText()).not.toContain("only-in-one");
      await one.call("goto", { url: "/debug/session" });
      expect(await one.runnerAccess().page().locator("#cookie-echo").innerText()).toContain("only-in-one");
    } finally {
      await one.close();
      await two.close();
    }
  });

  it("does not close the browser when a run closes", async () => {
    const l = await layer();
    await l.close();
    expect(shared.browser.isConnected()).toBe(true);
  });
});

describe("the guardrails hold on a shared browser", () => {
  it("refuses another host, a redirect hop to it, and sends nothing there", async () => {
    const l = await layer();
    try {
      expect(await l.call("goto", { url: outside.origin + "/landed" })).toMatchObject({ ok: false, code: "blocked_by_guardrail" });
      expect(await l.call("goto", { url: "/trap/redirect" })).toMatchObject({ ok: false, code: "blocked_by_guardrail" });
      expect(outside.hits).toEqual([]);
    } finally {
      await l.close();
    }
  });

  it("starts without --no-sandbox", () => {
    const result =
      process.platform === "win32"
        ? spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" })
        : spawnSync("ps", ["-eo", "args"], { encoding: "utf8" });
    const lines = result.stdout.split(/\r?\n/).filter((l) => l.includes("ms-playwright") && l.includes("--remote-debugging-pipe") && !l.includes("--type=") && l.includes("--host-resolver-rules"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain("--no-sandbox");
  });

  it("refuses a run whose hosts the browser's host rule does not cover", async () => {
    await expect(layer({ targetOrigin: "http://127.0.0.1:1" })).rejects.toThrow(/does not cover: 127\.0\.0\.1:1/);
  });

  it("refuses a different sandbox setting, and refuses to switch the host rule off", async () => {
    const config = loadConfig();
    config.browser.sandbox = false;
    await expect(layer({ config })).rejects.toThrow(/different sandbox setting/);
    await expect(layer({ disableHostResolverRules: true })).rejects.toThrow(/always has the host rule/);
  });
});
