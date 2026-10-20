## Definitions

These definitions are the single source: every other page and the bot's instruction pack link here instead of restating them, and only PASS counts as verified.

**Verdicts**

| Verdict | Meaning | Counts as verified? | Required evidence |
| --- | --- | --- | --- |
| PASS | Every expected result was observed and matched | Yes | Evidence recorded for each expected result |
| FAIL | An expected result was observed and did not match | No | Screenshot, step log, expected vs actual |
| BLOCKED | A step could not be performed because of the case or the app (element missing, step ambiguous, a loaded page that lacks what the step needs) | No | The step, the reason, a screenshot |
| INCONCLUSIVE | Evidence was missing, thin, or contradictory, or the infrastructure or tooling made it unreliable (host unreachable, staging unhealthy, build changed mid-run, a guardrail block), so no verdict is safe | No | What was missing or unreliable |
| INCOMPLETE | The run stopped early (budget, timeout, crash) | No | The last completed step |

A run that is not PASS needs a person before release when the case is P1. This is the only statement of that rule, and other pages link here.

**Who decides a verdict.** The actor observes and records, and never reports a verdict. The runner evaluates each structured expected result in code, at the step the case names in `after_step`, and captures the evidence itself (snapshot, screenshot, network log entry). Only `judged` results go to the judge, and the judge receives the evidence the runner captured, not evidence the actor chose. Each expected result gets an outcome: MATCH, MISMATCH, or NO_EVIDENCE. Code then combines the outcomes and the run state into the verdict, and the first matching row wins.

| Order | Condition | Verdict |
| --- | --- | --- |
| 1 | Infrastructure made the evidence unreliable: the build changed mid-run, the health check was failing at the end of the run, the host or provider could not be reached (no response at all), or the runner or a tool crashed | INCONCLUSIVE |
| 2 | A guardrail block fired: an undeclared mutation or an off-allowlist navigation was refused. The run stops, the block is reported and alerted, and a person triages it | INCONCLUSIVE |
| 3 | Any expected result has outcome MISMATCH | FAIL |
| 4 | The run stopped because a step could not be performed: element missing, step ambiguous, or the same action failing repeatedly | BLOCKED |
| 5 | The run stopped on a budget or a timeout | INCOMPLETE |
| 6 | Any expected result has outcome NO_EVIDENCE, or was never reached | INCONCLUSIVE |
| 7 | Every expected result has outcome MATCH | PASS |

**Rules for the table**

- An HTTP response from the application under test is application behavior, even a 500. It is evidence, and it leads to MISMATCH or BLOCKED. Row 1 applies only when there was no response at all, or when the health check was failing at the end of the run. A defect that crashes the whole environment is therefore reported as INCONCLUSIVE with everything observed attached, and a person triages it.
- A MISMATCH followed by a blocked step still gives FAIL, and the report lists the blocked step.
- A case with no expected results is invalid. The runner rejects it before the run starts, and it counts as not executed, never as PASS.
- If the judge reports that the evidence for a judged result tries to influence it, that result gets NO_EVIDENCE.
- `injection_suspected` from the actor does not change the verdict. It is reported and alerted to the security reviewer.
- A failed cleanup does not change the verdict. It is reported to the staging owner, and the janitor removes the leftovers.
- Implicit-check findings (console errors, failed requests, broken images, accessibility violations) are reported with the verdict and do not change it in version 1. Revisit this rule with pilot data.
- Row 1 comes before FAIL because unreliable evidence cannot support any verdict, and the report still lists what was observed.

**Severity, priority, and incident level**

- Defect severity is the technical impact of a defect. Defect priority is the business urgency of fixing it. People set both, separately. The bot may suggest a severity but never decides it.
- Incident level (SEV1 to SEV4) is the operational urgency of a production incident. It is a different scale from defect severity and priority, so do not mix them.
- [to fill: your severity and priority level definitions, or a link to the company matrix.]

**Terms**

| Term | Meaning |
| --- | --- |
| Oracle | How an expected result is decided: assertions, implicit checks, and an LLM judge |
| Implicit check | A check that needs no expected result: console errors, 4xx or 5xx responses, failed requests, broken images, automated accessibility violations |
| Golden set | A small pack of cases with human-fixed verdicts, run on a frozen target after every bot change and weekly, to detect drift |
| Eval set | A larger labeled corpus from real runs, used to measure whether a change improves the bot |
| Wrong PASS | The bot said PASS, but a human check shows an expected result was not met |
| False FAIL | The bot said FAIL, but a human check shows the expected result was met |
| Escape | A defect that reaches production after a PASS, or in an area no case covers |
| Flaky | The same case on the same build gives different verdicts across runs |
| Quarantine | A case removed from gating, with a named owner and a deadline |
| Drift | A change in bot behavior caused by the model, prompts, tools, browser, or app rather than by a defect |
| Decisive rate | The share of runs that end in PASS or FAIL rather than BLOCKED, INCONCLUSIVE, or INCOMPLETE |
| Outcome | The result for one expected result: MATCH, MISMATCH, or NO_EVIDENCE |
| Frozen script | A deterministic script exported from a proven case and run without an LLM. It is versioned, and only a human may change it |
