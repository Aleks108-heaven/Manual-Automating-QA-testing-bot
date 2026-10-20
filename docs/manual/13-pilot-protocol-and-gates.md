## Pilot protocol and gates

The pilot decides go, iterate, or stop on gates written before the first run, and the thresholds on this page are yours to set. Planned window: [to fill: pilot dates].

**Before the first pilot run.** Every item must be ticked.

- [ ] The environment drill passed.
- [ ] The footprint drill passed.
- [ ] The security review is done, with no open blockers.
- [ ] Golden set v0 and the injection test page run clean.
- [ ] The data handling review is complete, with provider terms recorded.
- [ ] The kill switch has been tested, and the cost estimate and per-run budgets are recorded.
- [ ] A named triage owner is on duty for every pilot day.
- [ ] The gates below are filled in and approved by the sponsor in writing.

**Design**

- 15 to 20 cases chosen by risk: P1 and P2 cases on stable features.
- 3 to 5 tricky cases: popups, dynamic content, slow loads.
- Negative controls: a wrong expected result and a missing element, neither of which may PASS.
- 5 to 10 seeded defects in staging for the blind human comparison, plus a large set of toggleable mutants on the fixture site. The mutants give the detection rate tight bounds for the fixture's defect classes only, so they do not replace the real-application seeds.
- Humans run the same cases blind, on the same build.
- The bot runs each case three times, in one default configuration.

**Gates**

| Metric | How measured | Gate |
| --- | --- | --- |
| Wrong PASS (real defects) | Seeded and known defects in the real application missed ÷ total | [to fill]. A missed critical defect blocks "go" until its cause is found |
| Wrong PASS (fixture mutants) | Mutants on the fixture site missed ÷ total, reported per defect class and never pooled with the row above | [to fill] |
| False FAIL (noise) | Bot FAILs that humans refute ÷ bot FAILs | [to fill; set by triage capacity] |
| Verdict agreement | Bot vs human on identical cases | [to fill; compare with human-to-human agreement] |
| Repeatability | Same verdict across the three runs | [to fill; stricter for P1] |
| Evidence completeness | FAILs with steps, screenshots, and logs | [to fill; near 100%] |
| Decisive rate | Runs ending in PASS or FAIL ÷ all runs | [to fill]. A bot that answers INCONCLUSIVE to everything is safe but useless, and it floods triage |
| Cost and time | Cost and minutes per case against manual, including triage | [to fill] |

**What the numbers can show.** If the bot and humans disagree on none of n cases, the 95% upper bound on the true disagreement rate is still 13.9% at n=20, 5.8% at n=50, and 3.0% at n=100. This assumes independent, representative cases, which risk-based picking is not, so treat the bounds as optimistic. A 20-case pilot catches gross problems but cannot certify reliability, so plan a second stage of 50 to 100 cases. Repeating a case measures repeatability, not coverage.

**Missed defects follow the same arithmetic.** If none of n seeded defects is missed, the 95% upper bound on the true miss rate is 25.9% at n=10, 9.5% at n=30, 5.8% at n=50, and 3.0% at n=100. Ten staging seeds therefore prove little, which is why the fixture site carries toggleable defects that yield hundreds of mutants. Those bounds describe the fixture's defect classes. Repeated runs of one mutant are not independent, so count each mutant once, and do not read the fixture result as the miss rate on your application.

**Humans are not a perfect benchmark.** Have two testers run a sample independently and measure their agreement. Have a third person decide the disagreements, and report the bot's agreement against that decision.

**Cost estimate before the pilot.** Estimate LLM cost per case as steps × input tokens per step × price, plus output and judge calls, then multiply by cases, runs, and cadence. If every step resends the full history, input grows faster than the step count. With illustrative assumptions of 2,000 base tokens and 500 history tokens added per step, a 25-step case uses 212,500 input tokens and a 50-step case uses 737,500. Trimming history to 5,000 tokens cuts those figures by 28% and 56%. For 200 cases at 25 steps, that is 42.5M input tokens per run untrimmed and 30.5M trimmed. The 500-token history figure is probably too low once accessibility snapshots and screenshots are kept in the history, and the estimate ignores provider prompt caching, which cuts the price of a resent prefix but is broken by trimming history. Treat all of these figures as placeholders, and replace them with token counts measured in the first live runs. Record your own estimate and set the per-run budgets from it: [to fill: price per million tokens, expected cost per run and per month].

**Decision rule**

- Go: all gates are met. Expand, and keep results advisory in CI.
- Iterate: failures trace to fixable causes such as ambiguous cases, the environment, tool gaps, or prompts.
- Stop or rescope: wrong PASS persists after fixes, or cost and triage burden exceed manual effort. Fall back to scripted or hybrid automation.
