// Checks the installed packages against the npm registry: known vulnerabilities, then the registry
// signatures of every installed package. It needs network access, so it is not part of `npm run check`.
// It runs npm as a child process with npm's own settings stripped from the environment, because
// npm 12 refuses to run `npm audit` nested inside an npm script when install scripts are disabled.
import { spawnSync } from "node:child_process";

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_(config|lifecycle|package|command|execpath|node_execpath)/i.test(key)));

let failed = false;
for (const command of ["npm audit", "npm audit signatures"]) {
  console.log(`> ${command}`);
  // One fixed command string, so nothing from outside reaches the shell.
  const result = spawnSync(command, { shell: true, stdio: "inherit", env });
  if (result.status !== 0) failed = true;
}
if (failed) {
  console.error("check:supply-chain failed. Do not update or deploy until the cause is understood.");
  process.exit(1);
}
console.log("check:supply-chain ok.");
