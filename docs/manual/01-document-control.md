## Document control

This manual governs the QA automation bot from the pilot onward, and version 0.9 covers the pages needed before the pilot starts.

| Field | Value |
| --- | --- |
| Manual version | 0.9 (draft) |
| Status | Draft, revised after two AI design reviews. These are not the human independent review that stage changes and the pilot-readiness review require |
| Applies to bot version | [to fill: release or commit] |
| Manual owner | [to fill: name or role] |
| Backup owner | [to fill] |
| Last reviewed | [to fill: date] |
| Next review | [to fill: date; suggest the pilot-readiness review] |
| Source of truth | [to fill: repository path or wiki page] |

Three rules keep the manual trustworthy. A bot change is not finished until this manual is updated, whether it touches prompts, tools, the judge rubric, the model, the browser, or thresholds. Definitions live only on the Definitions page, and every other page links to it. Every page keeps an owner and a last-reviewed date.

**Change log**

| Date | Version | Change | Author |
| --- | --- | --- | --- |
| 19 Oct 2026 | 0.1 | First draft of the pre-pilot pages | [to fill] |
| 20 Oct 2026 | 0.2 | Revised after an AI design review: the actor no longer grades itself, verdict precedence, structured expected results, stored sessions and secret references, network-layer blocking of undeclared mutations, the hybrid path, decisive rate, and a cost estimate | [to fill] |
| 20 Oct 2026 | 0.3 | Second AI review applied. Expected results get `id` and `after_step`, and the runner captures the evidence. The precedence table now separates infrastructure failures from application responses and covers guardrail blocks, empty cases, injection flags, and failed cleanup. The hybrid path can no longer turn a FAIL into a PASS. Session files and session tokens are treated as credentials. State-changing GETs, GraphQL, and websockets are covered by mutation blocking. Mutant results are reported separately from real defects. The prompts moved to prompts/, the manual was split into pages, and duplicate statements of the same rule were removed | [to fill] |
| 20 Oct 2026 | 0.4 | Milestone M1 built. Cases gain executable `setup` and `teardown` API calls next to the human-readable `Preconditions` and `Cleanup`. The test-case page describes how the runner times its checks and how elements are addressed. The guardrails page records that the browser host rule is required, because redirect hops bypass the request handler | [to fill] |
| 20 Oct 2026 | 0.5 | Security hardening. Correction: Playwright turns the Chromium sandbox off unless asked, so the bot now turns it on and records it in every run record. The Guardrails page adds the browser sandbox, lockfile verification, the update routine, the frozen-script rule, LLM key limits, and the no-real-malware rule. A container runner template and two runbooks were added | [to fill] |
| 20 Oct 2026 | 0.6 | Milestone M2 built. Roles and per-case sessions made by the runner, `fill_secret` by data key, scrubbing of everything the model sees and everything stored, masked screenshots, a scrubbed HAR and no traces, a final scan of stored files that fails closed, budgets for tool calls, time and cost, and runner-side loop detection. The run record is schema version 1 | [to fill] |
| 20 Oct 2026 | 0.7 | Milestone M3 built. The judge, as a separate client that sees only runner-captured evidence, with its answer checked in code and an injection report giving NO_EVIDENCE. Implicit checks (console, HTTP, failed requests, images, accessibility), reported only. The model's final report is validated and retried within budget and never repaired. A BLOCKED run records the step, reason and a runner-captured screenshot. The precedence table is kept as data and compared with this manual by a test. The run record is schema version 2 | [to fill] |
| 20 Oct 2026 | 0.8 | Milestone M4 built. Undeclared state changes are blocked (non-GET requests, GraphQL mutations by operation name, websocket sends, state-changing GETs, and the first redirect hop), with a visible declaration syntax. The pre-flight check runs before every run, with a canary pair. The kill switch is built and its steps are written down, including what resuming needs. The kill switch is a new stop reason in precedence row 5. The Roles page kill-switch paragraph is filled in. The run record is schema version 3 | [to fill] |
| 20 Oct 2026 | 0.9 | Milestone M5 built. The mutant eval, the golden set and the injection eval, as commands with reports and exact 95% bounds. `text_visible` gains `exact: true` after the mutant eval showed that a substring check misses a changed message. Definitions gain mutant, equivalent mutant and coverage gap. Resuming the kill switch also needs a clean golden-set report. A runbook for the golden set was added. The Pilot page says what scripted runs of these suites do and do not show | [to fill] |

This log is append-only. Do not edit earlier entries.
