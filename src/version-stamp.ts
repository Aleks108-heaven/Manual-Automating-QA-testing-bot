import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// A fingerprint of the bot's own code, for the report header (manual: Reading results). The product code may not start
// processes, so it cannot ask git for a commit. The hash covers every source file and the lockfile, so it also shows an
// edit that was never committed. Line endings are normalized, so a checkout with CRLF gives the same hash.

const cache = new Map<string, string>();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
    });
}

export function botSourceHash(root = "."): string {
  const cached = cache.get(root);
  if (cached) return cached;
  const hash = createHash("sha256");
  const files = [...sourceFiles(join(root, "src")), ...(existsSync(join(root, "package-lock.json")) ? [join(root, "package-lock.json")] : [])];
  for (const file of files) {
    hash.update(`${relative(root, file).replaceAll("\\", "/")}\n`);
    hash.update(readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
    hash.update("\n");
  }
  const value = hash.digest("hex");
  cache.set(root, value);
  return value;
}
