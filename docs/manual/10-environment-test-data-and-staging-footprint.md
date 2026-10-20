## Environment, test data and staging footprint

Run only against environments you are authorized to test, use seeded synthetic data, and leave nothing behind.

**Readiness checklist.** All items must be ticked before the pilot.

- [ ] The build version is identifiable and recorded for every run.
- [ ] Data is seedable and resettable through an API or database, unique per test, and safe to run in parallel.
- [ ] Test accounts exist per role, with no real personal data, and a setup step can create a stored login session for each role outside the model's context.
- [ ] MFA and captcha are bypassed in staging (for example a TOTP seed for test users, or provider test keys).
- [ ] Payments, email, and SMS use sandboxes.
- [ ] Feature flags are known and pinned.
- [ ] The runner reaches staging and is not blocked by a WAF or rate limits.
- [ ] Production is unreachable from the runner (domain allowlist plus egress rules).
- [ ] The environment owner has approved the bot's use.
- [ ] The drill passed: a plain script (no LLM) logs in, creates an entity, verifies it, and cleans up, 10 times in a row and then 3 in parallel.

**Test data rules**

- Use synthetic data only.
- Give every run a unique prefix and tag on the records it creates.
- Tear down through an API at the end of each case, and also run a scheduled janitor that deletes tagged records older than [to fill: TTL]. Crashed or aborted runs are exactly where in-test cleanup gets skipped.

**Footprint controls**

| Area | Control |
| --- | --- |
| Load | Cap concurrency, pace actions, set a per-run request budget, detect repeated identical actions, and throttle or abort when staging health degrades. |
| Side effects | Use a mail catcher and test phone numbers, sandbox or disable integrations, and suppress notifications for bot accounts. |
| Collisions | Use isolated accounts or tenants. Check the build version at the start and end of each run, and mark the run INCONCLUSIVE if it changed. |
| Noise for others | Tag bot traffic with a custom request header or a user-agent suffix, tell other teams, and filter alerts by tag rather than suppressing them broadly. |

**Footprint drill.** Before the pilot, run the pilot suite at the intended parallelism and record leftover records after cleanup, peak request rate against staging capacity, error rate and latency before, during, and after, outbound messages to real destinations (should be zero), and alerts fired.

- Green: a dedicated or ephemeral environment or tenant, tagged traffic, and verified cleanup.
- Amber: shared staging with a reserved window, throttling, and a janitor.
- Red: shared with others, no isolation or cleanup, or real integrations on. Get isolation first, or restrict the bot to read-only, low-impact cases.
