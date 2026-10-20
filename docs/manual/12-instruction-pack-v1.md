## The bot's instruction pack v1

This pack is what the bot reads. It is version-pinned, reviewed like code, and must agree with the Definitions page.

**The prompts are files, and the files are the source of truth.**

- Actor: [prompts/actor.v1.md](../../prompts/actor.v1.md)
- Judge: [prompts/judge.v1.md](../../prompts/judge.v1.md)

This page does not repeat them. Who decides a verdict, the precedence table, and the stop-reason mapping live on the Definitions page. The actor's stop reasons are element_missing, step_ambiguous, and loop, and budget, timeout, and crash stops come from the runner. The runner also detects loops itself and does not wait for the model to report them.

**What the judge is given.** Its input has exactly these parts: the case ID; the judged items, each with the case author's description and the evidence the runner captured for it (the evidence IDs it may cite, the scrubbed text of the snapshot and network log, the path of the screenshot); the list of actions the runner saw (tool, arguments, whether each worked); the scrubbed console errors; the attempt number; and, on a retry, a description of what was wrong with the previous answer. It is never given the actor's observations, notes, evidence claims or injection flag, and the code has no field in which to put them. Its answer is checked in code before it counts (Definitions page).

**Handling rules**

- Change the prompts only by pull request.
- Run the golden set before every change ships, and later the eval set too.
- Stamp every report with the pack's version and hash.
- Keep secrets out of the prompts, and take examples only from cases outside the held-out eval split.
- Change verdict names only after changing the Definitions page.

**Tune during the pilot.** The loop limit of three, the run budgets, and the screenshot cadence are starting values.
