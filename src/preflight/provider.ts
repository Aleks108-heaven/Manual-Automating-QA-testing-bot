// What the pre-flight check needs to know about the model provider. A live provider implements this once one is
// chosen (build brief: LLM provider and model). Until then there is a scripted version, so the checks that depend
// on it can be tested, including their failures.
export interface ProviderStatus {
  readonly name: string;
  /** Resolves if the provider can be reached with the bot's key. Rejects otherwise. */
  ping(): Promise<void>;
  /** Remaining spend allowance in US dollars, or null if the provider does not say. */
  remainingQuotaUsd(): Promise<number | null>;
}

export class ScriptedProviderStatus implements ProviderStatus {
  readonly name = "scripted-provider";
  private readonly state: { reachable: boolean; quotaUsd: number | null };

  constructor(state: Partial<{ reachable: boolean; quotaUsd: number | null }> = {}) {
    this.state = { reachable: true, quotaUsd: 100, ...state };
  }

  async ping(): Promise<void> {
    if (!this.state.reachable) throw new Error("the provider did not answer");
  }

  async remainingQuotaUsd(): Promise<number | null> {
    return this.state.quotaUsd;
  }
}
