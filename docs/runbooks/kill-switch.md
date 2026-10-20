# Runbook: the kill switch

Owner: the kill-switch holder. Backup: the program owner. Last reviewed: 20 Oct 2026. The names are still [to fill] in the manual's Roles page.

The kill switch pauses the runner and revokes its credentials. One person can do it, at any time, without asking anyone. Use it when the bot misbehaves, when a credential or an injection attempt may have leaked, or when staging is being harmed.

## Pause

```powershell
node src/cli.ts kill-switch engage --by "<your name>" --reason "<what happened>" --target <the target's address>
```

What happens, in this order:

1. The paused state is written to a file (`.kill-switch.json` in the runs folder). From this moment every running run notices it, stops within a fraction of a second even if its model or a browser action is stuck, and ends INCOMPLETE. New runs refuse to start (exit code 3).
2. The runner's private session files are deleted.
3. The revoke calls in `config/default.json` (`killSwitch.revokeCalls`) run against the target. On the fixture they end every session and disable the bot accounts. For a real target the staging owner provides the real calls: disable the bot accounts and end their sessions.
4. Everything is written to the audit log (`.kill-switch-audit.jsonl`), including who and why.

Check it: `node src/cli.ts kill-switch status` shows PAUSED and what was revoked. A revoke call that failed is shown as FAILED. The runner is paused anyway, so fix the revoke by hand and note it in the incident.

Engaging twice changes nothing and is logged. If the configuration lists holders, only they can engage it, and a refusal is logged. If the state file is unreadable, the runner behaves as if the switch were engaged.

## Find out what happened

The run record, the guardrail events and the audit log say what the bot did. Do not resume until you know why it happened.

## Resume

You need three things:

1. **A completed review** of what happened, with a reference (a ticket or a document).
2. **A verified fix** with a reference (a change or a pull request), checked by someone other than the person who wrote it.
3. **A clean run:** a pre-flight report made after the fix, for resuming, in which every check passed and none was skipped. This includes the canary pair: the known-good case must PASS and its negative control must FAIL.

```powershell
node src/cli.ts preflight --for-resume --out resume-report.json --target <the target's address>
node src/cli.ts kill-switch resume --by "<your name>" --review "<review reference>" --fix "<fix reference>" --preflight-report resume-report.json --target <the target's address>
```

`--for-resume` lets the pre-flight check run while the switch is still engaged. The resume command refuses, and logs the refusal, if the switch is not engaged, if any of the three is missing, if the report is not clean, if it was not made for resuming, or if it is older than the pause. It restores access first (`killSwitch.restoreCalls`), and if that fails the runner stays paused. Only then does it clear the pause.

When the golden set exists (milestone M5), a clean golden-set run is also required.

## Drill

Before the pilot, run this on the real target: pause, check that runs refuse and that the bot account really is disabled, then resume with a real review and fix reference. The tests prove the mechanism on the fixture, not your staging environment.

## Limits

- The state is a file. Several runners on several machines need a shared store (a database row, or a flag in the secret manager), and a runner must check it.
- The bot cannot revoke what it does not hold. Keys and accounts outside the configured calls (the model provider's key, for example) must be revoked by hand, following the same incident.
