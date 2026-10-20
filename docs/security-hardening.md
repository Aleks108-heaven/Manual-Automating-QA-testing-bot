# Security hardening log

Started 20 Oct 2026, after a review of how a worm, a poisoned package, a malicious page, or an infected machine could reach the bot. This is an AI review and an AI-written fix list. It does not replace the independent human security review that the manual requires before the pilot.

## Correction to an earlier statement

An earlier review said the browser sandbox was on. **That was wrong.** Playwright adds `--no-sandbox` to Chromium unless the launch asks for `chromiumSandbox: true`, and M1 did not ask. It was found while hardening, by reading Playwright's source, and fixed. A test now starts the real browser and reads its command line, and it also proves the test can see `--no-sandbox` when the sandbox is switched off.

## Items

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Verify the lockfile in `check:pins`: registry host, sha512 integrity, no links, agrees with package.json, `ignore-scripts` required | Done | `tests/ci/pins.test.ts`, `scripts/check-pins.ts` |
| 2 | `npm ci` in automation, registry signatures and vulnerabilities checked | Done | `npm run ci`, `npm run check:supply-chain` (42 packages verified, 0 vulnerabilities on 20 Oct 2026) |
| 3 | Isolated container runner: pinned image, non-root, no network, read-only, no capabilities, limits | **Written, not verified.** Docker was not running | `Dockerfile`, `scripts/container-run.ps1`, `tests/ci/container.test.ts` (static checks only), runbook |
| 4 | Monthly update routine for packages and the browser | Done (procedure) | `docs/runbooks/updates.md`. Nobody owns the calendar reminder yet |
| 5 | Frozen scripts are code: human approval, stored hash, no unapproved execution | Done in the manual. The code arrives with M7 | Guardrails page, row "Frozen scripts" |
| 6 | Limit the LLM key's damage: spend cap, short-lived key, bot-only key, kill switch revokes it | Done in the manual. The code arrives with M2 and M4 | Guardrails page, row "Secrets and sessions" |
| 7 | No real malware in tests | Done in the manual | Guardrails page, injection test paragraph |
| 8 | Fixture test endpoints stay out of staging | Done in code and tests | Host-header check against DNS rebinding, the CLI refuses a loopback service that is not the fixture, a source scan keeps `fixtures/` out of `src/` except the CLI |

## Extra findings while hardening

- **DNS rebinding:** the fixture site accepted any Host header, so a web page the developer visits could have reached it. It now answers 421 to anything but its own loopback address.
- **Any loopback service was a valid `--target`.** The CLI now requires the target to identify itself as the fixture site.
- **`npm audit` cannot run nested inside an npm script** on npm 12 with install scripts disabled. The supply-chain check is a small Node script that runs npm directly.
- **Source scans** now guard against child processes, `eval`, disabled browser security features, and file writes outside the three modules that are meant to write (`tests/ci/isolation.test.ts`).

## Added by milestone M4

- **Undeclared state changes are blocked** at the request, websocket and first-redirect-hop level, with the fixture's own record proving that blocked requests never arrive (`tests/ci/mutation-blocking.test.ts`). This closes the part of "risky actions" that was only text before.
- **The kill switch** pauses the runner, deletes its private session files, runs the configured revoke calls, and keeps an audit log. It fails closed when its state file is unreadable.
- **The pre-flight check** refuses to start a run when the runner is paused, a secret or session is bad, the runner is not the pinned image, the target is unhealthy or the wrong build, or the canary pair does not behave. It would catch a bot that passes everything.
- **Configuration rule:** a configuration that requires the container may not switch the canaries off.
- Residual risks are in [m4-review.md](m4-review.md).

## Still open

- Verify the container runner once Docker is running, and decide how to keep the browser sandbox on inside it (a seccomp profile, or an explicit and recorded exception).
- The runner decision (build brief) must include an egress policy for staging.
- A scheduled owner for the monthly update routine.
- The independent human security review.
