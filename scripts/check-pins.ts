// T10: fail on any floating version or tag in a manifest.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const SHA40 = /^[0-9a-f]{40}$/;

export interface PinProblem {
  file: string;
  where: string;
  value: string;
  reason: string;
}

type Deps = Record<string, string> | undefined;

function checkDeps(file: string, section: string, deps: Deps, out: PinProblem[]): void {
  for (const [name, spec] of Object.entries(deps ?? {})) {
    if (typeof spec !== "string" || !EXACT_SEMVER.test(spec)) {
      out.push({ file, where: `${section}.${name}`, value: String(spec), reason: "not an exact version" });
    }
  }
}

function checkOverrides(file: string, node: unknown, path: string, out: PinProblem[]): void {
  if (typeof node === "string") {
    // "$name" refers to a direct dependency, which is checked on its own.
    if (!node.startsWith("$") && !EXACT_SEMVER.test(node)) {
      out.push({ file, where: path, value: node, reason: "not an exact version" });
    }
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) checkOverrides(file, v, `${path}.${k}`, out);
  }
}

/** Checks the text of a package.json. */
export function findFloatingInPackageJson(file: string, text: string): PinProblem[] {
  const out: PinProblem[] = [];
  const pkg = JSON.parse(text) as Record<string, unknown>;
  checkDeps(file, "dependencies", pkg["dependencies"] as Deps, out);
  checkDeps(file, "devDependencies", pkg["devDependencies"] as Deps, out);
  checkDeps(file, "optionalDependencies", pkg["optionalDependencies"] as Deps, out);
  if (pkg["overrides"]) checkOverrides(file, pkg["overrides"], "overrides", out);
  return out;
}

/** Checks a GitHub Actions workflow: every `uses:` must be pinned to a full commit SHA. */
export function findFloatingInWorkflow(file: string, text: string): PinProblem[] {
  const out: PinProblem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line);
    if (!m) continue;
    const ref = m[1] as string;
    if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
    const at = ref.lastIndexOf("@");
    if (at < 0 || !SHA40.test(ref.slice(at + 1))) {
      out.push({ file, where: "uses", value: ref, reason: "not pinned to a full commit SHA" });
    }
  }
  return out;
}

/** Checks a Dockerfile: every FROM needs an exact tag or a digest, and never `latest`. */
export function findFloatingInDockerfile(file: string, text: string): PinProblem[] {
  const out: PinProblem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    if (!m) continue;
    const image = m[1] as string;
    if (image === "scratch") continue;
    const hasDigest = image.includes("@sha256:");
    const tag = image.includes(":") && !image.includes("@") ? image.slice(image.lastIndexOf(":") + 1) : undefined;
    if (!hasDigest && (!tag || tag === "latest")) {
      out.push({ file, where: "FROM", value: image, reason: "no digest and no exact tag" });
    }
  }
  return out;
}

function walk(dir: string, found: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "archive" || name === "runs") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, found);
    else found.push(full);
  }
}

/** Scans a repository root for every manifest this project uses. */
export function checkRepository(root: string): PinProblem[] {
  const files: string[] = [];
  walk(root, files);
  const out: PinProblem[] = [];
  for (const full of files) {
    const rel = relative(root, full).replaceAll("\\", "/");
    const base = rel.split("/").pop() as string;
    if (base === "package.json") out.push(...findFloatingInPackageJson(rel, readFileSync(full, "utf8")));
    else if (/^\.github\/workflows\/.+\.ya?ml$/.test(rel)) out.push(...findFloatingInWorkflow(rel, readFileSync(full, "utf8")));
    else if (/^Dockerfile(\..+)?$/.test(base)) out.push(...findFloatingInDockerfile(rel, readFileSync(full, "utf8")));
  }
  if (!existsSync(join(root, "package-lock.json"))) {
    out.push({ file: "package-lock.json", where: "lockfile", value: "missing", reason: "a committed lockfile is required" });
  }
  const npmrc = existsSync(join(root, ".npmrc")) ? readFileSync(join(root, ".npmrc"), "utf8") : "";
  if (!/^\s*save-exact\s*=\s*true\s*$/m.test(npmrc)) {
    out.push({ file: ".npmrc", where: "save-exact", value: "missing", reason: "save-exact=true is required" });
  }
  return out;
}

if (import.meta.main) {
  const problems = checkRepository(process.cwd());
  if (problems.length > 0) {
    for (const p of problems) console.error(`${p.file}: ${p.where} = ${p.value} (${p.reason})`);
    process.exit(1);
  }
  console.log("check:pins ok: every manifest uses exact versions.");
}
