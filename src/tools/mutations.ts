// Undeclared state changes are blocked (manual: Guardrails, "Risky actions"). A request that can change state
// is allowed only if the case declares it, or the staging owner lists it as always allowed. This module is the
// pure part: it decides what counts as a state change and whether a declaration covers it.
//
// Declarations are written as:
//   POST /api/orders           any POST to that path
//   DELETE /api/orders/*       a path prefix (the star ends the pattern)
//   POST /graphql#CreateOrder  a GraphQL mutation by operation name
//   POST /graphql#*            every GraphQL mutation at that path (a deliberately visible choice)
//   WS /socket                 messages sent by the page over a websocket
//   GET /logout                a GET that changes state (also needed because GET is not safe by its method)

export interface Declaration {
  method: string;
  /** A path, or a path prefix when it ends with `*`. */
  path: string;
  /** A GraphQL operation name, or `*`. Absent for ordinary requests. */
  operation?: string;
}

const DECLARATION = /^(GET|POST|PUT|PATCH|DELETE|WS) (\/\S*?)(?:#(\S+))?$/;

export function isValidDeclaration(text: string): boolean {
  return DECLARATION.test(text);
}

export function parseDeclaration(text: string): Declaration {
  const m = DECLARATION.exec(text);
  if (!m) throw new Error(`Invalid mutation declaration "${text}". Use "METHOD /path", "POST /path#Operation" or "WS /path".`);
  return { method: m[1] as string, path: m[2] as string, ...(m[3] ? { operation: m[3] } : {}) };
}

export interface MutationPolicy {
  /** Declared by the case. */
  declared: Declaration[];
  /** Always allowed, supplied by the staging owner (for example a telemetry endpoint). */
  alwaysAllow: Declaration[];
  /** GET paths that change state, such as /logout. Exact, or a prefix when ending with `*`. */
  stateChangingGets: string[];
}

export function buildPolicy(declared: readonly string[], alwaysAllow: readonly string[], stateChangingGets: readonly string[]): MutationPolicy {
  return { declared: declared.map(parseDeclaration), alwaysAllow: alwaysAllow.map(parseDeclaration), stateChangingGets: [...stateChangingGets] };
}

const pathMatches = (pattern: string, path: string) => (pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern);

export interface RequestFacts {
  method: string;
  url: string;
  /** The request body, if any. Used to recognise GraphQL. */
  postData?: string | null;
}

export interface MutationCheck {
  /** False when something in the request changes state and is not declared. */
  allowed: boolean;
  /** True when the request changes state at all (declared or not). The tool layer follows redirects itself for these. */
  changesState: boolean;
  /** What needs declaring, for example "POST /api/orders" or "POST /graphql#CreateOrder". */
  labels: string[];
  /** The labels that are not declared. */
  undeclared: string[];
}

interface GraphQlOperation {
  name: string | null;
  kind: "query" | "mutation" | "subscription";
}

/** Reads the operations of a GraphQL document. Anonymous shorthand `{ ... }` is a query. */
function operationsOf(query: string): GraphQlOperation[] {
  const text = query.replace(/#[^\n]*/g, " ").replace(/"""[\s\S]*?"""/g, " ").replace(/"(?:\\.|[^"\\])*"/g, '""');
  const ops: GraphQlOperation[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "{") {
      if (depth === 0 && !/(query|mutation|subscription)[^{]*$/.test(text.slice(0, i).split("}").pop() ?? "")) ops.push({ name: null, kind: "query" });
      depth += 1;
    } else if (ch === "}") depth -= 1;
    else if (depth === 0) {
      const m = /^(query|mutation|subscription)\b\s*([A-Za-z_]\w*)?/.exec(text.slice(i));
      if (m) {
        ops.push({ name: m[2] ?? null, kind: m[1] as GraphQlOperation["kind"] });
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return ops;
}

interface GraphQlBody {
  query?: string;
  operationName?: string | null;
}

function graphQlBodies(postData: string | null | undefined): GraphQlBody[] | null {
  if (!postData) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(postData);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const bodies = list.filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
  const looksGraphQl = bodies.length > 0 && bodies.every((b) => typeof b["query"] === "string" || typeof b["operationName"] === "string" || "extensions" in b);
  return looksGraphQl ? bodies.map((b) => ({ ...(typeof b["query"] === "string" ? { query: b["query"] } : {}), operationName: typeof b["operationName"] === "string" ? b["operationName"] : null })) : null;
}

function covers(decl: Declaration, method: string, path: string, operation: string | undefined): boolean {
  if (decl.method !== method || !pathMatches(decl.path, path)) return false;
  if (operation === undefined) return decl.operation === undefined;
  return decl.operation === "*" || decl.operation === operation;
}

function evaluate(method: string, path: string, operations: Array<string | undefined>, policy: MutationPolicy): MutationCheck {
  const labels = operations.map((op) => `${method} ${path}${op === undefined ? "" : `#${op}`}`);
  const undeclared = operations
    .map((op, i) => ({ op, label: labels[i] as string }))
    .filter(({ op }) => ![...policy.declared, ...policy.alwaysAllow].some((d) => covers(d, method, path, op)))
    .map((x) => x.label);
  return { allowed: undeclared.length === 0, changesState: true, labels, undeclared };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const NOT_STATE_CHANGING: MutationCheck = { allowed: true, changesState: false, labels: [], undeclared: [] };

export function checkRequest(request: RequestFacts, policy: MutationPolicy): MutationCheck {
  const method = request.method.toUpperCase();
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return evaluate(method, request.url, [undefined], policy); // not a URL we can read: treat as a state change that is not declared
  }
  if (SAFE_METHODS.has(method)) {
    if (method === "GET" && policy.stateChangingGets.some((p) => pathMatches(p, path))) return evaluate("GET", path, [undefined], policy);
    return NOT_STATE_CHANGING;
  }
  const bodies = method === "POST" ? graphQlBodies(request.postData) : null;
  if (bodies) {
    const mutations: Array<string | undefined> = [];
    for (const body of bodies) {
      if (body.query === undefined) {
        // No query text (a persisted query): there is no way to tell, so treat it as a mutation by its name.
        mutations.push(body.operationName ?? "(unknown)");
        continue;
      }
      const ops = operationsOf(body.query);
      const chosen = body.operationName ? ops.filter((o) => o.name === body.operationName) : ops;
      const picked = chosen.length > 0 ? chosen : ops;
      for (const op of picked) if (op.kind === "mutation") mutations.push(op.name ?? body.operationName ?? "(anonymous)");
      if (picked.length === 0) mutations.push(body.operationName ?? "(unknown)"); // unreadable document: be safe
    }
    return mutations.length === 0 ? NOT_STATE_CHANGING : evaluate(method, path, mutations, policy);
  }
  return evaluate(method, path, [undefined], policy);
}

/** A message sent by the page over a websocket. */
export function checkWebSocketSend(url: string, policy: MutationPolicy): MutationCheck {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep the raw text */
  }
  return evaluate("WS", path, [undefined], policy);
}

/**
 * What a redirect does to the next request. 307 and 308 keep the method (and the body), so a POST stays a
 * POST. 301, 302 and 303 turn a POST into a GET. Returns the request the browser will send next.
 */
export function nextRequestAfterRedirect(original: RequestFacts, status: number, location: string): RequestFacts | null {
  if (![301, 302, 303, 307, 308].includes(status)) return null;
  let target: string;
  try {
    target = new URL(location, original.url).toString();
  } catch {
    return null;
  }
  const keeps = status === 307 || status === 308;
  const method = keeps ? original.method.toUpperCase() : original.method.toUpperCase() === "HEAD" ? "HEAD" : "GET";
  return { method, url: target, postData: keeps ? (original.postData ?? null) : null };
}
