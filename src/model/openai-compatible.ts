// A live model client for any server that speaks the OpenAI-compatible chat API (LM Studio, Ollama, llama.cpp, vLLM).
//
// It does what the scripted client does, with a real model behind it: it is shown the case and the step, answers with one action,
// and writes the final report. It decides nothing about a verdict. A secret in the case data shows only its key, tool results were
// scrubbed by the tool layer before they got here, and everything from the page is inside a block with an unguessable marker.
//
// An answer that is not a valid action is sent back with the reason (up to modelOutput.maxAttempts times) and never repaired:
// no field is filled in, no value is corrected, nothing around the JSON is cut away (a code fence or a sentence before it makes
// the answer invalid). When the attempts are used up the client throws, and the runner records a crash. The one thing it does
// accept is the transport's empty argument string for a tool without arguments, which means {}.
import { z } from "zod";
import { ACTOR_STOP_REASONS } from "../schemas/common.ts";
import { ActorOutputSchema } from "../schemas/actor.ts";
import { Redactor } from "../redact/redactor.ts";
import type { Config } from "../config.ts";
import { TOOL_SCHEMAS } from "../tools/schemas.ts";
import type { FinalContext, ModelAction, ModelClient, ModelContext, ModelUsage, PriorAction } from "./client.ts";
import { InFlight, OpenAiCompatibleHttp, ProviderError, type ChatMessage, type ChatRequest, type ChatResult } from "./openai-http.ts";
import { ACTION_JSON_SCHEMA, actorSystemPrompt, caseBrief, dataNotice, fitRequest, historyLine, jsonSchemaOf, loadPrompt, newDataMarker, renderResult, wrapData } from "./live-prompts.ts";

export class ModelFormatError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "ModelFormatError";
  }
}

const ActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("tool_call"), tool: z.string().min(1), args: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal("step_done") }),
  z.strictObject({ type: z.literal("stop"), reason: z.enum(ACTOR_STOP_REASONS), note: z.string().optional() }),
]);
type ParsedAction = { type: "tool_call"; tool: string; args: unknown } | { type: "step_done" } | { type: "stop"; reason: (typeof ACTOR_STOP_REASONS)[number]; note?: string };

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

/** Parses the model's text as one JSON value, exactly as it is. A code fence or any text around the JSON makes it invalid. */
export function parseJsonText(content: string): Parsed<unknown> {
  const text = content.trim();
  if (text === "") return { ok: false, problem: "the answer was empty" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, problem: "the answer was not a single JSON object (no code fence and no other text around it)" };
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(action)"}: ${i.message}`).join("; ");
}

interface StepMemory {
  text: string;
  actions: PriorAction[];
}

export interface LiveModelOptions {
  http: OpenAiCompatibleHttp;
  provider: Config["provider"];
  /** How many times an invalid answer is sent back (config modelOutput.maxAttempts). */
  maxAttempts: number;
  /**
   * Applied to the case text and the history the model is shown. The default knows no secrets: the secrets of a run are scrubbed from
   * tool results by the tool layer before they reach this client, and a secret in the case data is shown only as its key.
   */
  redactor?: Redactor;
  /** For a test: the marker that opens and closes a data block. By default a random one for this client. */
  marker?: string;
}

export class OpenAiCompatibleModelClient implements ModelClient {
  readonly name = "openai-compatible";
  readonly modelId: string;
  readonly live = true;
  private readonly http: OpenAiCompatibleHttp;
  private readonly provider: Config["provider"];
  private readonly maxAttempts: number;
  private readonly redactor: Redactor;
  private readonly steps = new Map<number, StepMemory>();
  private lastSnapshot: PriorAction | null = null;
  private pendingUsage: ModelUsage | undefined;
  private readonly marker: string;
  private readonly inflight = new InFlight();

  constructor(options: LiveModelOptions) {
    if (options.provider.modelId === null) throw new Error("the provider has no modelId");
    this.modelId = options.provider.modelId;
    this.http = options.http;
    this.provider = options.provider;
    this.maxAttempts = options.maxAttempts;
    this.redactor = options.redactor ?? new Redactor();
    this.marker = options.marker ?? newDataMarker();
  }

  /** The runner has stopped waiting: cancel the request in progress, and any retry of it. */
  abort(): void {
    this.inflight.abort();
  }

  consumeUsage(): ModelUsage | undefined {
    const usage = this.pendingUsage;
    this.pendingUsage = undefined;
    return usage;
  }

  private remember(context: ModelContext): void {
    // A first call of a first step starts a new run, so a client used twice does not carry the first run's history over.
    if (context.stepIndex === 1 && context.actionsInStep.length === 0) {
      this.steps.clear();
      this.lastSnapshot = null;
    }
    this.steps.set(context.stepIndex, { text: context.stepText, actions: [...context.actionsInStep] });
    for (const a of context.actionsInStep) if (a.tool === "snapshot" && a.result.ok) this.lastSnapshot = a;
  }

  private earlierSteps(before: number): string {
    const lines: string[] = [];
    for (const [index, step] of [...this.steps.entries()].sort((a, b) => a[0] - b[0])) {
      if (index >= before) continue;
      lines.push(`Step ${index} (done): ${step.text}`, ...step.actions.map((a) => historyLine(a, this.redactor)));
    }
    return lines.length > 0 ? `What has happened so far:\n${lines.join("\n")}\n\n` : "";
  }

  private request(messages: ChatMessage[], extra: Partial<ChatRequest>): ChatRequest {
    return {
      model: this.modelId,
      messages,
      temperature: this.provider.temperature,
      ...(this.provider.seed !== null ? { seed: this.provider.seed } : {}),
      max_tokens: this.provider.maxOutputTokens,
      ...extra,
    };
  }

  private actionTools(): NonNullable<ChatRequest["tools"]> {
    const tools: NonNullable<ChatRequest["tools"]> = Object.entries(TOOL_SCHEMAS).map(([name, schema]) => ({
      type: "function" as const,
      function: { name, description: `Browser tool ${name}.`, parameters: jsonSchemaOf(schema) },
    }));
    tools.push({ type: "function", function: { name: "step_done", description: "The work of the current step is done.", parameters: { type: "object", properties: {}, additionalProperties: false } } });
    tools.push({
      type: "function",
      function: {
        name: "stop",
        description: "Stop the run because the step cannot be done.",
        parameters: { type: "object", properties: { reason: { type: "string", enum: [...ACTOR_STOP_REASONS] }, note: { type: "string" } }, required: ["reason"], additionalProperties: false },
      },
    });
    return tools;
  }

  /** `max` is how many characters of one tool result (a page snapshot) are shown. The fit to the context may lower it. */
  private messagesFor(context: ModelContext, max: number): ChatMessage[] {
    const intro: ChatMessage[] = [
      { role: "system", content: `${actorSystemPrompt()}\n\n${dataNotice(this.marker)}` },
      {
        role: "user",
        content: `${caseBrief(context.testCase, this.redactor)}\n\n${this.earlierSteps(context.stepIndex)}NOW: step ${context.stepIndex} of ${context.testCase.steps.length}: ${this.redactor.scrubText(context.stepText)}\nChoose your first action for this step.`,
      },
    ];
    const history: ChatMessage[] = [];
    context.actionsInStep.forEach((a, i) => {
      const result = `${wrapData(renderResult(a, max, this.redactor), this.marker)}\nChoose your next action.`;
      if (this.provider.actionMode === "tools") {
        const id = `call_${i + 1}`;
        history.push({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: a.tool, arguments: JSON.stringify(a.args ?? {}) } }] });
        history.push({ role: "tool", tool_call_id: id, content: result });
      } else {
        history.push({ role: "assistant", content: JSON.stringify({ type: "tool_call", tool: a.tool, args: a.args ?? {} }) });
        history.push({ role: "user", content: `Result of ${a.tool}:\n${result}` });
      }
    });
    return [...intro, ...history];
  }

  private parseToolsReply(reply: ChatResult): Parsed<ParsedAction> {
    const call = reply.toolCalls[0];
    if (!call) return { ok: false, problem: "the answer had no tool call; answer by calling exactly one tool" };
    // More than one call in one turn: the first is used, and the model sees the result before it chooses again.
    let args: unknown;
    try {
      args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
    } catch {
      return { ok: false, problem: `the arguments of ${call.name} were not JSON` };
    }
    if (args === null || typeof args !== "object" || Array.isArray(args)) return { ok: false, problem: `the arguments of ${call.name} must be an object` };
    const candidate = call.name === "step_done" ? { type: "step_done" } : call.name === "stop" ? { type: "stop", ...(args as object) } : { type: "tool_call", tool: call.name, args };
    return this.validate(candidate);
  }

  private parseJsonReply(reply: ChatResult): Parsed<ParsedAction> {
    const json = parseJsonText(reply.content);
    return json.ok ? this.validate(json.value) : json;
  }

  private validate(candidate: unknown): Parsed<ParsedAction> {
    const parsed = ActionSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, problem: describeIssues(parsed.error) };
    const v = parsed.data;
    if (v.type === "tool_call") return { ok: true, value: { type: "tool_call", tool: v.tool, args: v.args } };
    if (v.type === "step_done") return { ok: true, value: { type: "step_done" } };
    return { ok: true, value: { type: "stop", reason: v.reason, ...(v.note !== undefined ? { note: v.note } : {}) } };
  }

  async nextAction(context: ModelContext): Promise<ModelAction> {
    this.remember(context);
    // What this call has said back to the model after an invalid answer. It is kept apart from the case and the page, so that the
    // page text can be shortened to fit the context while the corrections stay.
    const corrections: ChatMessage[] = [];
    const tools = this.provider.actionMode === "tools";
    const extra: Partial<ChatRequest> = tools
      ? { tools: this.actionTools(), tool_choice: "required" }
      : this.provider.structuredOutput
        ? { response_format: { type: "json_schema", json_schema: { name: "action", strict: false, schema: ACTION_JSON_SCHEMA } } }
        : {};
    // One cancel signal covers every attempt of this call, so an abort between two attempts stops the next one too.
    return this.inflight.run(async (cancel) => {
      let input = 0;
      let output = 0;
      let problem = "";
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        // The prompt is fitted to the context declared for the server. Page text is shortened (and the cut is marked) before the rules are at risk.
        const request = fitRequest((pageChars) => this.request([...this.messagesFor(context, pageChars), ...corrections], extra), this.provider.maxToolResultChars, this.provider.contextTokens);
        const reply = await this.http.chat(request, cancel);
        input += reply.usage.input_tokens;
        output += reply.usage.output_tokens;
        const parsed = tools ? this.parseToolsReply(reply) : this.parseJsonReply(reply);
        if (parsed.ok) return { ...parsed.value, usage: { input_tokens: input, output_tokens: output } } as ModelAction;
        problem = this.redactor.scrubText(parsed.problem);
        const said = reply.content !== "" ? reply.content : reply.toolCalls.map((c) => `${c.name}(${c.arguments})`).join(" ");
        corrections.push({ role: "assistant", content: this.redactor.scrubText(said === "" ? "(no answer)" : said.slice(0, 2000)) });
        corrections.push({ role: "user", content: `That was not a valid action: ${problem}. Answer again with exactly one action.` });
      }
      throw new ModelFormatError(`the model did not give a valid action after ${this.maxAttempts} attempts (${problem})`);
    });
  }

  async finalOutput(context: FinalContext): Promise<unknown> {
    const { testCase, actorStop } = context;
    const lines: string[] = [];
    for (const [index, step] of [...this.steps.entries()].sort((a, b) => a[0] - b[0])) lines.push(`Step ${index}: ${step.text}`, ...step.actions.map((a) => historyLine(a, this.redactor)));
    const snapshotAt = (pageChars: number) => (this.lastSnapshot ? `\n\nThe last page snapshot you took:\n${wrapData(renderResult(this.lastSnapshot, pageChars, this.redactor), this.marker)}` : "");
    const ending = actorStop
      ? `The run was stopped at step ${actorStop.step} with stop_reason "${actorStop.reason}". Set completed to false, stop_reason to "${actorStop.reason}" and stopped_at_step to ${actorStop.step}.`
      : "Every step was carried out. Set completed to true, stop_reason to null and stopped_at_step to null.";
    const retry = context.previousError !== null ? `\n\nYour previous report was rejected: ${this.redactor.scrubText(context.previousError)}. Write the whole report again.` : "";
    const extra: Partial<ChatRequest> = this.provider.structuredOutput ? { response_format: { type: "json_schema", json_schema: { name: "final_report", strict: false, schema: jsonSchemaOf(ActorOutputSchema) } } } : {};
    const request = fitRequest(
      (pageChars) =>
        this.request(
          [
            { role: "system", content: `${loadPrompt("actor.v1.md")}\n\n${dataNotice(this.marker)}` },
            {
              role: "user",
              content: `${caseBrief(testCase, this.redactor)}\n\nWhat happened:\n${lines.join("\n")}${snapshotAt(pageChars)}\n\nNow write your final report as one JSON object in the OUTPUT format. test_id is "${testCase.id}". ${ending} For each item under "Observe", add an observation with its expected_ref, what you observed (or null if you could not observe it), and the screenshot ids or element names that show it. Report observations only, never a verdict.${retry}`,
            },
          ],
          extra,
        ),
      this.provider.maxToolResultChars,
      this.provider.contextTokens,
    );
    const reply = await this.inflight.run((cancel) => this.http.chat(request, cancel));
    this.pendingUsage = { input_tokens: reply.usage.input_tokens, output_tokens: reply.usage.output_tokens };
    // A reply that is not JSON goes to the validator as it is, which rejects it with the reason and asks again.
    const json = parseJsonText(reply.content);
    return json.ok ? json.value : reply.content;
  }
}
