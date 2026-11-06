// A live proposer: when a frozen script's step cannot run, a model is asked to propose replacement actions for that one step.
// It runs under the same rules as every other model call (the kill switch, the time and cost budget, validation without repair),
// and its answer never reaches a verdict. A person reads the proposal and approves it or not.
import { Redactor } from "../redact/redactor.ts";
import type { Config } from "../config.ts";
import type { ModelUsage } from "../model/client.ts";
import { InFlight, OpenAiCompatibleHttp, type ChatMessage } from "../model/openai-http.ts";
import { cutText, dataNotice, fitRequest, jsonSchemaOf, newDataMarker, proposerSystemPrompt, wrapData } from "../model/live-prompts.ts";
import { parseJsonText } from "../model/openai-compatible.ts";
import type { ProposalRequest, Proposer } from "./propose.ts";
import { ProposalBodySchema } from "./schema.ts";

export class OpenAiCompatibleProposer implements Proposer {
  readonly name = "openai-compatible-proposer";
  readonly modelId: string;
  readonly live = true;
  private readonly http: OpenAiCompatibleHttp;
  private readonly provider: Config["provider"];
  private readonly redactor: Redactor;
  private readonly marker: string;
  private readonly inflight = new InFlight();
  private pendingUsage: ModelUsage | undefined;

  constructor(options: { http: OpenAiCompatibleHttp; provider: Config["provider"]; redactor?: Redactor; marker?: string }) {
    if (options.provider.modelId === null) throw new Error("the provider has no modelId");
    this.modelId = options.provider.modelId;
    this.http = options.http;
    this.provider = options.provider;
    this.redactor = options.redactor ?? new Redactor();
    this.marker = options.marker ?? newDataMarker();
  }

  abort(): void {
    this.inflight.abort();
  }

  consumeUsage(): ModelUsage | undefined {
    const usage = this.pendingUsage;
    this.pendingUsage = undefined;
    return usage;
  }

  async propose(request: ProposalRequest): Promise<unknown> {
    const scrub = (t: string) => this.redactor.scrubText(t);
    const script = request.script.steps.find((s) => s.index === request.step)?.actions ?? [];
    // Fitted to the context declared for the server: the page is shortened (and the cut is marked) before the rules are at risk.
    const built = fitRequest(
      (pageChars) => {
        const user = [
          `Case ${request.testCase.id}: ${scrub(request.testCase.title)}`,
          `Step ${request.step} could not run: ${scrub(request.stepText)}`,
          `The recorded actions for this step:\n${script.map((a) => `- ${a.tool} ${JSON.stringify(a.args)}`).join("\n") || "- none"}`,
          `The action that failed: ${request.failed.tool} ${JSON.stringify(request.failed.args)}`,
          `The error (from the tool layer, so it can quote the page):\n${wrapData(cutText(scrub(request.failed.error), pageChars), this.marker)}`,
          `The page when the step stopped:\n${request.snapshot === null ? "(no snapshot)" : wrapData(cutText(scrub(request.snapshot), pageChars), this.marker)}`,
          `Write the proposal as the JSON object in the OUTPUT section. "step" must be ${request.step}.`,
          ...(request.previousError !== null ? [`Your previous answer was rejected: ${scrub(request.previousError)}. Answer again.`] : []),
        ].join("\n\n");
        const messages: ChatMessage[] = [
          { role: "system", content: `${proposerSystemPrompt()}\n\n${dataNotice(this.marker)}` },
          { role: "user", content: user },
        ];
        return {
          model: this.modelId,
          messages,
          temperature: this.provider.temperature,
          ...(this.provider.seed !== null ? { seed: this.provider.seed } : {}),
          max_tokens: this.provider.maxOutputTokens,
          ...(this.provider.structuredOutput ? { response_format: { type: "json_schema" as const, json_schema: { name: "proposal", strict: false, schema: jsonSchemaOf(ProposalBodySchema) } } } : {}),
        };
      },
      this.provider.maxEvidenceChars,
      this.provider.contextTokens,
    );
    const reply = await this.inflight.run((cancel) => this.http.chat(built, cancel));
    this.pendingUsage = { input_tokens: reply.usage.input_tokens, output_tokens: reply.usage.output_tokens };
    const json = parseJsonText(reply.content);
    return json.ok ? json.value : reply.content;
  }
}
