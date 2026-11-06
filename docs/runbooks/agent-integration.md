# Runbook: using the bot from another application, VS Code or LM Studio

There are three ways to use the bot as a part of something else. All three run cases through the same code (`src/batch.ts`), so the pre-flight check, the budgets, the kill switch, the redactor and the verdict table apply the same way.

| Way | Use it when | Entry point |
| --- | --- | --- |
| Library | Your own agent application starts runs and reads reports | `src/index.ts` (`QaBot`) |
| MCP server | A chat or agent host (VS Code agent mode, LM Studio, Claude Code) should be able to run cases | `mcp/server.ts` |
| Command line | A script or a person | `src/cli.ts` |

**The rule behind all three.** The model of the host never drives the browser. The bot runs the case with its own model (see [the live model runbook](live-provider.md)) inside its own runner, and the runner's code decides the verdict. A host can start a case and read the report. It cannot click, fill a field, name a secret, change the target, change the model, engage or resume the kill switch, or approve a frozen script.

## 1. As a library

Node runs TypeScript directly, but not from inside `node_modules`. Use the bot from a path or a linked folder (`npm install ../Manual-Automating-QA-testing-bot` links it). Start your application with the bot's folder as the working directory, or pass a `Config` loaded from an absolute path whose folders (runs, sessions, cases, kill switch) are absolute too: the configuration file, the cases and the run folder are relative paths. The prompts, the versions in the run record and the source hash are found from the bot's own folder and do not depend on the working directory.

```ts
import { QaBot } from "qa-automation-bot"; // src/index.ts

const bot = await QaBot.create(); // the live provider from config/default.json and QA_PROVIDER_* variables
const result = await bot.run({
  target: "http://127.0.0.1:4173", // only the local fixture site is accepted
  cases: [
    { object: myCaseObject, label: "from-my-app" }, // checked against the case schema before anything runs
    { yaml: yamlText },
    { file: "cases/TC-FORM-001.yaml" },
  ],
});
result.report.summary; // verified, not verified, by verdict
result.text;           // the same report as text
result.exitCode;       // 0 all PASS, 1 any FAIL, 2 anything else not verified, 3 nothing ran
```

- Pass `negativeControl: true` to run each case with one expected result made wrong. The bot must report FAIL. Do this before trusting a clean report.
- Pass your own `modelFor` (a `ModelClient`) and `provider` (a `ProviderStatus`) to bring your own model. It is still only an actor: it reports observations, and the runner's evidence decides. Your model is not checked against the provider rules (the register entry, https): they apply to the provider in the configuration, and your own client is yours to review. A client that has an `abort()` method is told when the runner stops waiting for it.
- `providerSecrets` is where the model server's API key is read from, apart from `secrets` (the cases' secrets).
- A case that does not validate is reported as not executed, and the rest of the batch runs.
- `bot.listCases()` lists the cases in the cases folder.

## 2. As an MCP server (VS Code, LM Studio, Claude Code)

`node mcp/server.ts --live --model <id>` speaks the Model Context Protocol over stdio. It starts the local fixture site unless you pass `--target <url>` for one that is already running. `--scripted` uses the fake model, for trying the connection without a model server. Exactly one of `--live` and `--scripted` is required.

| Tool | What it does |
| --- | --- |
| `qa_list_cases` | Lists the cases (id, title, priority, role). |
| `qa_run_case` | Runs one case by its id, optionally as its negative control. Waits up to `wait_seconds` (default 45), then gives a `job_id`. One run at a time. |
| `qa_run_status` | Waits for a run started earlier and returns its report. |
| `qa_get_report` | Reads a stored report by its id. |
| `qa_status` | Says which model is used, whether it is on this machine, and whether the kill switch is engaged. |

Every result starts with a notice that the text is data, because it contains page content and model output that a page can influence. A result that carries a report has a JSON header built by the bot's code from the structured report (the verdict of each case, the exit code and what it means), followed by the report text inside a block whose marker has random characters and is new for each answer. A page can write a line in the report text that looks like a verdict or an instruction; only the JSON header is the bot's word. Keep the host's per-tool approval on for `qa_run_case`.

The server takes the model server's API key (if there is one) from `QA_SECRET_<NAME>` in its own environment, where `<NAME>` is `provider.apiKeySecret`. The cases' secrets are the fixture's fake ones.

**VS Code** (agent mode): add the server to the workspace's `.vscode/mcp.json`, or run **MCP: Add Server**. The shape, which you should check against your VS Code version:

```json
{
  "servers": {
    "qa-bot": {
      "type": "stdio",
      "command": "node",
      "args": ["<full path to the bot's folder>/mcp/server.ts", "--live", "--model", "qwen2.5-coder-14b"],
      "env": { "QA_PROVIDER_URL": "http://127.0.0.1:1234/v1" }
    }
  }
}
```

**LM Studio** (check the menu names against your version): open the Program tab, choose Install, then Edit `mcp.json`, and add:

```json
{
  "mcpServers": {
    "qa-bot": {
      "command": "node",
      "args": ["<full path to the bot's folder>/mcp/server.ts", "--live", "--model", "qwen2.5-coder-14b"],
      "env": { "QA_PROVIDER_URL": "http://127.0.0.1:1234/v1" }
    }
  }
}
```

Use a chat model in LM Studio that supports tool use to call the tools. Two models in one LM Studio (the chat model that calls the tools and the bot's own model) need memory for both on a machine with 32 GB. If that is too much, use the same model for both, or run the bot's model in Ollama and set `QA_PROVIDER_URL` to its address.

**Claude Code**: `claude mcp add qa-bot -- node mcp/server.ts --live --model <id>`.

The server changes to the bot's own folder on start, so the host's working directory does not matter. Check the connection without a host:

```text
node mcp/server.ts --scripted
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

## 3. As a command

`node src/cli.ts run cases/TC-FORM-001.yaml --live --model <id>`. Exit codes are in the header of `src/cli.ts`.

## Not yet done

- The MCP server has no tool for the release evidence report, and none for the kill switch's engage (a person does that on the command line, so that a name is on the audit log).
- Only the fixture site is accepted as a target, in all three ways, until the security review of a real target is done.
- The eval suites (golden set, mutants, injection) still run on the scripted model. Running them against a live model is the next step before any pilot gate can be claimed.
