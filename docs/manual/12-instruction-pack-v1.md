## The bot's instruction pack v1

This pack is what the bot reads. It is version-pinned, reviewed like code, and must agree with the Definitions page.

**The prompts are files, and the files are the source of truth.**

- Actor: [prompts/actor.v1.md](../../prompts/actor.v1.md)
- Judge: [prompts/judge.v1.md](../../prompts/judge.v1.md)

This page does not repeat them. Who decides a verdict, the precedence table, and the stop-reason mapping live on the Definitions page. The actor's stop reasons are element_missing, step_ambiguous, and loop, and budget, timeout, and crash stops come from the runner. The runner also detects loops itself and does not wait for the model to report them.

**Handling rules**

- Change the prompts only by pull request.
- Run the golden set before every change ships, and later the eval set too.
- Stamp every report with the pack's version and hash.
- Keep secrets out of the prompts, and take examples only from cases outside the held-out eval split.
- Change verdict names only after changing the Definitions page.

**Tune during the pilot.** The loop limit of three, the run budgets, and the screenshot cadence are starting values.
