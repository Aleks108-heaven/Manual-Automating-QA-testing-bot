// T10: dependencies are pinned. A CI check fails on any floating version or tag in a manifest.
import { describe, expect, it } from "vitest";
import {
  checkRepository,
  findFloatingInDockerfile,
  findFloatingInPackageJson,
  findFloatingInWorkflow,
  findLockfileProblems,
} from "../../scripts/check-pins.ts";

const SHA = "a".repeat(40);

describe("T10 dependency pins", () => {
  it("passes the real repository", () => {
    expect(checkRepository(process.cwd())).toEqual([]);
  });

  it.each(["^1.2.3", "~1.2.3", "*", "latest", "1.x", ">=1.0.0", "1.2", "github:user/repo", "https://example.com/x.tgz", "next"])(
    "rejects the floating package version %s",
    (spec) => {
      const problems = findFloatingInPackageJson("package.json", JSON.stringify({ dependencies: { a: spec } }));
      expect(problems).toHaveLength(1);
    },
  );

  it("accepts exact versions and prerelease exact versions", () => {
    const text = JSON.stringify({ dependencies: { a: "1.2.3" }, devDependencies: { b: "2.0.0-rc.1" } });
    expect(findFloatingInPackageJson("package.json", text)).toEqual([]);
  });

  it("checks devDependencies, optionalDependencies and nested overrides", () => {
    const text = JSON.stringify({
      devDependencies: { a: "^1.0.0" },
      optionalDependencies: { b: "~2.0.0" },
      overrides: { c: { d: "latest" } },
    });
    expect(findFloatingInPackageJson("package.json", text)).toHaveLength(3);
  });

  it("rejects workflow actions that are not pinned to a full commit SHA", () => {
    const text = [
      "steps:",
      "  - uses: actions/checkout@v4",
      "  - uses: actions/setup-node@main",
      `  - uses: actions/cache@${SHA}`,
    ].join("\n");
    const problems = findFloatingInWorkflow(".github/workflows/ci.yml", text);
    expect(problems.map((p) => p.value)).toEqual(["actions/checkout@v4", "actions/setup-node@main"]);
  });

  describe("lockfile contents", () => {
    const good = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { a: "1.0.0" } },
          "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-abc" },
          ...extra,
        },
      });
    const pkg = JSON.stringify({ dependencies: { a: "1.0.0" } });

    it("accepts a registry-only lockfile with integrity hashes that matches package.json", () => {
      expect(findLockfileProblems("package-lock.json", good(), pkg)).toEqual([]);
    });

    it("rejects a package resolved from another host, a git URL, or a plain http URL", () => {
      for (const resolved of ["https://evil.example.com/a-1.0.0.tgz", "git+ssh://git@github.com/x/y.git#abc", "http://registry.npmjs.org/a/-/a-1.0.0.tgz", "file:../a"]) {
        const text = good({ "node_modules/b": { version: "1.0.0", resolved, integrity: "sha512-abc" } });
        expect(findLockfileProblems("package-lock.json", text, pkg).map((p) => p.where), resolved).toEqual(["b"]);
      }
    });

    it("rejects a package with no integrity hash or a weak one", () => {
      for (const integrity of [undefined, "sha1-abc", ""]) {
        const text = good({ "node_modules/b": { version: "1.0.0", resolved: "https://registry.npmjs.org/b/-/b-1.0.0.tgz", ...(integrity === undefined ? {} : { integrity }) } });
        expect(findLockfileProblems("package-lock.json", text, pkg).length, String(integrity)).toBe(1);
      }
    });

    it("rejects linked packages, an old lockfile version, and a lockfile that disagrees with package.json", () => {
      expect(findLockfileProblems("package-lock.json", good({ "node_modules/b": { resolved: "../b", link: true } }), pkg)).toHaveLength(1);
      expect(findLockfileProblems("package-lock.json", good().replace('"lockfileVersion":3', '"lockfileVersion":2'), pkg).length).toBeGreaterThan(0);
      expect(findLockfileProblems("package-lock.json", good(), JSON.stringify({ dependencies: { a: "1.0.1" } }))).toHaveLength(1);
    });

    it("rejects an unparseable lockfile", () => {
      expect(findLockfileProblems("package-lock.json", "{ not json")).toHaveLength(1);
    });
  });

  it("rejects Dockerfile images with no digest and no exact tag", () => {
    const text = ["FROM node:latest", "FROM node", "FROM node:24.0.0", `FROM node@sha256:${"b".repeat(64)}`].join("\n");
    const problems = findFloatingInDockerfile("Dockerfile", text);
    expect(problems.map((p) => p.value)).toEqual(["node:latest", "node"]);
  });
});
