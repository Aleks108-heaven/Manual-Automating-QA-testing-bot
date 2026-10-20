# QA automation bot

A bot that executes written test cases in a browser and reports a verdict with evidence. The design is in [docs/manual/](docs/manual/00-index.md), and the build plan is in [docs/build-brief.md](docs/build-brief.md).

**Status: milestones M1 (the thin slice) and M2 (sessions, secrets, scrubbing, budgets) are built.** The bot runs cases against a local fixture site with a *scripted fake model*. No API key, no cost, and no real application is involved. The live model, the judge, network-level mutation blocking, the golden set, the final report, and frozen scripts come in later milestones.

## Run it

Needs Node 24.2 or newer.

```powershell
npm install
npx playwright install chromium      # one-time download of the pinned browser
npm run check                        # type check, pin check, and all CI tests (about a minute)
```

Run a case. The command starts the fixture site itself, runs the case in a real browser, and prints the verdict and where the evidence is:

```powershell
npm run run-case -- cases/TC-FORM-001.yaml                      # expect PASS
npm run run-case -- cases/TC-FORM-001.yaml --negative-control   # one expected result made wrong: expect FAIL
npm run run-case -- cases/TC-AUTH-003.yaml                      # expect PASS
npm run run-case -- cases/TC-AUTH-003.yaml --defects lockout-off-by-one   # the app now has a bug: expect FAIL
```

Security checks: `npm run check:supply-chain` (known vulnerabilities and registry signatures, needs network), and `npm run ci` for a clean install plus all checks. The hardening log is in [docs/security-hardening.md](docs/security-hardening.md), and the runbooks are in [docs/runbooks/](docs/runbooks/).

Exit codes: 0 for PASS, 1 for FAIL, 2 for BLOCKED, INCONCLUSIVE or INCOMPLETE, 64 for a usage error. Every run writes `runs/<run id>/run.json` and the evidence files (screenshots, page snapshots, network logs) that the runner captured. `runs/` is not committed.

Fixture defects you can turn on with `--defects`: `lockout-off-by-one`, `email-check-missing`, `wrong-email-message`.

If the negative control ever reports PASS, the bot is broken. Stop and fix it before trusting any other result.

## What is not built yet

The manual describes the finished bot, and some of it is not built. Do not rely on these until their milestone:

- `allowed_mutations` in a case is read but **not enforced** (M4).
- There is no judge, so a `judged` expected result always gives NO_EVIDENCE (M3). There are no implicit checks (console errors and so on) either.
- There is no pre-flight check and no kill switch (M4). The secret manager is an environment-variable store, and the real one is a decision still open.
- The only model is the scripted fake. No live model has been run, so the cost figures are computed from usage that the test scripts invent.
- Sessions are made through the application's login API. A UI or single-sign-on login is not built.

Reviews: [docs/m1-review.md](docs/m1-review.md), [docs/m2-review.md](docs/m2-review.md) (read its list of residual risks, for example secrets shown as page text still appear in screenshots), and [docs/security-hardening.md](docs/security-hardening.md).

## What M2 added

- **Roles and sessions.** A case with `role: member` starts the browser already signed in. The runner logs in through the login API, per case, keeps the session file outside the run folder, and deletes it afterwards.
- **`fill_secret`.** A case declares a secret as `secret:<name>` in `data`. The model names the data key, and the tool layer fills the field without ever returning the value. Try `npm run run-case -- cases/TC-AUTH-004.yaml`.
- **Scrubbing.** Everything the model is shown and everything stored is scrubbed of secrets, session tokens and credential headers. Screenshots cover password fields. The HAR is scrubbed, and there are no Playwright traces. A final scan of the stored files fails closed.
- **Budgets and loop detection.** Tool calls, time and cost have limits, and a run that hits one is INCOMPLETE. The same action failing 3 times in a row (or repeated 8 times) is BLOCKED. Limits are in `config/default.json`.
- **Run record v1** with the session, budget, redaction and scan sections. The CLI prints budget and scrub lines.

Check that nothing leaked, after any run: `Select-String -Path (Get-ChildItem runs -Recurse -File).FullName -Pattern "Correct#Pass1","Member#Pass-2026" -SimpleMatch` finds nothing.

## What the tests prove

| Test | Rule | File |
| --- | --- | --- |
| T2 | Credentials never reach the model or the artifacts | `tests/ci/credentials.test.ts`, `tests/ci/fill-secret.test.ts` |
| T3 | A budget cutoff is INCOMPLETE | `tests/ci/budget.test.ts` |
| T4 | Loops stop (BLOCKED) | `tests/ci/loop.test.ts` |
| T1 | The allowlist is enforced in the tool layer (goto, links, redirects, popups, iframes, websockets, file: data: javascript:) | `tests/ci/allowlist.test.ts` |
| T5 | No PASS without runner-captured evidence | `tests/ci/oracle.test.ts` |
| T6 | A wrong expected result fails | `tests/ci/oracle.test.ts` |
| T10 | Dependencies are pinned to exact versions | `tests/ci/pins.test.ts` |
| T17 | The thin slice runs end to end, and the negative control fails | `tests/ci/thin-slice.test.ts`, `tests/ci/cli.test.ts` |
| T22 | Cases are validated, and checks are timed with runner evidence | `tests/ci/case-validation.test.ts`, `tests/ci/oracle.test.ts` |

## Layout

```text
cases/            YAML test cases
config/           every value the manual marks [to fill]
docs/             the manual (one file per page), the build brief, the design review log
fixtures/site/    the local fixture site, with toggleable defects and trap pages
prompts/          the actor and judge prompts (the source of truth)
scripts/          the pin checker
src/              schemas, cases, tools, model, agent, oracle, verdict, runner, cli
tests/ci/         deterministic tests (scripted model, fixture site)
archive/          earlier versions of the documents
```

## Dependencies

Every version is pinned exactly (`.npmrc` sets `save-exact`, the lockfile is committed, and `npm run check:pins` fails on anything floating). Install scripts are disabled (`ignore-scripts`), and the browser is downloaded explicitly.

| Package | Why |
| --- | --- |
| `playwright` | Drives the browser; the tool layer is built on it |
| `yaml` | Reads the YAML case files |
| `zod` | Typed schemas for cases, model output, and the run record |
| `typescript` (dev) | Type checking; Node runs the `.ts` files directly |
| `vitest` (dev) | The bot's own tests |
| `@types/node` (dev) | Types for Node 24 |

## Rules for working here

Read [CLAUDE.md](CLAUDE.md). The short version: only the local fixture site is a valid target, credentials never reach the model or the artifacts, the actor never reports a verdict, and when the manual and the code disagree, stop and ask.
