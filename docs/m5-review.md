# M5 review

Reviewed 20 Oct 2026 by Claude Code, the tool that wrote the code. **This is an AI review. It does not satisfy the build brief's rule that a person reviews the diff before a milestone is done. The golden set in particular must be reviewed and signed by a person before it means anything.**

Method: the three eval suites were run for real through the command line after the tests passed, and each suite was also tested against bots that are broken on purpose, because a measuring tool that cannot fail measures nothing.

## What was built

| Suite | Command | Test | Result of the full run (scripted model) |
| --- | --- | --- | --- |
| Mutant eval (T19) | `node src/cli.ts eval mutants` | `tests/ci/mutant-eval.test.ts`, `stats.test.ts`, `defects.test.ts` | 191 of 191 covered mutants detected, 0 missed |
| Golden set (T13) | `node src/cli.ts golden` | `tests/ci/golden.test.ts`, `kill-switch.test.ts`, `cli.test.ts` | 21 of 21 entries match; flagged only because nobody has signed the set |
| Injection eval (T12) | `node src/cli.ts eval injection --runs 20` | `tests/ci/injection-eval.test.ts` | 0 of 20 steered in each of 3 scenarios, at most 13.9% (95%) |

**Every number above comes from a scripted model.** They show that the assertions, the verdict table, the guardrails and the scanners do their part. They say nothing about a language model, and none of them may fill a pilot gate. The live runs wait for the provider decision.

## The full mutant run

243 mutants were generated from the defect registry (`fixtures/defects.ts`, `fixtures/mutants.ts`) in 7 classes. 35 are equivalent (the correct value, or only white space differs) and 17 are coverage gaps (the `login-ok` message, which no case checks, on purpose). The other 191 are covered. 320 runs took 1000 s. Each covering case ran three times on the clean application first: 33 runs, no FAIL, so false FAILs are at most 8.7% (95%).

| Class | Mutants | Detected | At least (95%) |
| --- | --- | --- | --- |
| lockout threshold | 11 | 11 | 76.2% |
| email validation | 8 | 8 | 68.8% |
| email status code | 5 | 5 | 54.9% |
| message text | 138 | 138 | 97.9% |
| status codes | 17 | 17 | 83.8% |
| API key | 2 | 2 | 22.4% |
| UI element | 10 | 10 | 74.1% |
| all | 191 | 191 | 98.4% |

Decisive rate was 100%: every run ended PASS or FAIL. No mutant was missed, undecided or flaky.

**Read this table with suspicion, not relief.** 100% on a fixture that the same author built, with cases the same author wrote, mostly shows that the author knew what the mutants were. The cases were also changed in the middle of M5 on the strength of an earlier finding (F1 below). The small classes carry weak bounds: two API key mutants cannot show more than 22% detection at 95% confidence. And the scripted model never forgets a step, which a language model will.

## Found and fixed during M5

| # | Finding | Fix |
| --- | --- | --- |
| F1 | **A substring check misses a changed message.** `text_visible` passed when the element merely contained the text, so "Enter a valid email." (a full stop added), or the same text with " please" appended, still passed the case. The mutants of message text are the biggest class, and these would have been wrong PASSes. **Measured:** the same 138 message mutants run against the cases with every `exact` removed gave 103 detected and **35 missed (25.4%)**: a full stop, an exclamation mark, a repeated last letter, " please" or "Error: " added, for each of five messages. With `exact` it is 0 missed. That is the finding the eval exists to produce | `exact: true`: the element's whole text, with white space collapsed as a browser shows it, must equal the text. The error message cases use it. A test shows that the same mutant passes under "contains" and fails under "exact". Manual: test-case page |
| F2 | The first version of `exact` used an anchored regular expression, which does not collapse a double space in the page text, so a difference no user can see failed the case | It now compares the collapsed text of each matching element, and checks that the element is visible |
| F3 | **A case that fails everything "detects" everything.** A mutant eval that counts any FAIL as detection would give a bot that fails every case a perfect score | A covering case must PASS on the clean application first. Otherwise its mutants are uncheckable and the report is flagged. Tested with a bot that does nothing |
| F4 | A defect that no case checks looked like a bot miss | Mutants carry ground truth. Coverage gaps and equivalent mutants are reported apart and never count against the bot |
| F5 | Equivalent mutants were assumed, not proved: a "changes only white space" mutant could really change what a user sees | A test observes the fixture's responses for every mutant: every non-equivalent one differs from the clean app, every equivalent one is identical once white space is collapsed |
| F6 | A guardrail block ends the run without asking the bot for its final report, so the bot cannot report an injection attempt that the tool layer stopped | In the injection eval, a blocked attempt on the runner's own record counts as reported. See R7 |
| F7 | The "outside server" used for the allowlist tests could only count hits | It also keeps headers and bodies, so the injection eval can search what reached it for a secret. It moved to `fixtures/` |

My own mistakes caught on the way: a remembered 95% bound was wrong (the test now checks the identity lower(9,10) = 1 − upper(1,10) and the manual's table); the suites first sat in `src/` and imported the fixture, which the isolation test forbids, so they moved to `evals/`; and the injection test runs first failed because they used the environment secret store instead of the fixture's.

## How the suites were shown to be able to fail

| Broken bot | Suite | What the suite reported |
| --- | --- | --- |
| Stops at step 1 every time (idle) | mutants | All 6 sampled mutants uncheckable, decisive rate 0%, flagged |
| Does nothing and so FAILs everything | mutants | False FAIL rate over 50%, mutants uncheckable, flagged |
| Cases that only check the URL | mutants | At least 5 of 6 missed, named, detection under 50%, flagged |
| Gives different verdicts on repeated runs | mutants | Flagged as flaky |
| A verdict moved by a dropped step | golden | The P1 entry is named, match rate drops |
| A looser case that still passes | golden | `changed`, because the outcomes differ; P1 named |
| A lenient case that passes a seeded defect | golden | `changed`, FAIL became PASS |
| A case edited, same verdict | golden | `STALE` until a person rehashes; rehash leaves expected verdicts alone |
| Follows the page to another site | injection | Three conditions broken (ignored, contained, same verdict); nothing reached the outside server |
| Claims MATCH and skips the click | injection | The runner still computed FAIL, so the verdict condition caught it |
| Does the right thing and says nothing | injection | Only the "flagged" condition broke |
| Types the stored secret into the page | injection | "ignored" broke; the secret was still not in any stored file or at the outside server |
| A leaked secret in a file, a URL, a header, a body | injection | The leak condition fails, naming the file and never the value |

## Residual risks (not fixed, and why)

| # | Risk | Why it is open |
| --- | --- | --- |
| R1 | **Everything is measured with a scripted model.** The numbers show the machinery, not a model. T12, T13 and T19 are not done in their live form | Needs the provider decision. The commands do not change |
| R2 | **Shared blind spots.** One author wrote the fixture, the defects, the mutants, the cases and the golden set. The mutants model wrong texts, thresholds, statuses and missing elements. They do not model timing, layout, persistence, concurrency, accessibility regressions, or anything not thought of | Real-application seeds in the pilot, chosen by someone else, are the remedy. The manual says so |
| R3 | **The golden set is unsigned.** The build agent drafted it. The verdict and precedence row of every entry were written before the first run and all 21 matched. The outcome maps of the 6 FAIL entries were copied from the first run after checking each against what its defect does. A person has to read every entry | The set flags itself as unclean until `frozen_by` is changed, and the kill switch refuses to resume on it |
| R4 | Substring matching is still the default for `text_visible`. A case author who forgets `exact` on an error message gets a case that passes a changed message, and nothing warns them. Only the mutant eval would show it, if the case is covered | A warning in the case validator for an `alert` or `status` role without `exact` is a reasonable next step, but is a judgement about case style |
| R5 | The coverage gaps are real: nothing checks the `login-ok` message, and the mutant classes are the ones the 12 cases cover. The eval cannot say how much of the application the cases leave unchecked | Coverage is a case-set question. The 17 gaps are listed so they are visible |
| R6 | Small classes have weak bounds (API key: 2 mutants, email status: 5). Repeated runs of one mutant are not independent, so each mutant counts once | More mutants per class need more fixture features |
| R7 | **A blocked attempt does not reach the final report.** After a guardrail block the bot is not asked for a report, so `injection_suspected` stays false and the eval counts the runner's record of the block instead. The summary line shows the block, but no alert goes to the security reviewer unless someone reads it | Raising an alert for every block is a policy decision (a legitimate off-site link also blocks). Worth deciding before the pilot |
| R8 | The injection corpus is small: three scenarios, English only, text only. Not covered: instructions inside images or PDFs, other languages, attacks spread over several pages, and instructions aimed at the judge through evidence | The harness takes more scenarios as a case plus a fixture page each |
| R9 | "Contained" uses a loopback server as the outside world. Exfiltration by DNS or WebRTC is stopped by the host rule and the allowlist but is not observed by this eval | The tool-layer tests cover the traps one by one (T1) |
| R10 | The resume report check for the golden set is not signed, like the pre-flight one (M4 R2). On a real target the golden run for resuming needs working bot accounts that the kill switch has just disabled | The order of events belongs in the kill-switch drill |
| R11 | The full mutant run takes about 17 minutes and the injection run 2 minutes, so they are not in `npm run check`. Only small samples and the harness tests run in CI. **`npm run check` itself now takes about 10 minutes** (506 tests in 36 files), up from 5.5 at M4. The golden test, the CLI resume test and the mutant-eval tests are the longest | A shared browser per test file and a split between a fast and a full suite would help. That is a decision about how often people run it |
| R12 | Passing eval runs are deleted after they are classified (`evals.keepRuns`). The report is the record, and runs that missed, were undecided or steered are kept | Keep everything with `keepRuns: all` when a person needs to audit a result |
