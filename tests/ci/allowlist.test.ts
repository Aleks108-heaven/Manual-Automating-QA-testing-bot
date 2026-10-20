// T1: the allowlist is enforced in the tool layer.
// goto, a link click, a redirect, a popup or new tab, an iframe, a websocket, and file:, data:
// and javascript: URLs pointing outside the allowlist are all refused and logged.
// Proof of refusal: a second server on another host counts every connection it receives, and it
// must receive none. The suite runs twice: with the outside server on a different host name
// (localhost) and on a different IP literal (127.0.0.2), which DNS-style rules would not catch.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { ToolLayer, type ToolLayerOptions } from "../../src/tools/tool-layer.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { startOutsideServer, type OutsideServer } from "./helpers/outside-server.ts";

async function eventually(check: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

const blocked = (l: ToolLayer, type?: string) => l.guardrails.blockedEvents().filter((e) => (type ? e.type === type : true));

for (const host of ["localhost", "127.0.0.2"] as const) {
  describe(`T1 allowlist is enforced in the tool layer (outside host ${host})`, () => {
    let site: FixtureSite;
    let outside: OutsideServer;
    let layer: ToolLayer | undefined;

    beforeAll(async () => {
      outside = await startOutsideServer(host);
      site = await startFixtureSite({ outsideOrigin: outside.origin });
    });
    afterAll(async () => {
      await site.close();
      await outside.close();
    });
    afterEach(async () => {
      await layer?.close();
      layer = undefined;
      outside.hits.length = 0;
    });

    async function newLayer(extra: Partial<ToolLayerOptions> = {}): Promise<ToolLayer> {
      layer = await ToolLayer.create({
        targetOrigin: site.origin,
        config: loadConfig(),
        runDir: mkdtempSync(join(tmpdir(), "qa-bot-t1-")),
        ...extra,
      });
      return layer;
    }

    it("allows the target (control)", async () => {
      const l = await newLayer();
      const result = await l.call("goto", { url: "/form" });
      expect(result.ok).toBe(true);
      expect(blocked(l)).toEqual([]);
    });

    it("refuses goto to another host, logs it, and sends nothing there", async () => {
      const l = await newLayer();
      const result = await l.call("goto", { url: outside.origin + "/landed" });
      expect(result).toMatchObject({ ok: false, code: "blocked_by_guardrail" });
      expect(blocked(l, "navigation")[0]?.url).toBe(outside.origin + "/landed");
      expect(outside.hits).toEqual([]);
    });

    it.each(["file:///C:/Windows/win.ini", "data:text/html,<h1>x</h1>", "javascript:document.title='x'"])("refuses goto to %s", async (url) => {
      const l = await newLayer();
      const result = await l.call("goto", { url });
      expect(result).toMatchObject({ ok: false, code: "blocked_by_guardrail" });
      expect(blocked(l, "scheme")).toHaveLength(1);
    });

    it("refuses a redirect to another host at the redirect hop, and logs it", async () => {
      const l = await newLayer();
      const result = await l.call("goto", { url: "/trap/redirect" });
      expect(result).toMatchObject({ ok: false, code: "blocked_by_guardrail" });
      expect(blocked(l).some((e) => e.url.startsWith(outside.origin) && e.detail.includes("redirect hop"))).toBe(true);
      expect(outside.hits).toEqual([]);
    });

    it("refuses link clicks to data:, javascript: and file: targets without clicking", async () => {
      const l = await newLayer();
      await l.call("goto", { url: "/trap/schemes" });
      for (const id of ["data-link", "js-link", "file-link"]) {
        const result = await l.call("click", { target: { selector: `#${id}` } });
        expect(result, id).toMatchObject({ ok: false, code: "blocked_by_guardrail" });
      }
      expect(blocked(l, "scheme")).toHaveLength(3);
      // The javascript: link did not run, so the page title is unchanged.
      expect(await l.runnerAccess().page().title()).toBe("Scheme trap");
    });

    it("removes a data: iframe that the route handler cannot see, and logs it", async () => {
      const l = await newLayer();
      await l.call("goto", { url: "/trap/schemes" });
      expect(await eventually(() => blocked(l, "frame").length > 0)).toBe(true);
      expect(await eventually(() => l.runnerAccess().page().frames().length === 1)).toBe(true);
    });

    it("refuses a link click that would open another host in a new tab", async () => {
      const l = await newLayer();
      await l.call("goto", { url: "/trap/popup" });
      const result = await l.call("click", { target: { selector: "#popup-link" } });
      expect(result).toMatchObject({ ok: false, code: "blocked_by_guardrail" });
      expect(outside.hits).toEqual([]);
    });

    it("blocks and closes a popup opened by script, and sends nothing there", async () => {
      const l = await newLayer();
      await l.call("goto", { url: "/trap/popup" });
      await l.call("click", { target: { selector: "#popup-button" } });
      expect(await eventually(() => blocked(l).some((e) => e.url.startsWith(outside.origin)))).toBe(true);
      expect(await eventually(() => l.runnerAccess().page().context().pages().length === 1)).toBe(true);
      expect(outside.hits).toEqual([]);
    });

    it("blocks an iframe that points to another host", async () => {
      const l = await newLayer();
      await l.call("goto", { url: "/trap/iframe" });
      expect(await eventually(() => blocked(l, "frame").length > 0)).toBe(true);
      expect(outside.hits).toEqual([]);
    });

    it("blocks a websocket to another host", async () => {
      const l = await newLayer();
      await l.call("goto", { url: "/trap/ws" });
      expect(await eventually(() => blocked(l, "websocket").length > 0)).toBe(true);
      expect(outside.hits).toEqual([]);
    });

    it("blocks subresources (image, fetch) on another host", async () => {
      const l = await newLayer();
      await l.call("goto", { url: "/trap/subresource" });
      expect(await eventually(() => blocked(l, "request").length >= 2)).toBe(true);
      expect(outside.hits).toEqual([]);
    });

    it("validates tool arguments and names", async () => {
      const l = await newLayer();
      expect(await l.call("goto", {})).toMatchObject({ ok: false, code: "invalid_args" });
      expect(await l.call("click", { target: { role: "button" }, extra: 1 })).toMatchObject({ ok: false, code: "invalid_args" });
      expect(await l.call("shell", { cmd: "dir" })).toMatchObject({ ok: false, code: "unknown_tool" });
    });

    // Canary. It documents WHY the browser host rule is mandatory: with only the route handler, the
    // redirect hop reaches the outside host. If Playwright ever starts routing redirect hops, this
    // test fails, and the reason for the rule should be reviewed (the rule itself should stay).
    it("canary: the route handler alone does not see redirect hops", async () => {
      const l = await newLayer({ disableHostResolverRules: true });
      await l.call("goto", { url: "/trap/redirect" });
      expect(await eventually(() => outside.hits.length > 0)).toBe(true);
    });
  });
}
