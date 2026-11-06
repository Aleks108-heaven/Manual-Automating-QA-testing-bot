// The pre-flight view of a live provider (manual: Running tests, pre-flight). It is reachable if the server lists its models,
// and the models the run will use must be among them. A local server has no spend allowance, so it reports none and the quota
// check is skipped, and a skipped check is reported as skipped (it also means the report cannot be used to resume the kill switch).
import type { Config } from "../config.ts";
import { OpenAiCompatibleHttp } from "../model/openai-http.ts";
import type { ProviderStatus } from "./provider.ts";

export class OpenAiCompatibleProviderStatus implements ProviderStatus {
  readonly name: string;
  private readonly http: OpenAiCompatibleHttp;
  private readonly needed: string[];

  constructor(http: OpenAiCompatibleHttp, provider: Config["provider"]) {
    this.http = http;
    this.name = `openai-compatible provider at ${http.origin}`;
    this.needed = [...new Set([provider.modelId, provider.judgeModelId].filter((m): m is string => m !== null))];
  }

  async ping(): Promise<void> {
    const listed = await this.http.listModels();
    const missing = this.needed.filter((m) => !listed.includes(m));
    if (missing.length > 0) {
      throw new Error(`${missing.join(", ")} is not in the provider's model list (${listed.length} model(s) listed; see: node src/cli.ts provider models)`);
    }
  }

  async remainingQuotaUsd(): Promise<number | null> {
    return null;
  }
}
