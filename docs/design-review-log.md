# Design review log

A review (by an AI, not an independent human reviewer) of manual v0.1 and the build brief, run by Claude Code on 20 Oct 2026, raised 21 findings: 16 are applied in manual v0.2 and the updated brief, 2 are partly applied and wait on your input, and 3 wait on the repository or on how the brief was exported. The "what changed" and status columns were written by the manual's author, not by the reviewer.

**Reviewer's verdict.** The manual's design is sound and more rigorous than most LLM-testing proposals the reviewer sees, and it is worth building on. Before M1, fix about six design flaws and reorder the milestones. The biggest strategic gap was that automated testing barely appeared, which the hybrid path now addresses. The reviewer read "manual and automated" as a bot that executes human-written cases like a manual tester, with proven cases frozen into scripts later. That reading is correct.

**What the review found strong**

- Verdicts: code computes them, and only PASS with cited evidence counts as verified.
- Enforcement: the tool layer enforces the allowlist and credentials, not the prompt.
- Staged authority: the bot starts advisory and earns more.
- Honesty: the golden set, the injection page, the "executed X of Y, Z not verified" wording, and the statistics caveats keep results honest.

**Design flaws**

| ID | Finding | What changed | Status |
| --- | --- | --- | --- |
| F1 | The actor self-grades: its output includes a verdict and a match flag, while a judge and code are meant to decide | The actor reports observations only. Assertions and the judge give outcomes, and code computes the verdict. See The bot's instruction pack v1 and Definitions | Done |
| F2 | Verdict precedence is undefined, and "page unreachable" (BLOCKED) conflicts with "staging unhealthy" (INCONCLUSIVE) | A six-row precedence table on the Definitions page, tested by T18. An unreachable host or provider is INCONCLUSIVE, and BLOCKED is for case or app causes only | Done |
| F3 | Login cases cannot work with login_as(role), and TC-AUTH-004 needs the correct password | Each case starts from a stored session per role, created outside the model's context. Login cases use fill_secret(field, ref). The example case is rewritten | Done |
| F4 | T2 would miss a real leak, because traces and HAR files capture request bodies, including the login request | Tracing and HAR are disabled or redacted around credential entry, and T2 scans traces and HAR files explicitly | Done |
| F5 | Risky actions cannot be detected from a click | Enforcement moved to the network layer: undeclared non-GET requests are blocked, cases declare allowed mutations, and redirects, popups, iframes, websockets, and file:, data:, javascript: URLs are covered (T1, T16) | Done |
| F6 | Hard assertions have no source, because expected results are free text | Expected results are structured entries (text_visible, url, status, count, element_state, judged) in YAML cases, and only judged ones go to the LLM | Done; YAML to confirm |

**Testing the bot itself**

| ID | Finding | What changed | Status |
| --- | --- | --- | --- |
| Q1 | Live-model tests (T5 to T8, T12, T13) are non-deterministic | A replay model client for CI, and a separate eval suite that runs the live model N times against thresholds. Each test is marked CI, Eval, or both | Done; N and thresholds [to fill] |
| Q2 | The seeded-defect gate has almost no power: with zero misses, the 95% bound is about 26% at n=10 and 9.5% at n=30 | The arithmetic is on the pilot page, and the fixture site carries toggleable defects, so one site yields many mutants (T19) | Done |
| Q3 | No gate measures the decisive rate, so a bot that answers INCONCLUSIVE to everything looks safe | Decisive rate added as a gate and as a defined term | Done; threshold [to fill] |
| Q4 | The implicit-check policy is still [to fill] | Version 1 reports implicit-check findings with the verdict and does not let them change it. Revisit with pilot data | Done |

**Plan and sequencing**

| ID | Finding | What changed | Status |
| --- | --- | --- | --- |
| S1 | Move dependency pinning (T10) to M1 | Done in M1 | Done |
| S2 | Define the run-record schema in M2, with the reporter as a view over it | A first schema in M1 and the final one in M2. The run record is now a module | Done |
| S3 | Build a thin vertical slice first | M1 is the thin slice, with an end-to-end case and a negative control (T17) | Done |
| S4 | Add the hybrid path as a milestone | M7 freezes proven cases into scripts, and the manual describes the hybrid path. The page on freezing cases is still to write | Done; page to write |
| S5 | Do a back-of-envelope cost model now | A method and illustrative token figures are on the pilot page. Your own estimate is still [to fill] | Partly done |
| S6 | Scale the governance to your team | A "Small team" paragraph sets the minimums. Your role merges are [to fill] | Partly done |

**Document hygiene**

| ID | Finding | What changed | Status |
| --- | --- | --- | --- |
| H1 | The triage decision tree is lost in export | A text version sits directly below the drawing | Done |
| H2 | A stray "Build brief" line at the end of the manual | Removed | Done |
| H3 | The brief's tables flattened in the export | The files in the repository are native Markdown and the tables are intact | Closed 20 Oct 2026 |
| H4 | Split the manual into one file per page | Done in the repository: docs/manual/ holds one file per page with 00-index.md | Closed 20 Oct 2026 |
| H5 | Keep the actor and judge prompts as files | The rule is on the instruction pack page and in the layout (prompts/actor.v1.md, prompts/judge.v1.md). The prompts now exist as prompts/actor.v1.md and prompts/judge.v1.md, and the manual links to them | Closed 20 Oct 2026 |

**Open decisions from the review.** They are tracked in the build brief's decisions table.

- Language: TypeScript with Playwright suggested, or Python if the maintainers know it better.
- Case format: YAML, adopted as the recommended default.
- Agent loop: a thin custom loop on the provider's tool-calling API, adopted as a fixed constraint.
- Provider and model: any provider works for M1 to M5 on synthetic data, but it must be decided before M2, and the data handling review must clear before staging.
- Runner, secret manager, evidence storage, and test framework: these depend on your infrastructure.

**Reviewer's proposed next steps**

1. Clean up both documents into the docs/ layout and write CLAUDE.md with the decisions filled in. Waiting on the decisions above.
2. Revise the actor, judge, and verdict-precedence spec (F1 and F2), then plan M1. This was the reviewer's preferred first step. The spec is revised in the manual, so Claude Code can plan M1 next.

## Second review (20 Oct 2026, manual v0.2 to v0.3)

A second review by Claude Code, again an AI and not an independent human review, found 5 specification gaps that change interfaces, 4 plan and test adjustments, and 6 document problems. All are applied in manual v0.3 and the updated brief, except where noted. Neither review replaces the human design review and the non-maintainer security review that the pilot-readiness review requires.

| ID | Finding | What changed | Status |
| --- | --- | --- | --- |
| G1 | Expected results had no `id` and no point in time at which they are checked, and the actor chose the evidence the judge saw | Every expected result has `id` and `after_step`. The runner evaluates it in code with a wait and retry, and captures the evidence itself. Tests T22 and T23 | Done |
| G2 | The precedence table had holes: an application crash looked like an infrastructure failure, and guardrail blocks, injection flags, empty cases, and failed cleanup had no rule | Seven-row table and a rules list on the Definitions page. T18 extended | Done |
| G3 | The hybrid path could turn a FAIL into a PASS by re-running the case with the agent | A failed script assertion stays FAIL, the agent only proposes changes, and a human approves them. T21 rewritten. The run record stores replayable actions | Done |
| G4 | Stored sessions put session tokens in every request, and the session file is itself a credential | Always-on header redaction, a session-file rule, a wider definition of credential string, per-case session copies. T2 extended | Done |
| G5 | Network-layer blocking treated GET as safe and ignored GraphQL and websockets | State-changing requests are declared and blocked by method, path, GraphQL operation, and websocket send. T16 extended. A block ends the run as INCONCLUSIVE | Done |
| P1 | Recorded model cassettes break on any prompt or snapshot change | A scripted fake model serves CI, and cassettes are an optional smoke test | Done |
| P2 | The biggest uncertainty, the model driving real snapshots, is postponed to M3 | A non-gating live-model run at the end of M1 records real step counts and token use. The provider decision is due before M3, not M2 | Done |
| P3 | Mutants and real seeded defects were pooled in one gate, and fixture bounds were presented as if they applied to the application | Two gate rows, per-class reporting, and a caveat on the pilot page | Done |
| P4 | The cost inputs were probably low and ignored prompt caching | A caveat on the pilot page, and a requirement to replace the figures with measured ones | Partly done: your measured estimate is still [to fill] |
| D1 | The example case put two actions in one step | Six single-action steps, four expected results with ids and `after_step` | Done |
| D2 | The same rules were stated on two pages and had already started to differ | The P1 rule, "Who decides", and the implicit-check sentence now live on the Definitions page, and other pages link to it | Done |
| D3 | The 0.1 change-log entry was re-dated | Restored to 19 Oct 2026, and the log is marked append-only | Done |
| D4 | Two copies of the manual, and no repository | git initialised, earlier versions moved to archive/ | Done |
| D5 | The design reviews were described as independent | Reworded as AI reviews, and the need for a human reviewer is stated in Document control | Done |
| D6 | H3 could be closed | Closed in the first table | Done |

**Still open:** the four decisions due before M3 to M5 (provider, secret manager, runner, evidence storage), N and the thresholds for eval tests, and every [to fill] marker in the manual, which must be resolved before the pilot-readiness review.
