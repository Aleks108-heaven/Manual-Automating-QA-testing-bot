# Runbook: the golden set

Owner: the bot maintainer. Signer: a named person who is not the maintainer. Last reviewed: 20 Oct 2026.

The golden set is a small pack of runs whose verdicts a person froze. Run it after every change to the bot, the prompts, the model, the browser, the tools or the cases, and weekly. If a verdict moves, something changed behaviour, and a person must decide whether the new verdict is right.

## Run it

```powershell
node src/cli.ts golden
```

It starts its own fixture site, runs every entry in `golden/golden-set.json` (about a minute), prints one line per entry, and writes `runs/eval/golden/golden-latest.json`. Exit code 0 means nothing moved. Exit code 2 means something is flagged. `--for-resume` makes a report that the kill switch accepts for resuming.

## Read the result

| You see | It means | What to do |
| --- | --- | --- |
| `ok` | Verdict, precedence row and every outcome match the frozen ones | Nothing |
| `CHANGED` | A verdict, a precedence row or an outcome moved | Read the details. Find the change that caused it. A moved **P1** entry is flagged at the top: do not ship until a person has looked at each one |
| `STALE` | The result matches, but the case file or script is not the one the entry was frozen with | A case or script was edited. A person reviews the edit, and re-freezes (below) |
| `nobody has frozen this set yet` | `frozen_by` is still `[to fill]` | Have the signer review every entry and put their name in |

The match rate is printed too. It is not a gate by itself: one moved P1 verdict fails the run however high the rate is.

## What an entry holds

`case`, the frozen `script` (the model's actions, while the model is scripted), `defects` switched on in the fixture, an optional `negative_control`, the expected `verdict`, the precedence `row`, the expected `outcomes` per expected result, a `rationale` a person can check, and the hashes of the case and the scripts when the entry was frozen. The case files live in `cases/`, not in the golden set, on purpose: a case that was loosened is exactly the drift this set must notice.

The set covers every verdict (PASS, FAIL, BLOCKED, INCONCLUSIVE, INCOMPLETE), the guardrail block, the judged result with and without a judge, a negative control, secrets, and a signed-in role.

## Freeze and change (a person does this)

1. Read the entries, the cases, and the rationale of each one. For each, answer: is this the verdict a careful human tester would give? Fix anything you disagree with in `expect`.
2. Put your name and the date in `frozen_by` and `frozen_at`.
3. Run `node src/cli.ts golden rehash`. It records the current hashes of the case files and scripts. It never touches an expected verdict.
4. Run `node src/cli.ts golden`. It must be clean.
5. Commit the file. A change to `golden/golden-set.json` is reviewed like a change to a test oracle, by someone other than the person who made it. The build agent drafted v0 of this set. The verdicts and precedence rows were written down before the first run, and the outcome of each FAIL entry was copied from that run after being checked against what the defect does. That is not a substitute for the signer's review.

When a case is changed on purpose: run the golden set, look at which entries moved and why, change `expect` only if the new verdict is the right one, then rehash. Never rehash to make a red run green without reading what moved.

## Limits

- With the scripted model the set checks the bot's machinery. It cannot show drift in a language model or its prompts. When a live model exists, the same entries run with it, and the frozen verdicts then measure drift of the model.
- A frozen set of 21 entries is small. It catches gross changes. It does not measure accuracy (that is the mutant eval and the pilot).
- The set is only as good as the person who signed it. A wrong frozen verdict freezes a wrong behaviour.
- On a real target, the golden run for resuming needs working bot accounts, but the kill switch has disabled them. The order of "restore the test accounts, run the golden set, resume" is for the security reviewer and the staging owner to settle in the drill. On the fixture each run uses a fresh site, so it does not arise.
