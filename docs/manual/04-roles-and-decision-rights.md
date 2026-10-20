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
- Pausing the bot: the kill-switch holder or the program owner, with no approval needed. Resuming needs a completed review, a verified fix, and a clean golden-set run.
- Release go or no-go: [to fill: the existing release decision-maker]. A bot PASS is evidence for that decision, never the decision.

**Escalation**

| Situation | Contact | Response target |
| --- | --- | --- |
| Bot misbehaves, or a security concern (leak, injection success) | [to fill] | [to fill] |
| Staging impact (load, data, notifications to real people) | [to fill] | [to fill] |
| Defect escaped after a PASS | [to fill] | [to fill] |
| LLM provider outage or model change | [to fill] | [to fill] |

**Kill switch.** [to fill: exact steps to pause the runner and revoke its credentials, and who may do it.] Test it before the pilot.
