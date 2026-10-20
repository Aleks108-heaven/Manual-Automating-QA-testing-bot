// Session setup: creates a logged-in browser session for a role OUTSIDE the model's context
// (manual: Guardrails, "Secrets and sessions"). The runner logs in through the application's login API,
// builds a Playwright storage state from the Set-Cookie headers, and keeps it in a private folder that is
// not the run directory. The model never sees the login, the credentials, or the session file.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { Redactor } from "../redact/redactor.ts";
import { parseSecretRef, type SecretStore } from "../secrets/store.ts";

/** A session problem. The message never contains a credential or a token. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export interface EstablishedSession {
  role: string;
  /** Path of the Playwright storage state, or null for role "none". */
  storageStatePath: string | null;
  cleanup(): void;
}

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}

/** Parses one Set-Cookie header into a Playwright cookie for the given host. */
export function parseSetCookie(header: string, host: string): StorageStateCookie {
  const [pair = "", ...attrs] = header.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  if (eq < 1) throw new SessionError("the login answered with a Set-Cookie header that cannot be read");
  const cookie: StorageStateCookie = {
    name: pair.slice(0, eq),
    value: pair.slice(eq + 1),
    domain: host,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  };
  for (const attr of attrs) {
    const [k = "", ...v] = attr.split("=");
    const key = k.toLowerCase();
    const val = v.join("=");
    if (key === "path" && val) cookie.path = val;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite") cookie.sameSite = /^strict$/i.test(val) ? "Strict" : /^none$/i.test(val) ? "None" : "Lax";
    else if (key === "max-age" && /^-?\d+$/.test(val)) cookie.expires = Math.floor(Date.now() / 1000) + Number(val);
    else if (key === "expires" && Number.isFinite(Date.parse(val))) cookie.expires = Math.floor(Date.parse(val) / 1000);
  }
  return cookie;
}

async function secret(store: SecretStore, ref: string, what: string): Promise<string> {
  const name = parseSecretRef(ref);
  if (!name) throw new SessionError(`the ${what} for this role is not a secret reference`);
  try {
    return await store.get(name);
  } catch (error) {
    throw new SessionError(`the ${what} for this role is unavailable: ${(error as Error).message}`);
  }
}

export interface EstablishOptions {
  role: string;
  config: Config;
  secrets: SecretStore;
  targetOrigin: string;
  runId: string;
  runDir: string;
  redactor: Redactor;
}

export async function establishSession(options: EstablishOptions): Promise<EstablishedSession> {
  const { role, config, targetOrigin, redactor } = options;
  if (role === "none") return { role, storageStatePath: null, cleanup() {} };

  const roleConfig = config.roles[role];
  if (!roleConfig) throw new SessionError(`unknown role "${role}" (known roles: ${Object.keys(config.roles).join(", ") || "none configured"})`);

  const dir = resolve(config.sessions.directory);
  const runDir = resolve(options.runDir);
  const rel = relative(runDir, dir);
  if (rel === "" || !rel.startsWith("..")) {
    throw new SessionError("the session directory must not be inside the run directory, because the run directory is stored and shared");
  }

  const username = await secret(options.secrets, roleConfig.login.username, "username");
  const password = await secret(options.secrets, roleConfig.login.password, "password");
  redactor.add(password, `${role}.password`);

  let response: Response;
  try {
    response = await fetch(targetOrigin + roleConfig.login.path, {
      method: "POST",
      headers: { "content-type": "application/json", ...config.testApi.headers },
      body: JSON.stringify({ [roleConfig.login.usernameField]: username, [roleConfig.login.passwordField]: password }),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new SessionError(`the login for role "${role}" could not reach the target: ${(error as Error).name}`);
  }
  if (!response.ok) throw new SessionError(`the login for role "${role}" was refused with status ${response.status}`);

  const host = new URL(targetOrigin).hostname;
  const cookies = response.headers.getSetCookie().map((h) => parseSetCookie(h, host));
  if (cookies.length === 0) throw new SessionError(`the login for role "${role}" did not set a session cookie`);
  for (const cookie of cookies) {
    // Every token that could appear in a page, a header or a log is protected from now on.
    if (cookie.value.length >= 4) redactor.add(cookie.value, `${role}.cookie.${cookie.name}`);
  }

  // Prove the session works before the case starts, so a stale or broken login is not mistaken for a failure of the case.
  const check = await fetch(targetOrigin + roleConfig.verifyPath, {
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!check || check.status !== 200) {
    throw new SessionError(`the session for role "${role}" did not verify (${verifyPathSummary(roleConfig.verifyPath, check?.status)})`);
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${options.runId}-${role}.json`);
  writeFileSync(file, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // best effort; Windows applies the folder's permissions
  } catch {
    /* not supported on this file system */
  }
  return {
    role,
    storageStatePath: file,
    cleanup() {
      rmSync(file, { force: true });
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    },
  };
}

function verifyPathSummary(path: string, status: number | undefined): string {
  return `${path} answered ${status ?? "nothing"}`;
}
