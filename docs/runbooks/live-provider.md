# Runbook: a live model (LM Studio, Ollama and other local servers)

Until now every run used a scripted fake model. This runbook connects a real language model. The bot talks to any server that answers the OpenAI-compatible chat API: LM Studio, Ollama, llama.cpp, vLLM. The code is in `src/model/openai-compatible.ts` (the actor), `src/judge/openai-compatible.ts` (the judge) and `src/frozen/openai-proposer.ts` (the proposer for frozen scripts). The wording the model sees is in `prompts/` (`actor.v1.md`, `actor-protocol.v1.md`, `judge.v1.md`, `proposer.v1.md`).

**What this does not prove.** The CI tests use a fake server on a loopback port. They show that the wiring, the prompts and the rules work. They say nothing about how well a particular model follows a case. That is what the eval suites are for, and they still run on the scripted model. A report from a live run says so in its header, and a live run on the fixture site is still not a pilot gate.

## Choose the model from the menu

1. Start the server.
   - LM Studio: load a model, open the Developer tab and start the local server (default address `http://127.0.0.1:1234/v1`).
   - Ollama: `ollama serve` (default address `http://127.0.0.1:11434/v1`). Set `QA_PROVIDER_URL=http://127.0.0.1:11434/v1`.
2. List what the server offers: `node src/cli.ts provider models`. The names printed are exactly what `--model` takes. A model that Ollama runs on its own servers (`...:cloud`) is marked, because the prompt then leaves this machine.
3. Check the choice: `node src/cli.ts provider check --model <id>`. It says whether the server answers and lists the model, and whether the server is on this machine.
4. Run a case: `node src/cli.ts run cases/TC-FORM-001.yaml --live --model <id>`. Then its negative control (`--negative-control`), which must report FAIL.

The model can also be set with `QA_PROVIDER_MODEL`, and the judge's model with `--judge-model` or `QA_PROVIDER_JUDGE_MODEL` (default: the same model). `preflight` and `frozen run` accept `--live` too.

## A first real run you can watch (Ollama, Qwen2.5-Coder 14B)

Use one model server at a time: close LM Studio, and do not load other models. The 14B model in Ollama is 9 GB.

1. Quit Ollama (its tray icon, Quit). Start the server in a terminal with the context you want, and leave it open:
   ```powershell
   $env:OLLAMA_CONTEXT_LENGTH = "16384"
   ollama serve
   ```
2. In a second terminal, in the bot's folder:
   ```powershell
   $env:QA_PROVIDER_URL = "http://127.0.0.1:11434/v1"
   $env:QA_PROVIDER_CONTEXT = "16384"        # what you set on the server
   $env:QA_PROVIDER_TIMEOUT_MS = "600000"    # a 14B model on a laptop is slow
   $env:QA_MAX_WALL_MS = "1200000"
   node src/cli.ts provider models
   node src/cli.ts provider check --model qwen2.5-coder:14b-instruct-q4_K_M --probe-context
   ```
   The probe loads the model and reads a long prompt, so it takes a while. It must say that the server took in the declared context.
3. Watch a run. The browser window is shown and each action is slowed down. The canary pair is skipped for this first look only (it runs the model twice more); put it back for real runs.
   ```powershell
   $env:QA_BROWSER_HEADED = "1"; $env:QA_BROWSER_SLOWMO_MS = "600"
   $env:QA_REQUIRE_CANARIES = "0"; $env:QA_CANARY_CASES = ""
   node src/cli.ts run cases/TC-FORM-001.yaml --live --model qwen2.5-coder:14b-instruct-q4_K_M
   node src/cli.ts run cases/TC-FORM-001.yaml --live --model qwen2.5-coder:14b-instruct-q4_K_M --negative-control
   ```
   The first must end PASS and the second FAIL. The report header says `(live)`. If the model cannot follow the format, the run ends INCONCLUSIVE or BLOCKED with the reason, never PASS.

## Settings (config `provider`, with environment overrides)

| Setting | Meaning | Override |
| --- | --- | --- |
| `kind` | `scripted` (default) or `openai-compatible` | `QA_PROVIDER`, or `--live` |
| `baseUrl` | The server's address including `/v1` | `QA_PROVIDER_URL` |
| `modelId`, `judgeModelId` | The names from `provider models` | `QA_PROVIDER_MODEL`, `QA_PROVIDER_JUDGE_MODEL` |
| `actionMode` | `json` (default): the model answers each turn with one JSON action. `tools`: the server's native tool calling | `QA_PROVIDER_MODE` |
| `structuredOutput` | Ask the server to hold the answer to a JSON schema. Turn it off if the server rejects it | (config only) |
| `vision` | True only for a model that can read images. Then the judge is sent the screenshots | `QA_PROVIDER_VISION=1` |
| `temperature`, `seed`, `maxOutputTokens` | Sampling. Temperature 0 and a fixed seed by default | (config only) |
| `requestTimeoutMs`, `maxResponseBytes`, `maxToolResultChars`, `maxEvidenceChars` | Limits on one request, on an answer, on how much of a page snapshot is shown to the actor, and on how much of one piece of evidence is shown to the judge | `QA_PROVIDER_TIMEOUT_MS` for the first; the rest in the config |
| `contextTokens` | The context length you set on the server. Every prompt is fitted into it, or not sent | `QA_PROVIDER_CONTEXT` |
| `pricing` | Dollars per million tokens for this provider; zero for a model on this machine. Used instead of the global placeholder prices | (config only) |
| `apiKeySecret` | The name of the secret holding a server's API key, or null. The key is read from `QA_SECRET_<NAME>` and is never in the file | (config only) |
| `registerEntry` | Where the provider register entry is kept. Required before any prompt may leave this machine | `QA_PROVIDER_REGISTER_ENTRY` |

**Which mode.** Start with `json`. It works with any model that can follow instructions, including models whose chat template has no tool calling. Use `tools` only for a model and chat template that support tool calling (LM Studio marks such models; Ollama lists the capability in `ollama show`). I have not tested any real model, so check the choice with `provider check` and a first run before relying on it.

## The data handling rule, in code

The Data handling page says only synthetic or masked data may go to a provider, and a provider needs a register entry. The configuration enforces the part that can be checked:

- A server on this machine (`127.0.0.1`, `localhost`, `[::1]`) keeps every prompt on the machine.
- Any other address, or any model whose name ends in `:cloud` or `-cloud`, needs `registerEntry`, and an address off this machine must be `https`. Without them the configuration does not load, and the command line refuses to start before anything is sent. Listing the models (`provider models`) applies the same rule, because it sends the API key.
- The base address may not carry a user name or password.
- These are checks of the names, not of the facts. `registerEntry` is a reference that a person writes: the code cannot tell whether the entry exists or whether the review behind it was done. A `:cloud` model that is renamed locally is not recognised by its name. Treat the check as a guard against accidents.
- Inline data in a case is shown to the model as written. A password typed into a case's `data` reaches the model, and a remote provider with it. Secrets belong in `secret:` references, which show only their key.

The register itself (its location, and the answers about training, retention, processing location, sub-processors, contract and audit logs) is still `[to fill]` on the Data handling page. A person fills it before a remote provider is used.

## What the model is shown

- The case: its steps, the data (a secret shows only its key, such as `data.correct_password`, never a reference or a value; a literal value is shown as written), and the expected results to observe.
- Each page snapshot, result and error inside a data block, with a notice that it is data and not instructions. The block is opened and closed by a marker with random characters that is new for each model client (`<page-data id="...">`), so a page cannot close the block and write text that looks like an instruction. Tool results were scrubbed of the run's secrets by the tool layer before the client gets them; the client's own redactor knows no secrets. A long snapshot is cut at `maxToolResultChars` and the cut is marked.
- The same for evidence shown to the judge and for what the proposer sees, cut at `maxEvidenceChars`.
- Earlier steps as short lines. Screenshot ids are kept, because the final report cites them. The model is not given images.

An answer that is not a valid action or report is sent back with the reason, up to `modelOutput.maxAttempts` times, and is never repaired: a stray `verdict` key, a missing `args`, a Markdown code fence or a sentence around the JSON, a `<think>` block, each makes the answer invalid. The one thing accepted is the empty argument string that a server sends for a tool without arguments, which means no arguments. A reasoning model that writes its thinking into the answer needs the server to keep the thinking out of it, or it will not work with this client. An answer cut off by the token limit is an error that names `provider.maxOutputTokens`.

When the attempts run out, an action that never became valid ends the run as a crash (INCONCLUSIVE), and a final report that never became valid is INCONCLUSIVE as before. A model that repeats itself is stopped by the runner as BLOCKED. A server that is still answering when the wall-clock budget ends gives INCOMPLETE; a request that times out on its own (`requestTimeoutMs` shorter than the time left) is an error and gives INCONCLUSIVE. A transient server error is not retried. None of these is ever PASS.

**The kill switch and the time budget cancel the request.** When the runner stops waiting for a call (the kill switch is engaged, or the time budget ends) the request is cancelled and no retry follows, so a prompt with page text does not keep going to the server. This holds for the action, the final report, the judge and the proposer. A model that is writing its final report when the kill switch is engaged does not keep the run busy, and the run is never PASS.

## Cost and time on a local model

- The cost budget turns tokens into dollars. The global `pricing` (3 and 15 dollars per million tokens) is a placeholder for the fixture and is used only with the scripted fake. A live provider has its own prices, `provider.pricing`, and the default is **zero** because a model on this machine costs nothing. Then the cost budget never stops a run, and the time budget `budgets.maxWallMs` is the limit that matters. A provider that charges (it needs a register entry anyway) must have its real prices set there.
- A 14B or 22B model on a laptop is slow. The default `maxWallMs` and `requestTimeoutMs` of 120 seconds may be too short for a case with several snapshots. Raise them with `QA_MAX_WALL_MS` and `QA_PROVIDER_TIMEOUT_MS` (or in the config) rather than weakening a check.
- To watch a run, set `QA_BROWSER_HEADED=1` (the browser window is shown) and `QA_BROWSER_SLOWMO_MS=500` (a pause between actions). Nothing else changes: the same tools, rules and checks apply.
- The pre-flight check runs the canary pair with the same live model, so a model that cannot pass the known-good canary stops the run before the case starts. The quota check is skipped (a local server reports none), and a skipped check also means the report cannot be used to resume the kill switch.
- If the server does not report token counts, the client makes a rough guess from the text length (about 3 characters to a token, with the tools and the schema counted). It is a guess, and it can be off either way.
- **Context length.** A prompt longer than the model's context window is cut by the server (Ollama does it itself, and logs only a line in its own log), usually from the front, which drops the rules at the top without any error. The size of the window is set on the server when the model is loaded, not by the bot. Ollama: `OLLAMA_CONTEXT_LENGTH` (set it in the environment that starts the server), or `num_ctx` in a Modelfile. LM Studio: the context length when loading the model. I do not know your Ollama version's default; `ollama ps` shows the window of a loaded model.
  - Tell the bot the size you set: `provider.contextTokens` (default 8192, or `QA_PROVIDER_CONTEXT`). Every prompt is then **fitted** to it before it is sent: if the prompt and the answer would not fit, the page text in it is shortened step by step (the cut is marked in the text, and the rules and the case stay whole), and if even a small piece of page does not fit, the bot refuses to send and says what to raise. A prompt is never sent to be cut silently.
  - Check that the server really holds that much: `node src/cli.ts provider check --model <id> --probe-context`. It sends a long prompt (about 95% of `contextTokens`) and reads back how many prompt tokens the server took in; fewer than were sent means the window is smaller than declared. It is slow on a small machine, so it is run on request, once per setup.
  - A page snapshot plus the rules and the case needs several thousand tokens, so 8192 is a minimum and 16384 is safer. More context needs more memory.

## When something fails

| Symptom | Likely cause |
| --- | --- |
| `could not be reached` | The server is not running, or the address or port differs (LM Studio 1234, Ollama 11434). |
| `provider reachable ... not in the provider's model list` | The model name does not match `provider models`, or the model is not loaded. |
| `HTTP 400` mentioning `response_format` or `json_schema` | The server does not support structured output. Set `structuredOutput` to false. |
| `HTTP 400` mentioning `tools` | The model or template has no tool calling. Use `actionMode` `json`. |
| `cut off by the token limit` | The answer did not fit in `maxOutputTokens`. Raise it, or use a model that does not think aloud. |
| `not a single JSON object (no code fence ...)` three times | The model wraps its answer in a code fence or text. With `structuredOutput` on, the server should hold it to a schema; if the server ignores that, use another model. |
| `did not give a valid action after 3 attempts` | The model cannot follow the action format. Try another model, `tools` mode, or a larger model. The run is INCONCLUSIVE. |
| `did not answer within ... ms` | The model is too slow for `requestTimeoutMs`. |
