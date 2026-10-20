# M3 review

Reviewed 20 Oct 2026 by Claude Code, the tool that wrote the code. **This is an AI review. It does not satisfy the build brief's rule that a person reviews the diff before a milestone is done.**

Method: after the tests passed, the new paths were re-read for ways a wrong answer could become a PASS, or a hostile page could steer a verdict, and several were checked against real runs through the CLI (`TC-JUDGE-001` with and without a judge, `TC-IMPL-001`, and a blocked run).

## What held up

- **A judged result cannot become a PASS by assertion.** MATCH and MISMATCH need cited evidence that the runner actually supplied. An answer with a missing, duplicate, unknown or invented item is retried and then NO_EVIDENCE. Tests cover each case.
- **The judge's input has no place for the actor's words.** A test puts a marker string in the actor's observations, evidence claim and notes and searches every judge input for it, and also checks that the input's keys are exactly the documented ones.
- **Hostile page text cannot decide a verdict.** The structured checks are code. A test lets the judge be "talked into" MATCH while a structured check fails, and the run is FAIL. The hostile text did reach the judge as evidence, which is the point of the test.
- **The manual and the code agree on the verdict table.** A test reads the table in the Definitions page.
- **Nothing the model or judge returns is repaired.** Missing fields stay missing and the run says so.
- **Implicit checks never reach the verdict.** They are not outcomes, and a PASS stays a PASS and a FAIL stays a FAIL.

## Residual risks (not fixed, and why)

| # | Risk | Why it is open |
| --- | --- | --- |
| R1 | **The judge has never been tried on a real model.** The prompt in `prompts/judge.v1.md`, the evidence format and the rules around it are tested only against a scripted fake. A real judge may cite evidence badly, be fooled in ways the fake cannot show, or be too slow | It needs the provider decision. The live judge and the "Eval" tests (T6, T7, T23 live halves, and T12) come with it |
| R2 | **Screenshots go to the judge as image paths.** A live client will send the images to the provider. Secrets shown as page text are in those pixels (M2 risk R1) | The data handling review must clear what may leave the machine. Until it does, use judges only on synthetic data |
| R3 | The judge receives the whole page snapshot as text. A real page can be large, so cost and time will be higher than the fixture shows, and there is no size limit yet | Add a limit once real sizes are known |
| R4 | `axe-core` runs inside the page it checks. It is a widely used library with no dependencies and no install scripts, pinned and signature-checked, but it is third-party code executing in the application's page | Acceptable for a bot that drives a test environment. It is listed in the README, and it needs a line in the licence register (MPL-2.0) before a second team uses the bot |
| R5 | Accessibility is checked once per distinct page URL per run. States that change a page (an opened dialog, an error message) are not rechecked | Revisit with pilot data. Automated rules find only part of the real issues in any case |
| R6 | The browser's own console message for an image that answered 404 appears next to the HTTP finding for the same image | Both are true. De-duplicating them would hide a real console error |
| R7 | A report that stays invalid makes the run INCONCLUSIVE even when every expected result matched. A model with a habit of bad reports would lower the decisive rate a lot | Deliberate. The decisive rate is a pilot gate, so the cost will be visible |
| R8 | The run record moved to version 2. The brief said M2 would produce the final schema | M3 needed new sections. Later milestones should expect more |
| R9 | The CI suite now takes about 4 minutes | Most of it is browser start-up. Sharing one browser across tests is the likely fix |
| R10 | The expected-status exemption for implicit HTTP findings matches the exact method, path and status written in the case | A case that expects a range of statuses gets findings for the others. That is the safe direction |

## Decisions that you may want to change

- A report that stays invalid is INCONCLUSIVE (not a warning).
- An injection report from the judge makes only that result NO_EVIDENCE. The run is flagged for the security reviewer, but the verdict is not forced.
- The default of 3 attempts for the model's report and for the judge.
