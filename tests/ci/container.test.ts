// Static checks on the runner image template and the script that runs it. They cannot prove that the
// image builds (that needs Docker), but they stop the isolation settings from being weakened by accident.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findFloatingInDockerfile } from "../../scripts/check-pins.ts";

const dockerfile = readFileSync("Dockerfile", "utf8");
const runScript = readFileSync("scripts/container-run.ps1", "utf8");
const dockerignore = readFileSync(".dockerignore", "utf8");

describe("runner image template", () => {
  it("is pinned by digest", () => {
    expect(findFloatingInDockerfile("Dockerfile", dockerfile)).toEqual([]);
    expect(dockerfile).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/m);
  });

  it("runs as a non-root user, and the last USER is not root", () => {
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
    expect(users.length).toBeGreaterThan(0);
    expect(users[users.length - 1]).not.toMatch(/^(root|0)$/);
  });

  it("does not turn the browser sandbox off, download and run scripts, or add remote files", () => {
    expect(dockerfile).not.toMatch(/no-sandbox|QA_BROWSER_SANDBOX/);
    expect(dockerfile).not.toMatch(/curl[^\n]*\|\s*(sh|bash)|wget[^\n]*\|\s*(sh|bash)/);
    expect(dockerfile).not.toMatch(/^ADD\s+https?:/m);
  });

  it("installs from the lockfile with npm ci", () => {
    expect(dockerfile).toMatch(/RUN npm ci\b/);
    expect(dockerfile).not.toMatch(/npm install/);
  });

  it("keeps secrets, runs and session files out of the image", () => {
    for (const pattern of ["node_modules", "runs", ".env", "secrets", "*.storage-state.json", "*.har", ".git"]) {
      expect(dockerignore.split(/\r?\n/)).toContain(pattern);
    }
  });
});

describe("container run script", () => {
  it.each(['"--network", "none"', '"--read-only"', '"--cap-drop", "ALL"', "no-new-privileges", '"--pids-limit"', '"--memory"'])("keeps the isolation setting %s", (setting) => {
    expect(runScript).toContain(setting);
  });

  it("turns the sandbox off only through an explicit switch", () => {
    expect(runScript).toMatch(/if \(\$NoSandbox\)/);
    expect(runScript).not.toMatch(/--privileged|--cap-add|--ipc[= ]host|--network[= ]host/);
  });
});
