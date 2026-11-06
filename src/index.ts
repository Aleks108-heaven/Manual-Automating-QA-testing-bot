// The public surface of the bot as a library. Import from here, not from the inner files.
//
// Node runs TypeScript directly, but not from inside node_modules, so use the bot from a path or a linked folder
// (for example `npm install ../Manual-Automating-QA-testing-bot`, which links it), or run it as a process (the CLI or the MCP server).
export { QaBot, exitCodeFor, type CaseListing, type CaseSource, type QaBotOptions, type RunOutcome, type RunRequest } from "./api.ts";
export { runBatch, type BatchEntry, type BatchOptions, type BatchResult } from "./batch.ts";
export { CaseValidationError, loadCase, parseCase, validateCase } from "./cases/load.ts";
export { negativeControl } from "./cases/mutate.ts";
export { loadConfig, loadConfigWith, type Config } from "./config.ts";
export type { ModelClient, ModelAction, ModelContext, FinalContext, PriorAction, ModelUsage } from "./model/client.ts";
export type { JudgeClient, JudgeInput, JudgeItem } from "./judge/client.ts";
export type { ProviderStatus } from "./preflight/provider.ts";
export { ScriptedModelClient } from "./model/scripted.ts";
export { createLiveProvider, createProviderHttp, type LiveProvider } from "./provider.ts";
export { KillSwitch, RunnerPausedError } from "./ops/kill-switch.ts";
export { formatReport } from "./report/format.ts";
export type { Report } from "./report/schema.ts";
export { EnvSecretStore, StaticSecretStore, type SecretStore } from "./secrets/store.ts";
export { assertFixtureTarget, assertTarget, externalCaseProblems, TargetError, type ResolvedTarget, type TargetKind } from "./target.ts";
export type { TestCase } from "./schemas/case.ts";
