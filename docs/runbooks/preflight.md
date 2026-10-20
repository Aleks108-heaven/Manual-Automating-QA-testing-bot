# Runbook: the pre-flight check

Owner: the bot maintainer. Backup: the staging owner. Last reviewed: 20 Oct 2026.

Every run starts with the pre-flight check, and a failed check stops the run. You can also run it on its own:

```powershell
node src/cli.ts preflight [--cases cases/TC-ACCT-001.yaml] [--out report.json] [--target <address>]
```

Exit code 0 means no check failed. 2 means at least one failed. A skipped check does not stop a run, but it is reported as skipped.

## The checks, and what to do when one fails

| Check | It fails when | What to do |
| --- | --- | --- |
| runner is not paused | the kill switch is engaged | Follow the kill switch runbook. Do not work around it |
| provider reachable | the model provider does not answer | Check the provider's status and the key. If it is an outage, see the escalation table on the Roles page |
| quota left | the remaining allowance is below `preflight.minQuotaUsd` | Raise the cap or wait. The run would be cut off anyway |
| secrets valid | a secret the cases or roles use is missing or empty, or a role is unknown | Fix the secret store. The message names the secret, never its value |
| sessions fresh | a role cannot log in, or its session does not verify | The account may be locked, expired, or disabled. Check with the staging owner |
| runner image is the pinned one | the runner is not the container image the Dockerfile pins (only when `requireContainer` is true) | Run in the container. Never turn the requirement off for staging |
| target healthy | `GET /health` does not answer | Staging is unhealthy. Ask the staging owner |
| build is the expected one | the target reports a different build from `preflight.expectedBuild` | The wrong build is deployed, or the expectation is stale |
| canary cases behave | the known-good case does not PASS, or its negative control does not FAIL | The bot itself is broken. This check catches a bot that passes everything. Do not run cases until it is fixed |

If any earlier check fails, the canaries are skipped, because their result would mean nothing.

## Configuration

`preflight` in `config/default.json`: `requireHealthEndpoint`, `expectedBuild`, `minQuotaUsd`, `requireContainer`, `requireCanaries`, `canaryCases`, `dockerfile`. Environment overrides: `QA_CANARY_CASES`, `QA_REQUIRE_CANARIES`, `QA_REQUIRE_CONTAINER`, `QA_RUNNER_IMAGE_DIGEST`. Changing what the pre-flight check requires is a change to the bot and goes through review, like a change to a prompt.

## Staging settings (the fixture defaults are not for staging)

For staging, set `requireContainer` to true, set `expectedBuild` to the build under test, keep `requireCanaries` true with at least one canary pair, and give the provider status a live implementation.
