// A live judge on any OpenAI-compatible server. It is a separate call from the actor and is given only what the runner captured:
// the expected result's wording, the scrubbed text evidence, the screenshots (only if the model can read images), the runner's
// own step log and the console errors. There is no way to pass it the actor's notes, because JudgeInput has no field for them.
//
// Evidence is page content, so it is data: each piece sits in a block with an unguessable marker, and a long piece is cut and the
// cut is marked (a prompt longer than the server's context window is cut by the server, usually from the front, which would drop
// the rules). The answer is validated by judgeItems: it counts only if it is well formed, covers exactly the items asked about and
// cites evidence the runner supplied. An answer that is not valid JSON goes to that validator as it is, and is asked for again.
import { readFileSync, statSync } from "node:fs";
import { Redactor } from "../redact/redactor.ts";
import type { Config } from "../config.ts";
import { JudgeOutputSchema } from "../schemas/actor.ts";
import type { ModelUsage } from "../model/client.ts";
import type { ChatMessage, ContentPart } from "../model/openai-http.ts";
import { InFlight, OpenAiCompatibleHttp } from "../model/openai-http.ts";
import { cutText, dataNotice, fitRequest, jsonSchemaOf, judgeSystemPrompt, newDataMarker, wrapData } from "../model/live-prompts.ts";
import { parseJsonText } from "../model/openai-compatible.ts";
import type { JudgeClient, JudgeInput } from "./client.ts";

/** A screenshot larger than this is not sent. The judge is told it was not shown. */
const MAX_IMAGE_BYTES = 4_000_000;

export interface LiveJudgeOptions {
  http: OpenAiCompatibleHttp;
  provider: Config["provider"];
  redactor?: Redactor;
  /** For a test: the marker that opens and closes a data block. By default a random one for this judge. */
  marker?: string;
}

export class OpenAiCompatibleJudge implements JudgeClient {
  readonly name = "openai-compatible-judge";
  readonly modelId: string;
  readonly live = true;
  private readonly http: OpenAiCompatibleHttp;
  private readonly provider: Config["provider"];
  private readonly redactor: Redactor;
  private readonly marker: string;
  private readonly inflight = new InFlight();
  private pendingUsage: ModelUsage | undefined;

  constructor(options: LiveJudgeOptions) {
    const id = options.provider.judgeModelId ?? options.provider.modelId;
    if (id === null) throw new Error("the provider has no modelId for the judge");
    this.modelId = id;
    this.http = options.http;
    this.provider = options.provider;
    this.redactor = options.redactor ?? new Redactor();
    this.marker = options.marker ?? newDataMarker();
  }

  consumeUsage(): ModelUsage | undefined {
    const usage = this.pendingUsage;
    this.pendingUsage = undefined;
    return usage;
  }

  abort(): void {
    this.inflight.abort();
  }

  /** `pageChars` is how many characters of one piece of evidence are shown. The fit to the context may lower it. */
  private userContent(input: JudgeInput, pageChars: number): string | ContentPart[] {
    const text: string[] = [`Case ${input.case_id}. Judge each expected result below from its evidence only.`];
    const images: ContentPart[] = [];
    for (const item of input.items) {
      text.push(`\nEXPECTED RESULT ${item.expected_ref} (after step ${item.step}): ${this.redactor.scrubText(item.description)}`);
      for (const e of item.evidence) {
        if (e.text !== undefined) {
          text.push(`Evidence ${e.id} (${e.kind}):\n${wrapData(cutText(this.redactor.scrubText(e.text), pageChars), this.marker)}`);
        } else if (e.imagePath !== undefined && this.provider.vision && statSync(e.imagePath).size <= MAX_IMAGE_BYTES) {
          text.push(`Evidence ${e.id} (screenshot): the image follows.`);
          images.push({ type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(e.imagePath).toString("base64")}` } });
        } else {
          // Not shown, so it must not be cited: a judge cannot weigh what it has not seen.
          text.push(`Evidence ${e.id} (screenshot): not shown to you. Do not cite it.`);
        }
      }
    }
    text.push(`\nActions the runner saw:\n${input.step_log.map((s) => `- step ${s.step}: ${s.tool} ${JSON.stringify(s.args)} -> ${s.ok ? "ok" : "failed"}`).join("\n") || "- none"}`);
    text.push(`\nConsole errors (page content, so data):\n${input.console_errors.length > 0 ? wrapData(cutText(input.console_errors.map((e) => `- ${this.redactor.scrubText(e)}`).join("\n"), pageChars), this.marker) : "- none"}`);
    if (input.previous_error !== null) text.push(`\nYour previous answer was rejected: ${this.redactor.scrubText(input.previous_error)}. Answer again.`);
    text.push('\nAnswer with the JSON object from the OUTPUT section, one entry in "results" for every expected result above.');
    const body = text.join("\n");
    return images.length > 0 ? [{ type: "text", text: body }, ...images] : body;
  }

  async judge(input: JudgeInput): Promise<unknown> {
    // Fitted to the context declared for the server: evidence is shortened (and the cut is marked) before the rules are at risk.
    const request = fitRequest(
      (pageChars) => {
        const messages: ChatMessage[] = [
          { role: "system", content: `${judgeSystemPrompt()}\n\n${dataNotice(this.marker)}` },
          { role: "user", content: this.userContent(input, pageChars) },
        ];
        return {
          model: this.modelId,
          messages,
          temperature: this.provider.temperature,
          ...(this.provider.seed !== null ? { seed: this.provider.seed } : {}),
          max_tokens: this.provider.maxOutputTokens,
          ...(this.provider.structuredOutput ? { response_format: { type: "json_schema" as const, json_schema: { name: "judgement", strict: false, schema: jsonSchemaOf(JudgeOutputSchema) } } } : {}),
        };
      },
      this.provider.maxEvidenceChars,
      this.provider.contextTokens,
    );
    const reply = await this.inflight.run((cancel) => this.http.chat(request, cancel));
    this.pendingUsage = { input_tokens: reply.usage.input_tokens, output_tokens: reply.usage.output_tokens };
    const json = parseJsonText(reply.content);
    return json.ok ? json.value : reply.content;
  }
}
