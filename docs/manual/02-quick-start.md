## Quick start

The bot runs a written test case in a browser like a manual tester and returns a verdict with evidence, so you can see a first result in about five minutes.

A run does three things:

- Reads a test case: steps, data, and expected results.
- Drives a browser through the steps with a fixed set of tools, saving a screenshot and a log for each step.
- Checks each expected result against the evidence and reports PASS, FAIL, BLOCKED, INCONCLUSIVE, or INCOMPLETE.

**Your first run**

1. Get access: [to fill: how to request runner and report access].
2. Open the sample case at [to fill: path]. It is a login case with observable expected results.
3. Run it against [to fill: staging URL] with [to fill: command or button].
4. Open the report at [to fill: location]. Find the verdict, the step list, and the screenshots.
5. Run the negative control: change one expected result to something wrong and rerun. The bot must report FAIL. If it reports PASS, stop and tell the bot maintainer, because that is a defect in the bot.

**Where to go next**

| You are a | Read |
| --- | --- |
| Tester or case author | Writing bot-ready test cases; Running tests |
| Triager | Reading results and triage |
| Developer | Reading results and triage; Environment, test data and staging footprint |
| Maintainer | Guardrails and security rules; Environment; The bot's instruction pack |

A green run is evidence, not a sign-off. It shows that the encoded checks found nothing, not that no defects exist.
