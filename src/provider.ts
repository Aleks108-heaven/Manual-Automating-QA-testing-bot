// Builds the live model, judge, proposer and pre-flight provider check from config.provider. The API key, if the server needs one,
// is read from the secret store by name; it is not in the configuration file and not in any report.
import { isLoopbackUrl, type Config } from "./config.ts";
import { OpenAiCompatibleProposer } from "./frozen/openai-proposer.ts";
import { OpenAiCompatibleJudge } from "./judge/openai-compatible.ts";
import type { JudgeClient } from "./judge/client.ts";
import type { ModelClient } from "./model/client.ts";
import { OpenAiCompatibleHttp } from "./model/openai-http.ts";
import { OpenAiCompatibleModelClient } from "./model/openai-compatible.ts";
import { OpenAiCompatibleProviderStatus } from "./preflight/provider-http.ts";
import type { ProviderStatus } from "./preflight/provider.ts";
import type { Proposer } from "./frozen/propose.ts";
import { EnvSecretStore, type SecretStore } from "./secrets/store.ts";

export interface LiveProvider {
  readonly http: OpenAiCompatibleHttp;
  /** For the pre-flight check. */
  readonly status: ProviderStatus;
  /** A new model client. Each case gets its own, because a client remembers the steps of the run it is in. */
  newModel(): ModelClient;
  newJudge(): JudgeClient;
  newProposer(): Proposer;
  /** The names the server lists. This is the menu the model is chosen from. */
  models(): Promise<string[]>;
}

/** The HTTP client for config.provider, without needing a model to be chosen yet (listing the models is how one is chosen). */
export async function createProviderHttp(config: Config, options: { secrets?: SecretStore; fetchImpl?: typeof fetch } = {}): Promise<OpenAiCompatibleHttp> {
  const p = config.provider;
  // The configuration checks this for a live provider. Listing the models runs with the kind left as scripted, and it sends the API key,
  // so the same rule is applied here: a server off this machine needs a register entry and https.
  if (!isLoopbackUrl(p.baseUrl) && (p.registerEntry === null || new URL(p.baseUrl).protocol !== "https:")) {
    throw new Error("the provider is off this machine, so provider.registerEntry must be set and the address must be https (nothing was sent)");
  }
  const apiKey = p.apiKeySecret !== null ? await (options.secrets ?? new EnvSecretStore()).get(p.apiKeySecret) : null;
  return new OpenAiCompatibleHttp({
    baseUrl: p.baseUrl,
    apiKey,
    timeoutMs: p.requestTimeoutMs,
    maxResponseBytes: p.maxResponseBytes,
    contextTokens: p.contextTokens,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

export async function createLiveProvider(config: Config, options: { secrets?: SecretStore; fetchImpl?: typeof fetch } = {}): Promise<LiveProvider> {
  const p = config.provider;
  if (p.kind !== "openai-compatible") throw new Error(`provider.kind is "${p.kind}", not a live provider. Set QA_PROVIDER=openai-compatible or provider.kind in the configuration.`);
  const http = await createProviderHttp(config, options);
  return {
    http,
    status: new OpenAiCompatibleProviderStatus(http, p),
    newModel: () => new OpenAiCompatibleModelClient({ http, provider: p, maxAttempts: config.modelOutput.maxAttempts }),
    newJudge: () => new OpenAiCompatibleJudge({ http, provider: p }),
    newProposer: () => new OpenAiCompatibleProposer({ http, provider: p }),
    models: () => http.listModels(),
  };
}
