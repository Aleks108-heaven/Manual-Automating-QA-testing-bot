# M4 review

Reviewed 20 Oct 2026 by Claude Code, the tool that wrote the code. **This is an AI review. It does not satisfy the build brief's rule that a person reviews the diff before a milestone is done.**

Method: after the tests passed, the new guardrails were re-read for ways to get around them, and several were tried for real through the command line: a run with a failed canary, a paused runner, a resume with a missing review, a resume with a report made for a run, and a damaged state file.

## What held up

- **A blocked request never reaches the server.** The fixture keeps its own record of every state-changing request it receives, and the tests assert that blocked requests are not in it. This covers POST, PUT, PATCH, DELETE, a form submission, a beacon, a GraphQL mutation, a websocket message, a state-changing GET, and a 307 to an undeclared path.
- **GraphQL is read, not guessed from the path.** A query passes with nothing declared, a mutation needs its operation name, declaring the path alone does not declare mutations, and `#*` is explicit. Comments and strings in the document do not fool the reader.
- **A bot that passes everything is caught before it runs.** The canary pair requires the known-good case to PASS and its negative control to FAIL.
- **The kill switch stops stuck runs.** A run inside a 20-second step and a model that never answers both end within seconds of the pause.
- **Refusals are logged.** Every refused engage and refused resume is in the audit log with who tried it and why it failed.
- **No credential in any pre-flight report,** even with a stale password, a revoked account and a missing secret at once.

## Found and fixed during this review

| # | Finding | Fix |
| --- | --- | --- |
| F1 | **Resuming was impossible.** The pre-flight check fails while the switch is engaged, and resuming needs a clean pre-flight report made after the pause | A pre-flight made for resuming (`--for-resume`) does not fail on the pause, and runs its canaries while paused. The resume command accepts only such reports |
| F2 | A damaged state file kept the runner paused (good) but could neither be resumed nor repaired, because a second engage was ignored as "already engaged" | A damaged file is reported as such, resume refuses it with the reason, and engaging again writes a good file |
| F3 | The pre-flight rules could be weakened by overrides: a configuration that requires the pinned container could still switch the canaries off | The configuration loader refuses that combination |
| F4 | The audit log said that a report was used, not which one | The resume entry records the SHA-256 of the accepted report |
| F5 | The pre-flight "secrets valid" check scrubbed the role usernames, which also mangled the secret names in its own messages | Usernames are checked for existence but not treated as secrets in the report |

## Residual risks (not fixed, and why)

| # | Risk | Why it is open |
| --- | --- | --- |
| R1 | **A chain of more than one redirect after a declared POST is noticed after the later request was sent.** The run is INCONCLUSIVE and names the request, but the request itself cannot be stopped | The browser does not show redirect hops to the request handler. Following every hop by hand would change what the page sees. A real application with chained 307 redirects on state-changing endpoints is unusual, but it needs a look when one is found |
| R2 | **The resume report is not signed.** The command checks its content and records its hash, so a hand-written report would be accepted, and only the audit log would show which file it was | The people who can resume are trusted insiders. A signature needs a key, which is a secret manager decision |
| R3 | The pre-flight session check logs in for real and does not log out, so each pre-flight leaves a server-side session on the target | A logout is a state change on the target. It should be a configured call, like revoke and restore |
| R4 | The kill switch is a local file. Several runners on several machines need a shared store, and the revoke calls are whatever the staging owner configures. The model provider's key is not revoked by the bot | Documented in the runbook. A shared store depends on the runner decision |
| R5 | The container runner still has never been built or run, so the image check has only been tested with a stand-in digest | Docker was not running. The first job when it is |
| R6 | The default configuration is for the fixture: the expected build is `fixture-1`, the revoke and restore calls are fixture endpoints, and the always-allow list is empty | Staging needs its own configuration, reviewed like code. The pre-flight runbook lists what to set |
| R7 | A websocket declaration (`WS /socket`) allows every message the page sends on that path. There are no per-message rules | Message formats are application specific |
| R8 | The list of state-changing GETs comes from the staging owner. A GET endpoint that changes state and is not on the list is not detected | A GET that changes state is an application defect in itself, but real applications have them |
| R9 | With a live model the canary pair costs real money on every run (two extra runs) | Pre-flight results could be cached for a short time per build. That weakens "every run starts with" and needs a decision |
| R10 | The CI suite now takes about 5.5 minutes | Most of it is browser start-up. One shared browser per test file would help |

## Decisions that you may want to change

- A run that is paused mid-way ends INCOMPLETE (not a new verdict).
- A skipped pre-flight check does not stop a run, but it makes the report unusable for resuming.
- `requireContainer` forces `requireCanaries`, so a production-style configuration cannot run without its canaries.
