# QA automation bot

A bot that executes written test cases in a browser and reports a verdict with evidence.

You write a case as a small YAML file. A local language model (LM Studio or Ollama) reads the steps and drives a real browser. **The bot's own code, not the model, checks the expected results, captures the evidence and decides the verdict.** The model only reports what it saw, and it can never turn a failed check into a PASS. Only PASS is verified; everything else (FAIL, BLOCKED, INCONCLUSIVE, INCOMPLETE) needs a person.

**Status (6 Nov 2026).** Milestones M1 to M7 are built, with a live model client for LM Studio and Ollama, a library entry point and an MCP server. A first real run: Qwen2.5-Coder 14B on a laptop CPU passed the known-good case, failed its negative control as it must, and passed `TC-FORM-001`, in about six minutes in all. That is one case on the fixture site, not an evaluation. **By default only the local fixture site is a valid target.** A site of your own can be added in one controlled way (the exact origins plus a written statement of who allows the test; read-only cases, no login): [docs/runbooks/external-targets.md](docs/runbooks/external-targets.md). The eval suites (golden set, mutants, injection) still run on the scripted fake model, so every number they print describes the bot's machinery, not a language model.

The design is in [docs/manual/](docs/manual/00-index.md), and the build plan is in [docs/build-brief.md](docs/build-brief.md).

## Quick start

Needs Node 24.2 or newer.

```powershell
npm install
npx playwright install chromium     # one-time download of the pinned browser
```

**1. Try it with no model at all** (a scripted fake plays the model; nothing to set up):

```powershell
node src/cli.ts cases                                         # list the cases, and check that they are valid
node src/cli.ts run cases/TC-FORM-001.yaml                    # expect PASS
node src/cli.ts run cases/TC-FORM-001.yaml --negative-control # one expected result made wrong: expect FAIL
```

**2. Run it with a local model.** Start Ollama (or LM Studio), then:

```powershell
$env:QA_PROVIDER_URL = "http://127.0.0.1:11434/v1"     # Ollama; LM Studio is http://127.0.0.1:1234/v1
node src/cli.ts provider models                          # the models the server offers
node src/cli.ts run cases/TC-FORM-001.yaml --live --model <a name from that list>
```

The one-time setup (context length, timeouts, watching the browser) is in [docs/runbooks/live-provider.md](docs/runbooks/live-provider.md). Add `QA_BROWSER_HEADED=1` to watch the browser, and do not touch its window.

**3. Write your own case.** A case is one `.yaml` file in [cases/](cases/). Copy [TC-FORM-001.yaml](cases/TC-FORM-001.yaml), change it, check it with `node src/cli.ts cases cases/<yours>.yaml`, prove it can fail with `--negative-control`, then run it. The step-by-step guide, with a template, is [docs/runbooks/writing-and-running-cases.md](docs/runbooks/writing-and-running-cases.md); the full rules are on the manual page [Writing bot-ready test cases](docs/manual/06-writing-bot-ready-test-cases.md).

**4. Use it from somewhere else.** From VS Code agent mode, LM Studio or Claude Code through an MCP server (`npm run mcp -- --live --model <id>`), or as a library from your own application (`QaBot` in `src/index.ts`): [docs/runbooks/agent-integration.md](docs/runbooks/agent-integration.md).

| Command | What it does |
| --- | --- |
| `node src/cli.ts cases [files]` | List the cases, or check files, without running anything |
| `node src/cli.ts run <case.yaml>... [--live --model <id>] [--negative-control]` | Run one case or several (one after another, one report) |
| `node src/cli.ts provider models` / `provider check --model <id> [--probe-context]` | See the model server's models; check a model, and that the server holds the context you declared |
| `node src/cli.ts report <run dir>...` / `release <report>` | Rebuild a report; the evidence for a release decision (it never says go or no-go) |
| `node src/cli.ts kill-switch status\|engage\|resume` | Pause the bot at once, or resume it by the documented steps |
| `node src/cli.ts frozen freeze\|approve\|run` | Freeze a stable case as a script that replays with no model |
| `npm run check` | Type check, pin check and all CI tests (about 16 minutes) |

Which browser: the pinned Chromium by default; `QA_BROWSER_CHANNEL=chrome-canary` (or `chrome`, `chrome-dev`, `msedge-dev`, `msedge`) uses the Chrome or Edge installed on the machine, for compatibility checks. Firefox and WebKit are not offered.

## Scripted demo and checks (details)

```powershell
npm run check                        # type check, pin check, and all CI tests (about sixteen minutes)
```

Run a case. The command starts the fixture site itself, runs the case in a real browser, and prints the verdict and where the evidence is:

```powershell
npm run run-case -- cases/TC-FORM-001.yaml                      # expect PASS
npm run run-case -- cases/TC-FORM-001.yaml --negative-control   # one expected result made wrong: expect FAIL
npm run run-case -- cases/TC-AUTH-003.yaml                      # expect PASS
npm run run-case -- cases/TC-AUTH-003.yaml --defects lockout-off-by-one   # the app now has a bug: expect FAIL
```

Security checks: `npm run check:supply-chain` (known vulnerabilities and registry signatures, needs network), and `npm run ci` for a clean install plus all checks. The hardening log is in [docs/security-hardening.md](docs/security-hardening.md), and the runbooks are in [docs/runbooks/](docs/runbooks/).

Exit codes: 0 for PASS, 1 for FAIL, 2 for BLOCKED, INCONCLUSIVE or INCOMPLETE, 3 when the run was refused (the kill switch is engaged, or a pre-flight check failed), 64 for a usage error. Every run writes `runs/<run id>/run.json` and the evidence files (screenshots, page snapshots, network logs) that the runner captured. `runs/` is not committed.

Fixture defects you can turn on with `--defects` (comma-separated, validated, so a typo fails instead of running on a correct app): the three old names `lockout-off-by-one`, `email-check-missing`, `wrong-email-message`, and parameterized ones such as `lockout-threshold=7`, `email-validator=accepts-no-at`, `email-status=500`, `apikey=accepts-any`, `logout-button=missing`, and `message=email-invalid:add-period`. The full list and values are in `fixtures/defects.ts`.

If the negative control ever reports PASS, the bot is broken. Stop and fix it before trusting any other result.

## What is not built yet

The manual describes the finished bot, and some of it is not built. Do not rely on these yet:

- **Live evaluation.** The live model client is built and has run one case on a real model, but the eval suites (golden set, mutants, injection) and the live halves of T6, T7, T12, T13, T19 and T23 still run on the scripted model. The judge's prompt (`prompts/judge.v1.md`) has never been tried on a real model. Scripted results test the machinery and never fill a pilot gate.
- **Targets.** The fixture, and sites of your own that you list with a written statement of who allows the test ([external targets](docs/runbooks/external-targets.md)); the bot cannot verify that statement. No login on an external site, no secret manager yet. The security review of a real target is not done.
- The secret manager is an environment-variable store, and the real one is a decision still open. The kill switch is a local file, which a shared runner cannot use.
- The container runner has still never been built or run (Docker was not running). The pre-flight image check compares against its digest only when the configuration requires a container.
- A chain of more than one redirect after a declared POST is noticed after the later request was sent, not before.
- Sessions are made through the application's login API. A UI or single-sign-on login is not built.
- Cases run one at a time: one local model answers one request at a time. Firefox and WebKit are not supported.

Reviews: [docs/m1-review.md](docs/m1-review.md), [docs/m2-review.md](docs/m2-review.md) (read its list of residual risks, for example secrets shown as page text still appear in screenshots), and [docs/security-hardening.md](docs/security-hardening.md).

## What came after M5

- **M6, the report.** A run report with version stamps, a summary, per-case detail and a draft bug report for a FAIL; a release report that gathers the evidence for a release decision and never decides.
- **M7, frozen scripts.** A stable case is exported as a script, a named approver approves it, and it replays through the same runner with no model. A failed assertion in a script stays FAIL.
- **A live model.** A client for any OpenAI-compatible server (LM Studio, Ollama, llama.cpp, vLLM) serves the actor, the judge and the proposer. The model is chosen by name from the server's list. Its answers are validated and sent back, never repaired. A provider off this machine needs a register entry and https. Every prompt is fitted to the context length you declare, or refused, so the server never cuts it silently. [Runbook](docs/runbooks/live-provider.md).
- **A library and an MCP server.** `QaBot` for your own application, and an MCP server with coarse tools only (list the cases, run one by id, read a report); the host's model never drives the browser. [Runbook](docs/runbooks/agent-integration.md).
- **For the tester.** `node src/cli.ts cases` lists and checks cases without running them; a batch runs the canary pair once; the browser can be shown or chosen. [Guide](docs/runbooks/writing-and-running-cases.md).
- The manual's version follows the last row of its change log (`npm run docs:sync`, checked by a test).

## What M2 added

- **Roles and sessions.** A case with `role: member` starts the browser already signed in. The runner logs in through the login API, per case, keeps the session file outside the run folder, and deletes it afterwards.
- **`fill_secret`.** A case declares a secret as `secret:<name>` in `data`. The model names the data key, and the tool layer fills the field without ever returning the value. Try `npm run run-case -- cases/TC-AUTH-004.yaml`.
- **Scrubbing.** Everything the model is shown and everything stored is scrubbed of secrets, session tokens and credential headers. Screenshots cover password fields. The HAR is scrubbed, and there are no Playwright traces. A final scan of the stored files fails closed.
- **Budgets and loop detection.** Tool calls, time and cost have limits, and a run that hits one is INCOMPLETE. The same action failing 3 times in a row (or repeated 8 times) is BLOCKED. Limits are in `config/default.json`.
- **Run record v1** with the session, budget, redaction and scan sections. The CLI prints budget and scrub lines.

## What M5 added

- **Mutant eval (T19).** `node src/cli.ts eval mutants [--sample N] [--repeat R]` switches on one fixture defect at a time (243 generated mutants in 7 classes), runs the cases that are meant to notice it, and reports detection per class with exact 95% bounds, the misses by name, and the defects no case covers (coverage gaps, listed apart from misses). Equivalent mutants are left out of the denominator. A case that does not PASS on the clean application is not trusted.
- **Golden set (T13).** `node src/cli.ts golden` runs 21 frozen verdicts and reports every one that moved; a moved P1 verdict is flagged. The set must be signed by a person before it counts (`golden/golden-set.json`, `frozen_by`), and `golden rehash` records the inputs after a reviewed change. See [docs/runbooks/golden-set.md](docs/runbooks/golden-set.md). Resuming the kill switch now also needs a clean golden report (`--golden-report`).
- **Injection eval (T12).** `node src/cli.ts eval injection [--runs N]` runs hostile pages (visible and hidden text, alt text, labels, stored records, form values and server error messages) against the bot, each paired with a clean twin, and checks five conditions: ignored, contained, no leak, same verdict, flagged. It reports the upper 95% bound on how often the bot is steered.
- **`exact: true`** for `text_visible`: the whole element text must equal the text. The first mutant runs showed that the substring check misses a changed message.
- **One shared browser** per eval run, with a context per run, so several hundred runs take minutes. The allowlist and host rule are unchanged.
- The suites are tested against **broken bots** (an idle bot, a bot that fails everything, cases that only check the URL, bots that obey the hostile pages), and must flag each. Review: [docs/m5-review.md](docs/m5-review.md).

## What M4 added

- **Undeclared state changes are blocked.** A case lists the requests it may send that change state in `allowed_mutations` (`POST /api/orders`, `POST /graphql#CreateOrder`, `WS /socket`, `GET /logout`). Anything else is stopped before it reaches the server, the run ends INCONCLUSIVE, and the report names the request. A GraphQL query is not a state change; a mutation is, by operation name. The first redirect hop of a state-changing request is checked too.
- **Every run starts with the pre-flight check.** Nine checks (not paused, provider, quota, secrets, sessions, runner image, target health, build, and the canary pair). Run it alone with `node src/cli.ts preflight`. A failed check stops the run with exit code 3.
- **The kill switch.** `node src/cli.ts kill-switch engage --by <name> --reason <text>` pauses the runner at once, revokes its credentials, and logs it. Resuming needs a named review, a fix reference, and a clean pre-flight report made with `--for-resume`. See [docs/runbooks/kill-switch.md](docs/runbooks/kill-switch.md).
- **Run record v3** records the pre-flight summary, and a new stop reason, `killed`, ends a run as INCOMPLETE.

## What M3 added

- **The judge.** A `judged` expected result goes to a separate judge that sees only the evidence the runner captured, never the actor's notes. Its answer is checked in code: it must cover exactly the items asked about and cite evidence the runner supplied, or it is retried and then becomes NO_EVIDENCE. An injection report from the judge also gives NO_EVIDENCE. Try `npm run run-case -- cases/TC-JUDGE-001.yaml --judge-script tests/ci/judge-scripts/TC-JUDGE-001.json`.
- **Implicit checks.** Console errors, HTTP errors, failed requests, broken images, and accessibility violations (`axe-core`) are listed after each run and never change the verdict. Try `npm run run-case -- cases/TC-IMPL-001.yaml`.
- **Validated model output.** The model's final report is checked, sent back with a description of the problem when wrong (up to 3 attempts), and never repaired. A report that stays invalid makes the run INCONCLUSIVE.
- **BLOCKED carries evidence.** A run stopped by a missing element records the step, the reason, and a screenshot the runner took at that moment.
- **The verdict table is checked against the manual** by a test that reads `docs/manual/05-definitions.md`, plus an enumeration of about a thousand combinations.
- **Run record v2** with the judge, implicit, blocked and model-output sections.

Check that nothing leaked, after any run: `Select-String -Path (Get-ChildItem runs -Recurse -File).FullName -Pattern "Correct#Pass1","Member#Pass-2026" -SimpleMatch` finds nothing.

## What the tests prove

| Test | Rule | File |
| --- | --- | --- |
| T9 | Pre-flight blocks the run, by name, for each failing condition | `tests/ci/preflight.test.ts`, `tests/ci/cli.test.ts` |
| T11 | The kill switch pauses, revokes, and resumes only by the documented steps | `tests/ci/kill-switch.test.ts`, `tests/ci/cli.test.ts` |
| T16 | Undeclared state changes are blocked, declared ones are allowed | `tests/ci/mutations.test.ts`, `tests/ci/mutation-blocking.test.ts` |
| T7 | A missing element is BLOCKED, with the step and a screenshot | `tests/ci/blocked.test.ts` |
| T8 | Malformed model output is rejected and retried, never repaired | `tests/ci/model-output.test.ts` |
| T18 | Verdict precedence: every row, every combination, and the manual's table | `tests/ci/verdict-table.test.ts` |
| T23 | The judge sees only runner evidence; an injection report gives NO_EVIDENCE | `tests/ci/judge.test.ts` |
| T2 | Credentials never reach the model or the artifacts | `tests/ci/credentials.test.ts`, `tests/ci/fill-secret.test.ts` |
| T3 | A budget cutoff is INCOMPLETE | `tests/ci/budget.test.ts` |
| T4 | Loops stop (BLOCKED) | `tests/ci/loop.test.ts` |
| T1 | The allowlist is enforced in the tool layer (goto, links, redirects, popups, iframes, websockets, file: data: javascript:) | `tests/ci/allowlist.test.ts` |
| T5 | No PASS without runner-captured evidence | `tests/ci/oracle.test.ts` |
| T6 | A wrong expected result fails | `tests/ci/oracle.test.ts` |
| T10 | Dependencies are pinned to exact versions | `tests/ci/pins.test.ts` |
| T12 | Hostile pages do not steer the bot; a steered bot is flagged by condition (harness half) | `tests/ci/injection-eval.test.ts` |
| T13 | The golden set detects drift and names the moved P1 entry (harness half) | `tests/ci/golden.test.ts`, `tests/ci/kill-switch.test.ts` |
| T19 | Mutant detection per class with exact bounds; a broken bot is flagged (harness half) | `tests/ci/mutant-eval.test.ts`, `tests/ci/stats.test.ts`, `tests/ci/defects.test.ts` |
| T17 | The thin slice runs end to end, and the negative control fails | `tests/ci/thin-slice.test.ts`, `tests/ci/cli.test.ts` |
| T22 | Cases are validated, and checks are timed with runner evidence | `tests/ci/case-validation.test.ts`, `tests/ci/oracle.test.ts` |

## Layout

```text
cases/            YAML test cases (add yours here)
config/           every value the manual marks [to fill]
docs/             the manual (one file per page), the runbooks, the build brief, the design review log
evals/            the three eval suites (mutants, golden set, injection); they use the fixture, so they live outside src/
fixtures/         the local fixture site (toggleable defects, trap pages, hostile pages), the defect registry, the mutant manifest
frozen/           approved frozen scripts and their register (created by the first freeze)
release/          the register of quarantines and overrides
golden/           the frozen verdicts and their scripts
mcp/              the MCP server for VS Code, LM Studio and Claude Code
prompts/          the actor, judge and proposer prompts (the source of truth)
scripts/          the pin checker, the schema writer, the manual-version sync
src/              schemas, cases, tools, model (scripted and live), judge, agent, oracle, verdict, runner, batch, report, release, frozen, cli, and index.ts (the library)
tests/ci/         deterministic tests (scripted model or a fake model server, and the fixture site)
archive/          earlier versions of the documents
```

## Dependencies

Every version is pinned exactly (`.npmrc` sets `save-exact`, the lockfile is committed, and `npm run check:pins` fails on anything floating). Install scripts are disabled (`ignore-scripts`), and the browser is downloaded explicitly.

| Package | Why |
| --- | --- |
| `playwright` | Drives the browser; the tool layer is built on it |
| `axe-core` | Automated accessibility rules for the implicit checks (MPL-2.0 licence, no dependencies, injected into the page by the runner, never by the model) |
| `yaml` | Reads the YAML case files |
| `zod` | Typed schemas for cases, model output, and the run record |
| `typescript` (dev) | Type checking; Node runs the `.ts` files directly |
| `vitest` (dev) | The bot's own tests |
| `@types/node` (dev) | Types for Node 24 |

## Rules for working here

Read [CLAUDE.md](CLAUDE.md). The short version: only the local fixture site is a valid target, credentials never reach the model or the artifacts, the actor never reports a verdict, and when the manual and the code disagree, stop and ask.
