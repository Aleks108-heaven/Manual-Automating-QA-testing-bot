# M2 review

Reviewed 20 Oct 2026 by Claude Code, the tool that wrote the code. **This is an AI review. It does not satisfy the build brief's rule that a person reviews the diff before a milestone is done.**

Method: after the tests passed, the secret-handling paths were re-read looking for ways a credential could still get out, and each suspicion was checked against a real run (`npm run run-case -- cases/TC-AUTH-004.yaml` and `cases/TC-ACCT-001.yaml`, then a search of `runs/` for the fixture's passwords, API key and session token prefix, which found nothing).

## What held up

- **T2, T3, T4 pass,** with a scan that uses its own list of secrets (including the live server-side session tokens), not the run's.
- **The tests are not vacuous:** the leak-trap test requires that the model's view contains `[REDACTED:member.cookie.fx_session]`, which proves the cookie really reached the page and was removed; the HAR must show a `Cookie` header with a redacted value; a planted leak must make the run INCONCLUSIVE and be cleaned; the browser really contains the API key after `fill_secret` (so hiding it from the snapshot is the scrubber's doing).
- **`fill_secret` cannot be used to ask for a secret by name.** It takes a data key of the case, and only entries that are secret references.
- **Private files do not outlive a run:** the session file and the raw HAR are removed, and a test checks the private folder is empty afterwards.

## Residual risks (not fixed, and why)

| # | Risk | Why it is open |
| --- | --- | --- |
| R1 | **A secret shown as plain page text appears in screenshots.** Screenshots cover password inputs and fields filled with `fill_secret`, but pixels of text elsewhere on the page are not scrubbed. The `/debug/session` trap page shows the cookie on screen, and a screenshot of it contains it | Scrubbing pixels needs OCR or per-case masks. A case that visits a page which displays secrets should not take screenshots of it. A per-case `mask` list is the likely fix, and it is not built. Treat PNG evidence from such pages as sensitive |
| R2 | **The scrubber knows only what it has been told.** It removes the declared secrets, the role's password and its session cookies. A value the application invents and shows (a one-time code, a reset link) is not known | A pattern-based detector for tokens is possible but would also produce false positives. Not built |
| R3 | Sessions are made through the login API. An application with single sign-on, a CAPTCHA, or a multi-step login cannot use a role yet | A UI login is a later extension |
| R4 | The session file sits in the operating system's temporary folder. On Windows it inherits that folder's permissions, which are private to the user by default. File modes `0600` and `0700` are applied where the system supports them | Acceptable on a single-user machine. A shared runner needs a dedicated directory |
| R5 | The cost of the model's final report is not counted, only the cost of each action | The scripted model has no final-report cost. Add it when a live model client exists |
| R6 | A tool call that is cut off by the time budget keeps running in the browser until the browser is closed | Harmless for the verdict, since the run is already INCOMPLETE |
| R7 | The CI suite now takes about 170 seconds | Most of it is browser start-up. Sharing a browser between tests would help if it grows |
| R8 | The same-action repeat limit of 8 applies across steps, so a case that legitimately clicks "Next" 8 times in a row is stopped | The limit is configuration. Revisit with a real application |

## Decisions that you may want to change

- Every case logs in again (slower, but a logout cannot affect another case).
- Playwright traces are off for good, until there is a trace scrubber.
- A credential found by the final scan makes the run INCONCLUSIVE rather than just a warning.
