## Running tests

Run scripted cases on demand, on release candidates, and on a schedule, and use exploratory mode only with a charter and a time-box.

**Triggers**

| Trigger | Scope | Notes |
| --- | --- | --- |
| On demand | Selected cases | For case authors and triagers |
| Release candidate | All P1 cases on the candidate build | Required before go or no-go once the bot is gating |
| Scheduled ([to fill: nightly or weekly]) | Smoke subset, plus the golden set weekly | Needs a named triage owner on duty |
| Pull request | Smoke subset | Only at the gating stage, once the bot is trusted |

**Configurations.** Pilot runs use one default configuration: [to fill: browser, viewport, locale, role]. Add one dimension at a time once accuracy is established, so a failure stays attributable. Every report records the build, model, prompt, tool, and browser versions.

**Run rules**

- Each case runs in a fresh browser context with its own seeded data and its role's stored session.
- The pre-flight check runs before every run (`node src/cli.ts preflight` runs it on its own and writes a report). It also checks that the kill switch is not engaged. Its checks, in order: the runner is not paused; the provider is reachable; quota is left; every secret the cases and roles use resolves; each needed role really logs in; the runner is the pinned container image (when required); the target answers its health check; the target is the expected build; and the canary pair behaves, where a known-good case must PASS and its negative control must FAIL. If an earlier check fails, the canaries are skipped, because they would not be trustworthy. A skipped check does not stop a run, but it is reported as skipped, never as passed, and a report with a skipped check cannot be used to resume the kill switch. The rest of this bullet is the original description:
- The pre-flight check must pass first: the provider is reachable, quota is left, secrets are valid, each role's stored session is fresh, the runner image matches the pinned one, staging is healthy, the build is the expected one, and the canary cases pass. Otherwise the run does not start.
- Every run has budgets for tool calls (per step and per run), wall-clock time, and cost: [to fill: limits, set in configuration]. A run cut off by a budget is INCOMPLETE, never PASS. The time budget also covers a model that never answers. Cost comes from the token usage the model client reports and the prices in configuration. When a model call uses up the budget, the action it chose is not carried out. Each report records the limits, what was used, and which limit ended the run.
- The model's final report and the judge's answers are validated, and a wrong one is sent back with a description of what was wrong, up to a configured number of attempts (3 by default). Retries spend the same time and cost budget as everything else. Nothing is repaired. A report that stays invalid makes the run INCONCLUSIVE, and a judge answer that stays invalid makes its results NO_EVIDENCE.
- A run that is stopped because a step could not be performed (an element is missing, a locator is ambiguous, or the loop detector fired) records the step, the reason, the last tool error and a screenshot that the runner captured at that moment.
- After each step the runner collects the implicit findings (see the test-case page). They are reported and never change the verdict.
- A run that repeats itself is stopped by the runner, not left to the model. The same action (the same tool with the same arguments) failing 3 times in a row, or the same action repeated 8 times in a row even if it succeeds, ends the run with the stop reason `loop`, which gives BLOCKED. Both limits are configuration. The model is not asked for a final report after such a stop.
- During the pilot each case runs three times, to measure repeatability.
- Do not run performance tests on staging while bot runs share it.

**Exploratory mode.** The bot explores only against a charter, inside a time-box, in read-only mode unless the charter says otherwise. It reports suspected defects with evidence and reproduction steps, and a human sets severity and priority.

| Charter field | What to write |
| --- | --- |
| Mission | Explore [area] with [data or role] to discover [information] |
| Time-box | [to fill: minutes] and a step budget |
| Heuristics | Boundary values, special characters and unicode, empty and very long input, double submit, back, forward and refresh mid-flow, session expiry, viewport change |
| Allowed actions | Read-only, or the data-creating actions listed here; never delete, send, pay, upload, or download unless named |
| Output | Suspected defects, each with evidence and steps to reproduce |
