# M1 review

Reviewed 20 Oct 2026 by Claude Code (the same tool that wrote the code). **This is an AI review. It does not satisfy the build brief's rule that a person reviews the diff before a milestone is done.** It found real defects, listed below, which is the best argument for the human review.

Method: re-read the tool layer, runner, oracle, agent loop, fixture, and CLI against the manual (Definitions, test-case page, Guardrails page), then wrote a failing test or a reproduction for each suspected defect before fixing it.

## Fixed during this review

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| R1 | A misspelled `--defects` name was silently ignored, so the bot ran on a correct application and could report PASS for a case that was meant to find a bug | The fixture and the CLI reject unknown defect names | `fixture.test.ts`, `cli.test.ts` |
| R2 | If the target did not answer at all and had no health endpoint, the run ended FAIL instead of INCONCLUSIVE, against precedence row 1 | The tool layer records connection-level failures to allowed hosts, and the runner treats them as an infrastructure failure | `thin-slice.test.ts` |
| R3 | `press`, `wait_for`, `snapshot`, `screenshot`, `console_errors`, `network_errors` and the `element_missing` and `ambiguous` error codes had no tests | New tool tests, including a check that a screenshot label cannot escape the shots directory | `tools.test.ts` |
| R4 | A script written for another case would run the wrong steps and could give a misleading verdict | The scripted model refuses a script whose case ID differs, and the run is INCONCLUSIVE | `thin-slice.test.ts` |
| R5 | A failed teardown was handled but never tested | Test: reported in the record, verdict unchanged | `thin-slice.test.ts` |
| R6 | (from the hardening pass) the browser sandbox was off, any Host header was accepted, and any loopback service was a valid `--target` | See [security-hardening.md](security-hardening.md) | `browser-sandbox.test.ts`, `fixture.test.ts`, `cli.test.ts` |

## Open, and why

| # | Finding | Why it is open |
| --- | --- | --- |
| O1 | `allowed_mutations` is read from the case but **not enforced yet**. The manual describes the target behavior (undeclared state-changing requests are blocked) | It is milestone M4 (T16). Until then, a case's declaration has no effect, so do not rely on it |
| O2 | `role` and `data` are read but unused | Sessions and secret references are milestone M2 |
| O3 | Only hard caps on tool calls exist. There is no time or cost budget and no loop detection | Milestone M2 (T3, T4) |
| O4 | `settle()` counts requests in flight. A long-polling page makes it wait the full 2 seconds after every step | Slower, never wrong. Revisit with a real application |
| O5 | If an unrelated request is blocked while a tool call is running, a genuine tool error (for example `element_missing`) is reported as `blocked_by_guardrail` | The run stops on any block anyway, so the verdict is the same. The log still shows both events |
| O6 | A popup that opens late can become the current page after the next tool call has started | Low risk on the fixture. Needs a real popup test in M4 |
| O7 | The scripted model tests the wiring, not a real model's judgment | By design. The live-model run waits for the provider decision |
| O8 | A failing expected result waits out the full timeout, so failing cases are slow | Inherent to "eventually true" checks. The timeout is configuration |
| O9 | The CI suite takes about 80 seconds, mostly browser start-up | Acceptable now. Share one browser across tests if it grows |

## What was checked and held up

- Verdict calculator against all seven rows of the precedence table, including the combinations in the manual.
- Evidence is captured by the runner, and evidence an actor claims is ignored.
- Redirect hops, popups, iframes, websockets, subresources, and `file:`, `data:`, `javascript:` URLs are refused and logged on two different outside hosts.
- Case validation: no expected results, duplicate ids, bad `after_step`, unknown fields and kinds are all rejected before a run.
- The run record validates against its schema and carries versions, prompt hashes, build and sandbox state.
