# Writing and running test cases: a guide for the tester

This is the short path from an idea to a report. The full rules for a case are on the manual page [Writing bot-ready test cases](../manual/06-writing-bot-ready-test-cases.md); this page is about what to do, in order.

**Today the bot tests only the local fixture site** (`fixtures/site`, started automatically). It will refuse any other target, by design, until the security review of a real target is done. So the cases you write now are for the fixture. The way of working is the same for a real application later.

## 1. A case is one file

A case is one `.yaml` file in the [cases/](../../cases/) folder. There are 15 examples; start from [TC-FORM-001.yaml](../../cases/TC-FORM-001.yaml). Copy a case that looks like yours, give it a new id, and change it.

```yaml
id: TC-FORM-006                     # TC-<AREA>-<three digits>, unique in the folder
title: Reject an email with two @ signs    # verb, object, condition
priority: P2                        # P1 (must pass before release), P2, P3
technique: equivalence partitioning
risk: RISK-FORM-VALIDATION          # the requirement or risk it covers
role: none                          # none, or a signed-in role from config (the runner logs in, the model never sees a password)
preconditions:
  - The newsletter form is available at /form
data:
  invalid_email: "a@@b.com"         # use this value in the steps as data.invalid_email
allowed_mutations:
  - POST /api/subscribe             # every request that changes state which this case may send
steps:                              # one action per step, in plain words
  - open /form
  - fill the Email field with data.invalid_email
  - click the Subscribe button
expected:                           # what must be true; code checks these, not the model
  - id: e1
    after_step: 3                   # checked after this step
    kind: text_visible
    where: {role: alert}
    text: "Enter a valid email"
    exact: true                     # the whole message must match, not only contain the text
    description: The validation message is shown
  - id: e2
    after_step: 3
    kind: status
    request: "POST /api/subscribe"
    status: 422
    description: The server rejected the submission
```

| Field | What to write |
| --- | --- |
| `steps` | Plain words, one action per step. The model reads them and uses the browser tools. Name the element the way the page does ("the Email field", "the Subscribe button"). |
| `data` | The values the steps use, as `data.<name>`. A password or token is never written here: write `secret:<name>` and the bot fills it without showing it to the model (`fill_secret`). |
| `expected` | One entry per check. The kinds are `text_visible`, `url`, `status`, `count`, `element_state`, and `judged` (a judge model decides, only for what code cannot check). Prefer the first five: code checks them, so no model can talk its way to a PASS. |
| `allowed_mutations` | The requests that change something (`POST /api/orders`, `POST /graphql#CreateOrder`, a logout link `GET /logout`). Anything not listed is blocked and the run ends INCONCLUSIVE. |
| `where` | `{role: button, name: "Subscribe"}` (the accessible role and exact name) or `{selector: "#id"}`. A password field has no role, so use a selector. |
| `setup`, `teardown` | Calls to the application's test API that prepare data before and clean up after (see `TC-AUTH-004.yaml`). Optional. |

Write expected results the bot can observe: a text, a URL, a status code, a count, an element state. "Works correctly" is not a check. For a limit, write the pair just inside and just outside.

## 2. Check the case without running it

```powershell
node src/cli.ts cases                          # every case in cases/, with its priority, checks and what it may send
node src/cli.ts cases cases/TC-FORM-006.yaml   # check one file; a problem is shown with its reason
```

It tells you when an id is wrong or used twice, when a step number in `after_step` does not exist, when a field is missing, when a case has judged results (they need a model to judge), and when a case cannot have a negative control. Nothing is run. Fix what it names and run it again.

## 3. Prove that the case can fail

```powershell
node src/cli.ts run cases/TC-FORM-006.yaml --negative-control
```

The bot makes one expected result wrong on purpose. **This must report FAIL.** If it reports PASS, the case checks nothing, and its PASS means nothing. Do this once for every new case.

## 4. Run it

With the scripted fake (needs a script file in `tests/ci/scripts/`, for the bot's own tests):

```powershell
node src/cli.ts run cases/TC-FORM-001.yaml
```

With a local model (LM Studio or Ollama; see [the live model runbook](live-provider.md) for the one-time setup):

```powershell
$env:QA_PROVIDER_URL = "http://127.0.0.1:11434/v1"      # Ollama; LM Studio is http://127.0.0.1:1234/v1
node src/cli.ts run cases/TC-FORM-006.yaml --live --model qwen2.5-coder:14b-instruct-q4_K_M
```

Several cases in one go, one after another, with one report:

```powershell
node src/cli.ts run cases/TC-FORM-002.yaml cases/TC-FORM-003.yaml cases/TC-FORM-004.yaml --live --model <id>
```

A batch runs the cases **one at a time**, because one local model answers one request at a time (running two at once on one CPU makes both slower, and each extra slot needs more memory). The known-good canary pair runs once for the batch, before the first case, and the later cases reuse its result. As a guide, on a laptop CPU with a 14B model a simple case takes about two minutes and the canary pair about five.

To watch a run, set `QA_BROWSER_HEADED=1` and `QA_BROWSER_SLOWMO_MS=600`, and **do not touch the browser window**: a page you open there is a navigation like any other, and one outside the allowed host ends the run as INCONCLUSIVE.

Other browsers: `QA_BROWSER_CHANNEL=chrome-canary` (or `chrome`, `chrome-dev`, `msedge-dev`, `msedge`) runs the Chrome or Edge installed on the machine instead of the Chromium the bot downloads. Canary and Dev change from day to day, so use them to check compatibility, not for an official run; the report names the channel. Firefox and WebKit are not offered.

## 5. Read the result

Each run ends with a verdict. **Only PASS is verified.**

| Verdict | Means | What to do |
| --- | --- | --- |
| PASS | Every expected result matched, with evidence the bot captured itself | Nothing. |
| FAIL | An expected result did not match | Open the report: it shows expected against actual and a draft bug report. A person decides whether it is a defect or a stale case. |
| BLOCKED | A step could not be done (an element is missing, a locator is ambiguous, the same action repeated) | The report names the step and has a screenshot. Often the case's wording or locator needs fixing. |
| INCONCLUSIVE | The result cannot be trusted: a request that was not declared in `allowed_mutations`, a navigation outside the allowed host, the target did not answer, or the model's report was invalid | The report says which. Declare the request, or fix the infrastructure. |
| INCOMPLETE | A budget (time, cost, tool calls) or the kill switch ended the run | Raise the limit if it was too small, or run again. |

The report is `runs/reports/<id>/report.txt` (and `report.json`); the command prints its path. Screenshots and the page text the bot captured are in the run's `evidence/` folder. Exit codes: 0 all PASS, 1 any FAIL, 2 anything else not verified, 3 nothing ran (refused), 64 a usage error.

## 6. Where a case "goes"

Nowhere: the bot reads the `cases/` folder. Put the file there, run it, and commit it to git so the team has it. A chat or agent host (VS Code, LM Studio) sees the same folder through the MCP tool `qa_list_cases` and runs a case by its id with `qa_run_case` (see [using the bot from another application](agent-integration.md)). The release report counts the cases in the folder, so a case you add is part of the inventory.

## When something goes wrong

| You see | Likely cause | Do |
| --- | --- | --- |
| `INVALID  cases\...` | A field is wrong or missing | Read the reasons under it, fix, run `cases` again. |
| `Pre-flight check failed: canary cases behave` | The bot or the model cannot do the known-good case | The model is too weak or the format failed; see the live model runbook. Do not run cases until it passes. |
| INCONCLUSIVE with a blocked request | The case sends a state-changing request it did not declare | Add it to `allowed_mutations`, if it is meant. |
| INCONCLUSIVE with a blocked navigation to another host | The page, or you in the browser window, went outside the allowed host | Do not touch the window; check the case's steps. |
| BLOCKED, element missing | The model could not find the element | Name the element the way the page does; use a `selector` for a field without a role. |
| `did not give a valid action after 3 attempts` | The model cannot follow the action format | Try another model, or the `tools` mode; see the live model runbook. |
