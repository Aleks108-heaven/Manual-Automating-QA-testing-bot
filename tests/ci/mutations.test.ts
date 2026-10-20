// The pure matcher for undeclared state changes. The browser-level proof is T16 (mutation-blocking.test.ts).
import { describe, expect, it } from "vitest";
import { buildPolicy, checkRequest, checkWebSocketSend, isValidDeclaration, nextRequestAfterRedirect, parseDeclaration } from "../../src/tools/mutations.ts";

const base = "http://127.0.0.1:4173";
const policy = (declared: string[] = [], alwaysAllow: string[] = [], gets: string[] = ["/logout", "/delete*"]) => buildPolicy(declared, alwaysAllow, gets);
const gql = (body: unknown) => JSON.stringify(body);

describe("declarations", () => {
  it("parses the documented forms", () => {
    expect(parseDeclaration("POST /api/orders")).toEqual({ method: "POST", path: "/api/orders" });
    expect(parseDeclaration("POST /graphql#CreateOrder")).toEqual({ method: "POST", path: "/graphql", operation: "CreateOrder" });
    expect(parseDeclaration("WS /socket")).toEqual({ method: "WS", path: "/socket" });
    expect(parseDeclaration("DELETE /api/orders/*")).toEqual({ method: "DELETE", path: "/api/orders/*" });
  });

  it("rejects malformed declarations", () => {
    for (const bad of ["post /x", "POST x", "FETCH /x", "POST", "POST /a b", ""]) {
      expect(isValidDeclaration(bad), bad).toBe(false);
      expect(() => parseDeclaration(bad)).toThrow();
    }
  });
});

describe("what changes state", () => {
  const check = (method: string, path: string, declared: string[] = [], postData?: string) =>
    checkRequest({ method, url: base + path, ...(postData ? { postData } : {}) }, policy(declared));

  it("GET, HEAD and OPTIONS are safe", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) expect(check(m, "/anything")).toMatchObject({ allowed: true, changesState: false });
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s changes state and needs a declaration", (method) => {
    expect(check(method, "/api/x")).toMatchObject({ allowed: false, changesState: true, undeclared: [`${method} /api/x`] });
    expect(check(method, "/api/x", [`${method} /api/x`])).toMatchObject({ allowed: true, changesState: true });
  });

  it("a declaration covers only its own method and path", () => {
    expect(check("PUT", "/api/x", ["POST /api/x"]).allowed).toBe(false);
    expect(check("POST", "/api/y", ["POST /api/x"]).allowed).toBe(false);
    expect(check("POST", "/api/x/deeper", ["POST /api/x"]).allowed).toBe(false);
  });

  it("a star declares a path prefix", () => {
    expect(check("DELETE", "/api/orders/42", ["DELETE /api/orders/*"]).allowed).toBe(true);
    expect(check("DELETE", "/api/users/42", ["DELETE /api/orders/*"]).allowed).toBe(false);
  });

  it("the query string does not matter", () => {
    expect(checkRequest({ method: "POST", url: `${base}/api/x?token=1&a=b` }, policy(["POST /api/x"])).allowed).toBe(true);
  });

  it("a GET on the state-changing list needs a declaration", () => {
    expect(check("GET", "/logout")).toMatchObject({ allowed: false, undeclared: ["GET /logout"] });
    expect(check("GET", "/logout", ["GET /logout"]).allowed).toBe(true);
    expect(check("GET", "/delete/7")).toMatchObject({ allowed: false });
    expect(check("GET", "/account").allowed).toBe(true);
  });

  it("the always-allow list covers what the staging owner names", () => {
    const p = policy([], ["POST /api/telemetry"]);
    expect(checkRequest({ method: "POST", url: `${base}/api/telemetry` }, p).allowed).toBe(true);
    expect(checkRequest({ method: "POST", url: `${base}/api/other` }, p).allowed).toBe(false);
  });
});

describe("GraphQL", () => {
  const check = (body: unknown, declared: string[] = []) => checkRequest({ method: "POST", url: `${base}/graphql`, postData: gql(body) }, policy(declared));

  it("a query is not a state change, even though it is a POST", () => {
    expect(check({ query: "query Orders { orders { id } }" })).toMatchObject({ allowed: true, changesState: false });
    expect(check({ query: "{ orders { id } }" })).toMatchObject({ allowed: true, changesState: false });
    expect(check({ query: "query { orders { id } }", operationName: null })).toMatchObject({ changesState: false });
  });

  it("a mutation is a state change that must be declared by operation name", () => {
    const body = { query: "mutation CreateOrder($n: Int) { createOrder(n: $n) { id } }", operationName: "CreateOrder" };
    expect(check(body)).toMatchObject({ allowed: false, undeclared: ["POST /graphql#CreateOrder"] });
    expect(check(body, ["POST /graphql#CreateOrder"]).allowed).toBe(true);
    expect(check(body, ["POST /graphql#DeleteOrder"]).allowed).toBe(false);
  });

  it("declaring the path alone does not declare its mutations", () => {
    expect(check({ query: "mutation M { x }" }, ["POST /graphql"]).allowed).toBe(false);
  });

  it("the star declares every mutation at that path, on purpose", () => {
    expect(check({ query: "mutation Anything { x }" }, ["POST /graphql#*"]).allowed).toBe(true);
  });

  it("an anonymous mutation is named (anonymous)", () => {
    expect(check({ query: "mutation { x }" })).toMatchObject({ undeclared: ["POST /graphql#(anonymous)"] });
  });

  it("with several operations in one document, operationName picks the one that runs", () => {
    const query = "query Read { a } mutation Write { b }";
    expect(check({ query, operationName: "Read" })).toMatchObject({ changesState: false });
    expect(check({ query, operationName: "Write" })).toMatchObject({ changesState: true, undeclared: ["POST /graphql#Write"] });
  });

  it("a batch is a state change if any of its operations is, and every one must be declared", () => {
    const batch = [{ query: "query Q { a }" }, { query: "mutation A { a }" }, { query: "mutation B { b }" }];
    expect(check(batch, ["POST /graphql#A"])).toMatchObject({ allowed: false, undeclared: ["POST /graphql#B"] });
    expect(check(batch, ["POST /graphql#A", "POST /graphql#B"]).allowed).toBe(true);
  });

  it("comments and strings do not fool the reader", () => {
    expect(check({ query: '# mutation Evil { x }\nquery Q { a(arg: "mutation M { y }") }' })).toMatchObject({ changesState: false });
  });

  it("a persisted query with no text cannot be read, so it is treated as a mutation by its name", () => {
    expect(check({ operationName: "Persisted", extensions: { persistedQuery: { sha256Hash: "x" } } })).toMatchObject({ undeclared: ["POST /graphql#Persisted"] });
  });

  it("a POST body that is not GraphQL is an ordinary POST", () => {
    expect(checkRequest({ method: "POST", url: `${base}/api/x`, postData: gql({ name: "a" }) }, policy())).toMatchObject({ undeclared: ["POST /api/x"] });
  });
});

describe("websockets", () => {
  it("a message sent over a websocket is a state change that must be declared", () => {
    expect(checkWebSocketSend("ws://127.0.0.1:4173/socket", policy())).toMatchObject({ allowed: false, undeclared: ["WS /socket"] });
    expect(checkWebSocketSend("ws://127.0.0.1:4173/socket", policy(["WS /socket"])).allowed).toBe(true);
    expect(checkWebSocketSend("ws://127.0.0.1:4173/other", policy(["WS /socket"])).allowed).toBe(false);
  });
});

describe("redirects", () => {
  const original = { method: "POST", url: `${base}/api/a`, postData: '{"x":1}' };

  it("307 and 308 keep the method and the body", () => {
    for (const status of [307, 308]) expect(nextRequestAfterRedirect(original, status, "/api/b")).toEqual({ method: "POST", url: `${base}/api/b`, postData: '{"x":1}' });
  });

  it("301, 302 and 303 turn a POST into a GET without a body", () => {
    for (const status of [301, 302, 303]) expect(nextRequestAfterRedirect(original, status, "/api/b")).toEqual({ method: "GET", url: `${base}/api/b`, postData: null });
  });

  it("other statuses are not redirects, and an unreadable Location is ignored", () => {
    expect(nextRequestAfterRedirect(original, 200, "/api/b")).toBeNull();
    expect(nextRequestAfterRedirect(original, 307, "http://[bad")).toBeNull();
  });

  it("a redirect to a state-changing GET still needs a declaration", () => {
    const next = nextRequestAfterRedirect({ method: "GET", url: `${base}/x` }, 302, "/logout");
    expect(next).not.toBeNull();
    expect(checkRequest(next as NonNullable<typeof next>, policy()).allowed).toBe(false);
  });
});
