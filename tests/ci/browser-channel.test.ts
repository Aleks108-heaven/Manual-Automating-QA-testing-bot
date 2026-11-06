// Which browser the bot starts: the Chromium that Playwright downloads (the only pinned one), or the Chrome or Edge installed on the
// machine (Canary and Dev change from day to day, so they suit a check of compatibility and not an official run).
import { describe, expect, it } from "vitest";
import { configHash, loadConfig } from "../../src/config.ts";
import { browserLabel, browserLaunchOptions } from "../../src/tools/tool-layer.ts";
import { testConfig } from "./helpers/run.ts";

const load = (env: NodeJS.ProcessEnv) => loadConfig("config/default.json", env);

describe("browser channel", () => {
  it("is the bundled Chromium unless another is asked for", () => {
    expect(load({}).browser.channel).toBe("chromium");
    expect(browserLaunchOptions(testConfig(), ["--x"])).not.toHaveProperty("channel");
  });

  it("accepts Chrome and Edge channels by name, with an environment switch", () => {
    for (const channel of ["chrome", "chrome-beta", "chrome-dev", "chrome-canary", "msedge", "msedge-beta", "msedge-dev", "msedge-canary"]) {
      expect(load({ QA_BROWSER_CHANNEL: channel }).browser.channel).toBe(channel);
    }
  });

  it("refuses a browser that is not on the list: Firefox and WebKit would need another guard against redirect hops", () => {
    for (const bad of ["firefox", "firefox-dev", "webkit", "chrome-nightly", "Chrome"]) {
      expect(() => load({ QA_BROWSER_CHANNEL: bad })).toThrow(/channel/);
    }
  });

  it("passes the channel, the window setting and the host rule to the browser", () => {
    const config = testConfig((c) => Object.assign(c.browser, { channel: "chrome-canary", headed: true, slowMoMs: 300 }));
    expect(browserLaunchOptions(config, ["--host-resolver-rules=MAP * ~NOTFOUND"])).toEqual({
      chromiumSandbox: true,
      headless: false,
      slowMo: 300,
      channel: "chrome-canary",
      args: ["--host-resolver-rules=MAP * ~NOTFOUND"],
    });
    const bundled = browserLaunchOptions(testConfig(), ["--a"]);
    expect(bundled).toMatchObject({ chromiumSandbox: true, headless: true, slowMo: 0, args: ["--a"] });
  });

  it("names the channel in the browser a report shows, and shows the bare version for the bundled one", () => {
    expect(browserLabel(testConfig(), "153.0.8010.12")).toBe("153.0.8010.12");
    expect(browserLabel(testConfig((c) => Object.assign(c.browser, { channel: "msedge-dev" })), "154.0.1.2")).toBe("msedge-dev 154.0.1.2");
  });

  it("is part of the configuration fingerprint", () => {
    expect(configHash(load({ QA_BROWSER_CHANNEL: "chrome-canary" }))).not.toBe(configHash(load({})));
  });

  it("may not be used with the pinned container image, which pins the browser too", () => {
    expect(() => load({ QA_REQUIRE_CONTAINER: "1", QA_BROWSER_CHANNEL: "chrome-canary" })).toThrow(/pinned container image must use the browser that is pinned/);
    expect(load({ QA_REQUIRE_CONTAINER: "1" }).browser.channel).toBe("chromium");
  });
});
