// The search page of the fixture site and the three cases written for it. The cases are the worked example for a tester: a form that
// sends a GET request, a result list, a count, and a message when nothing matches. Each must PASS, and its negative control must FAIL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCase } from "../../src/cases/load.ts";
import { negativeControl } from "../../src/cases/mutate.ts";
import { startFixtureSite, type FixtureSite } from "../../fixtures/site/server.ts";
import { runScripted } from "./helpers/run.ts";

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

const IDS = ["TC-SRCH-001", "TC-SRCH-002", "TC-SRCH-003"] as const;

describe("the search page", () => {
  const get = async (path: string) => (await fetch(site.origin + path)).text();

  it("finds items by a word in their title, ignoring capitals", async () => {
    const html = await get("/search?q=NoteBook");
    expect(html).toContain('<p role="status">3 results for "NoteBook"</p>');
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(await get("/search?q=pencil")).toContain("2 results");
    expect(await get("/search?q=stand")).toContain('1 result for "stand"');
  });

  it("says when nothing matches and when there is no term", async () => {
    expect(await get("/search?q=zzz")).toContain('<p role="status">No results for "zzz"</p>');
    expect(await get("/search?q=")).toContain('<p role="alert">Enter a search term</p>');
    expect(await get("/search?q=%20%20")).toContain("Enter a search term");
    expect(await get("/search")).not.toContain("role=\"status\"");
  });

  it("does not run what a query contains: the query is escaped, in the message and in the field", async () => {
    const evil = encodeURIComponent('"><img src=x onerror=alert(1)><script>alert(2)</script>');
    const html = await get(`/search?q=${evil}`);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("is linked from the home page, and a search is a read: it changes nothing", async () => {
    expect(await get("/")).toContain('<a href="/search">Search</a>');
    await get("/search?q=notebook");
    const hits = (await (await fetch(site.origin + "/__test/hits", { headers: { "x-fixture-test": "1" } })).json()) as { hits: string[] };
    expect(hits.hits.filter((h) => h.includes("/search"))).toEqual([]);
  });
});

describe("the search cases", () => {
  for (const id of IDS) {
    it(`${id} passes, and its negative control fails`, async () => {
      const testCase = loadCase(`cases/${id}.yaml`);
      const script = `tests/ci/scripts/${id}.json`;
      const pass = await runScripted({ site, testCase, script });
      expect(pass.record.verdict, JSON.stringify(pass.record.outcomes)).toBe("PASS");
      const fail = await runScripted({ site, testCase: negativeControl(testCase).testCase, script });
      expect(fail.record.verdict).toBe("FAIL");
    });
  }

  it("a search that finds the wrong number of items is a FAIL, not a PASS", async () => {
    // The page now finds another set of items, so the count in TC-SRCH-001 no longer holds. The bot must say so.
    const testCase = loadCase("cases/TC-SRCH-001.yaml");
    const changed = { ...testCase, data: { query: "pen" } }; // "pen" finds 2 items ("Blue pen", "Pencil case" is not a match; "Green pencil" is)
    const { record } = await runScripted({ site, testCase: changed, script: { case_id: "TC-SRCH-001", steps: [[{ tool: "goto", args: { url: "/search" } }], [{ tool: "fill", args: { target: { role: "searchbox", name: "Search" }, value: "pen" } }], [{ tool: "click", args: { target: { role: "button", name: "Search" } } }]], observations: [], injection_suspected: false, notes: "" } });
    expect(record.verdict).toBe("FAIL");
    expect(JSON.stringify(record.outcomes)).toContain("MISMATCH");
  });
});
