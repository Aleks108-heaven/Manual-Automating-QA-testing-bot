# Runbook: frozen scripts

Owner: the bot maintainer. Approver: a person listed in `release.approvers`. Last reviewed: 21 Oct 2026.

A case that has proved stable can be frozen into a script: the acting tool calls of the runs that passed, per step. The script replays through the same runner as any other run, with no model. The runner still applies the allowlist, the mutation rules and the redactor, and still evaluates the case's expected results in code. A script holds no assertion of its own, so it cannot loosen one.

## The three rules

1. **A failed assertion stays FAIL.** The agent never re-runs a case to turn it into a PASS. The agent is not consulted at all when an assertion fails.
2. **The agent re-engages only when a script step cannot run** (a locator is stale, an element has moved). The run is then BLOCKED, and the agent is asked only to diagnose it and propose a change. The proposal is a file in the run directory. Nothing reads it except a person, and it does not change the verdict.
3. **A person approves every script and every change.** A script that is not registered, whose file no longer has the registered hash, or whose case file changed since the approval, is refused before the run starts. The case is then reported as not executed.

## Freeze a case

```powershell
node src/cli.ts frozen freeze cases/TC-FORM-001.yaml runs/<run dir 1> runs/<run dir 2> runs/<run dir 3>
```

Give it the run directories of runs driven by an actor. It refuses, and says why, unless:

- there are at least `frozen.minPassingRuns` runs (provisional: 3), all PASS, all of this case, and none of them a replay of a script;
- every run passes the reporter's own checks, has all the steps of the case, and had no failed tool call;
- every run did exactly the same acting calls (`goto`, `click`, `fill`, `fill_secret`, `press`, `wait_for`) in the same order;
- the case has no `judged` expected result (a script runs without a judge, so it could not decide one);
- no action typed a value the redactor had scrubbed (secrets go in with `fill_secret`).

The observation tools (`snapshot`, `screenshot`, `console_errors`, `network_errors`) are left out. A draft is written to `frozen/drafts/<case>.v<N>.json`. A draft is not in the register, so it cannot run. If the proving runs used a scripted fake, the command says so, and the script records it (`source.live_model`).

## Approve it (an approver does this)

Read the draft, then:

```powershell
node src/cli.ts frozen approve frozen/drafts/TC-FORM-001.v1.json --by <your name>
```

`--by` must be in `release.approvers`. With none configured nobody can approve. To try this without editing the file, set `QA_RELEASE_APPROVERS=Odin` in the shell. The command copies the script to `frozen/scripts/<case>.v<N>.json`, never overwrites a registered file, and writes the file's hash, the case's hash, the approver and the date to `frozen/register.json`. The case file must be the one the script was frozen from.

## Run it

```powershell
node src/cli.ts frozen run cases/TC-FORM-001.yaml
```

It runs behind the same kill switch and pre-flight check as any run, and ends with the same report. The report has a "Script" line with the version, the script hash, the case hash, and the words "no model was called". The report header still says `scripted`, because a replay is not a language model, and the release report treats it the same way, so a frozen run is never complete release evidence for now. Whether a script frozen from live-model runs should count is a question for the release-decision policy page.

Exit codes: as for `run`, and 3 when the script is refused.

## When a step cannot run

The run is BLOCKED at that step, with a screenshot taken by the runner. If `--proposal-script <file>` is given (a scripted proposer, for now), the proposer gets the failing step, the failed call and the page snapshot, which is data and never instructions. It answers within `modelOutput.maxAttempts` tries. An invalid answer is sent back with the field names and rules that were wrong, and it is never repaired. The result is one of:

| `frozen.reengagement` | Meaning |
| --- | --- |
| `not_needed` | Every step ran. A MISMATCH is a FAIL and lands here too |
| `proposal_written` | `proposal.json` is in the run directory |
| `proposal_invalid` | No valid proposal. A person looks at the script |
| `not_requested` | No proposer was configured |

To accept a proposal:

```powershell
node src/cli.ts frozen approve-proposal runs/<run dir>/proposal.json --by <your name>
```

This makes version N+1 with that one step replaced, and registers it. A proposal for any script other than the active one is stale and is refused. Version N stays on disk with its hash. Run the case again and read the report: the new step has not been proven by any run until it has run.

## What a hostile or damaged file can and cannot do

The registers, scripts, proposals, run records and reports sit on disk where anything else on the machine can write too. The bot does not trust them more than it must:

- **No file is run on its word.** A script runs only if its hash is the registered one, its case file has the registered hash, and it passes the schema. The register may only point inside `frozen/scripts`. A case id is checked against the case id pattern wherever it is read (scripts, register, proposals), so it cannot become a path such as `..\..\x`.
- **A script can only hold six acting tools** (`goto`, `click`, `fill`, `fill_secret`, `press`, `wait_for`), each with arguments that pass the tool layer's own schema. There is no shell, file or network tool to name. Even an approved script that goes to a host off the allowlist is refused by the tool layer at replay, and the run is INCONCLUSIVE.
- **Files are size-capped before they are parsed** (1 MB for registers, scripts and proposals, 20 MB for run records and reports), so a huge file cannot exhaust memory.
- **Writes are atomic**, and an approval holds a lock file (`frozen/register.json.lock`), so a second approval cannot interleave. A crash between the script file and the register entry is finished by approving the same script again, and a leftover file with other content is never overwritten. If a lock file is left behind by a crash, a person removes it.
- **The hash in the record is checked at run time**, not only on the command line, so a run cannot stamp the approval of a script it did not replay.
- **A proposer that hangs** is under the kill switch and the run's time budget like every other call. The kill switch ends the wait at once (`runner_stop_reason` is `killed`), and the time limit ends it as `timeout`.
- **Freezing needs runs of the case as it is now.** Runs made with other step text, other expected results or another role are refused.

## Limits

- **Approval is by name, not by identity.** `--by` is a name typed on the command line and compared with `release.approvers`. Nothing proves who typed it. This is the same for the kill switch and for the quarantine and override register. Binding an approval to a signed-in person (a signed commit, a ticket, a single-sign-on identity) is for the security reviewer and the program owner to decide before the bot gates anything.
- The case file is looked up as `cases/<id>.yaml`. If a case lives elsewhere, pass `--case <file>` to `approve` and `approve-proposal`.

- Everything here ran with a scripted fake model and a scripted proposer. A live proposer is not built, and its cost would be charged to the run's budget.
- Locators in a script are the ones the actor used (role and name, or selector). The run record's `resolved_locator` field is still not filled, so a script cannot be hardened with a more stable locator yet.
- The register is a JSON file in the repository. Where it is kept as a decision record is a decision for the program owner.
