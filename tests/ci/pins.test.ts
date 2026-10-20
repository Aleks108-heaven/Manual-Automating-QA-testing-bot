// T10: dependencies are pinned. A CI check fails on any floating version or tag in a manifest.
import { describe, expect, it } from "vitest";
import {
  checkRepository,
  findFloatingInDockerfile,
  findFloatingInPackageJson,
  findFloatingInWorkflow,
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

  it("rejects Dockerfile images with no digest and no exact tag", () => {
    const text = ["FROM node:latest", "FROM node", "FROM node:24.0.0", `FROM node@sha256:${"b".repeat(64)}`].join("\n");
    const problems = findFloatingInDockerfile("Dockerfile", text);
    expect(problems.map((p) => p.value)).toEqual(["node:latest", "node"]);
  });
});
