## Roles and decision rights

Every duty has a named owner and a backup, and one person can pause the bot at any time without asking anyone.

| Role | Responsible for | Name | Backup |
| --- | --- | --- | --- |
| Program owner | Scope, stage changes, risk acceptance | [to fill] | [to fill] |
| Bot maintainer | Prompts, tools, runner, upgrades, golden set | [to fill] | [to fill] |
| Triager (rotating) | Reviews every FAIL, BLOCKED, INCONCLUSIVE, INCOMPLETE | [to fill] | [to fill] |
| Case curators (QA) | Write and maintain bot-ready cases | [to fill] | [to fill] |
| Security reviewer | Runner threat model, injection tests, findings | [to fill] | [to fill] |
| Approver | Auto-fixes, quarantines, verdict overrides | [to fill] | [to fill] |
| Budget owner | Spend caps and forecast | [to fill] | [to fill] |
| Staging owner | Environment access and shared-environment agreements | [to fill] | [to fill] |
| Kill-switch holder | Pauses the runner and revokes its credentials | [to fill] | [to fill] |

One person may hold several roles, but no role may be unowned and the maintainer should not be the only PASS auditor.

**Small team.** In a pilot team, merge roles like this: [to fill: your merges]. Keep two minimums: the security reviewer and at least one design reviewer are not the maintainer, and the kill switch has a named backup.

**Decision rights**

- Changing the stage: the program owner, after a review with independent reviewers.
- Overriding a bot FAIL: the approver, with a recorded triage result and the evidence attached. Every override is logged and reviewed monthly.
- Quarantining a case: the approver, with a named owner and a deadline.
- Pausing the bot: the kill-switch holder or the program owner, with no approval needed. Resuming needs a completed review, a verified fix, and a clean run (a clean pre-flight report and a clean golden-set report, both newer than the pause).
- Release go or no-go: [to fill: the existing release decision-maker]. A bot PASS is evidence for that decision, never the decision.

**Escalation**

| Situation | Contact | Response target |
| --- | --- | --- |
| Bot misbehaves, or a security concern (leak, injection success) | [to fill] | [to fill] |
| Staging impact (load, data, notifications to real people) | [to fill] | [to fill] |
| Defect escaped after a PASS | [to fill] | [to fill] |
| LLM provider outage or model change | [to fill] | [to fill] |

**Kill switch.** Who may pause: the kill-switch holder or the program owner, with no approval needed. The configuration can name the holders, and then only they can. The exact steps are in the [kill switch runbook](../runbooks/kill-switch.md). In short:

1. **Pause:** `node src/cli.ts kill-switch engage --by <name> --reason <text>`. Running runs stop at once and end INCOMPLETE, new runs refuse to start, the runner's private session files are deleted, and the revoke calls in the configuration run against the target (they end every session and disable the bot accounts). A second engage changes nothing. Every action goes in the audit log.
2. **Resume:** only after a completed review, a verified fix, and a clean run. The command needs all three: `kill-switch resume --by <name> --review <reference> --fix <reference> --preflight-report <file>`, where the first file comes from `node src/cli.ts preflight --for-resume --out <file>` run after the fix. Every check in it must have passed (none skipped), including the canary pair, and it must be newer than the pause. The command also needs `--golden-report <file>` from `node src/cli.ts golden --for-resume --out-dir <dir>`, run after the fix: every frozen verdict must still match, no input may have changed, a person must have signed the set, and the report must be newer than the pause. Access is restored first, and if that fails the runner stays paused. The configuration can switch the golden requirement off (`killSwitch.requireGoldenRun`), which is only for a runner that has no golden set yet.

Test it before the pilot: the tests prove the mechanism on the fixture, and the pilot needs the same drill against the real target, with the real revoke and restore calls that the staging owner provides. The names of the holders and their backups are still [to fill].
