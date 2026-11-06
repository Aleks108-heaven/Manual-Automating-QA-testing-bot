// The only code that talks to a model server over HTTP. It speaks the OpenAI-compatible chat API that LM Studio, Ollama,
// llama.cpp and vLLM all serve (POST {baseUrl}/chat/completions, GET {baseUrl}/models).
//
// Rules kept here, so that no caller can forget them:
//  - the response is read with a size cap, and its shape is checked before anything uses it;
//  - an error message never holds the API key: the text a server sent is scrubbed first and only then shortened, the text of a
//    network error is never quoted (only its code), and a key with white space or control characters is refused at the start;
//    what is quoted from a server is cut short and cleaned of terminal control characters (a server's text is data, like page content);
//  - a request has a time limit, and a caller can cancel it, so a model call that the runner has given up on (the kill switch, the
//    time budget) does not go on sending prompts;
//  - an answer that was cut off by the token limit is an error, not a short answer.
import { z } from "zod";
import { Redactor } from "../redact/redactor.ts";
import { cleanForTerminal } from "../report/sanitize.ts";
import { nodeFetch } from "./node-fetch.ts";

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The request was cancelled by the caller. Nothing is wrong with the provider. */
export class ProviderCancelled extends ProviderError {
  constructor() {
    super("the request to the provider was cancelled");
    this.name = "ProviderCancelled";
  }
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
  tool_choice?: "auto" | "required";
  response_format?: { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: unknown } };
  temperature: number;
  seed?: number;
  max_tokens: number;
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  /** True when the server did not report token counts and these are a rough guess from the text length. */
  estimated: boolean;
}

export interface ChatResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: ChatUsage;
  finishReason: string | null;
}

const ToolCallSchema = z.object({
  id: z.string().nullish(),
  function: z.object({ name: z.string(), arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish() }),
});

const ResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish(), tool_calls: z.array(ToolCallSchema).nullish() }), finish_reason: z.string().nullish() })).min(1),
  usage: z.object({ prompt_tokens: z.number().nullish(), completion_tokens: z.number().nullish() }).nullish(),
});

const ModelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

export interface HttpOptions {
  baseUrl: string;
  apiKey?: string | null;
  timeoutMs: number;
  maxResponseBytes: number;
  /** The context length set on the server. A request whose prompt and answer cannot fit in it is refused here, not cut by the server. */
  contextTokens?: number;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

/** The prompt does not fit the context window that was declared for the server, so it was not sent. Sending it would have cut it silently. */
export class ContextTooSmall extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "ContextTooSmall";
  }
}

/** About 3 characters to a token: a rough figure that errs high for ordinary text. It is used to fit a prompt to the context, and as the usage when the server reports none. The tools and the schema count too. */
export function estimateTokens(request: ChatRequest): number {
  let n = JSON.stringify(request.tools ?? []).length + JSON.stringify(request.response_format ?? {}).length;
  for (const m of request.messages) {
    if (typeof m.content === "string") n += m.content.length;
    else if (Array.isArray(m.content)) for (const p of m.content) n += p.type === "text" ? (p.text?.length ?? 0) : 1000;
    for (const c of m.tool_calls ?? []) n += c.function.name.length + c.function.arguments.length;
  }
  return Math.ceil(n / 3);
}

/** Keeps the cancel signals of the calls in progress, so that abort() can cancel them all. One signal covers every attempt of one call. */
export class InFlight {
  private readonly controllers = new Set<AbortController>();

  async run<T>(work: (cancel: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await work(controller.signal);
    } finally {
      this.controllers.delete(controller);
    }
  }

  abort(): void {
    for (const controller of this.controllers) controller.abort();
  }
}

export class OpenAiCompatibleHttp {
  private readonly base: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly scrub: Redactor;
  private readonly contextTokens: number | null;

  constructor(options: HttpOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.contextTokens = options.contextTokens ?? null;
    // A key copied from a file or a terminal often ends with a line break. Trimming it is not a guess about its content, and a
    // key that still holds white space or a control character is refused: such a key makes the HTTP library quote it in an error.
    const key = options.apiKey ? options.apiKey.trim() : "";
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
    if (key !== "" && /[\s\x00-\x1f\x7f-\x9f]/.test(key)) throw new Error("the provider API key contains white space or a control character");
    this.apiKey = key === "" ? null : key;
    this.timeoutMs = options.timeoutMs;
    this.maxBytes = options.maxResponseBytes;
    // Not the built-in fetch: it ends a response whose headers take more than five minutes, which a slow local model needs.
    this.fetchImpl = options.fetchImpl ?? nodeFetch;
    this.scrub = new Redactor();
    // A key shorter than the redactor's minimum cannot be tracked. It still never goes into a message, because messages are built
    // only from the status, an error code and a short scrubbed excerpt.
    if (this.apiKey) {
      try {
        this.scrub.add(this.apiKey, "provider_api_key");
      } catch {
        /* too short to track */
      }
    }
  }

  get origin(): string {
    try {
      return new URL(this.base).origin;
    } catch {
      return "the provider";
    }
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", accept: "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  /** Scrubs the whole text first (so a key cannot straddle the cut), then shortens it and cleans it for a terminal. */
  private excerpt(text: string): string {
    return cleanForTerminal(this.scrub.scrubText(text).replace(/\s+/g, " ").trim().slice(0, 300));
  }

  /** Reads the body up to the size cap. A body over the cap is not read to the end. */
  private async readCapped(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError(`the provider's answer is ${declared} bytes, more than the ${this.maxBytes} byte limit`);
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError(`the provider's answer is more than the ${this.maxBytes} byte limit`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async send(path: string, init: RequestInit, cancel?: AbortSignal): Promise<string> {
    if (cancel?.aborted) throw new ProviderCancelled();
    const signal = cancel ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), cancel]) : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, { ...init, headers: this.headers(), signal, redirect: "error" });
    } catch (error) {
      if (cancel?.aborted) throw new ProviderCancelled();
      const name = (error as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new ProviderError(`the provider at ${this.origin} did not answer within ${this.timeoutMs} ms`);
      // The text of a network error can quote the request, header values included, so only its code is shown.
      const failure = error as { code?: unknown; cause?: { code?: unknown } };
      const code = failure.cause?.code ?? failure.code;
      throw new ProviderError(`the provider at ${this.origin} could not be reached (${typeof code === "string" ? code.replace(/[^A-Za-z0-9_]/g, "") : name.replace(/[^A-Za-z0-9_]/g, "")})`);
    }
    let text: string;
    try {
      text = await this.readCapped(response);
    } catch (error) {
      if (cancel?.aborted) throw new ProviderCancelled();
      if (error instanceof ProviderError) throw error;
      // The time limit can also end a body that is still arriving.
      if (signal.aborted) throw new ProviderError(`the provider at ${this.origin} did not finish its answer within ${this.timeoutMs} ms`);
      throw new ProviderError("the provider's answer could not be read");
    }
    if (!response.ok) throw new ProviderError(`the provider answered HTTP ${response.status}: ${this.excerpt(text)}`);
    return text;
  }

  /** The names the server lists, which is the menu a person chooses the model from. */
  async listModels(cancel?: AbortSignal): Promise<string[]> {
    const text = await this.send("/models", { method: "GET" }, cancel);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError("the provider's model list is not JSON");
    }
    const parsed = ModelsSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError("the provider's model list has an unexpected shape");
    return parsed.data.data.map((m) => m.id);
  }

  /**
   * Finds out by trying whether the server really holds a context of `tokens`. It sends a plain prompt of about 95% of that size
   * (words that are about a token each) and asks for one token back. A server reports how many prompt tokens it took in, and a server
   * with a smaller window takes in fewer than were sent. This sends a long prompt, so it is slow on a small machine, and it is run
   * only on request (`provider check --probe-context`), never in a run.
   */
  async probeContext(model: string, tokens: number, cancel?: AbortSignal): Promise<{ sentAbout: number; reported: number | null; cut: boolean }> {
    const words = ["the", "table", "window", "green", "river", "paper", "stone", "light", "music", "water", "chair", "cloud", "house", "bread", "clock", "field", "glass", "horse", "night", "plant"];
    const sentAbout = Math.floor(tokens * 0.95);
    const filler = Array.from({ length: sentAbout }, (_, i) => words[i % words.length]).join(" ");
    const reply = await this.chat({ model, messages: [{ role: "user", content: `${filler}\n\nSay OK.` }], temperature: 0, max_tokens: 1 }, cancel, { allowCutOff: true });
    if (reply.usage.estimated) return { sentAbout, reported: null, cut: false };
    return { sentAbout, reported: reply.usage.input_tokens, cut: reply.usage.input_tokens < sentAbout * 0.9 };
  }

  async chat(request: ChatRequest, cancel?: AbortSignal, options: { allowCutOff?: boolean } = {}): Promise<ChatResult> {
    // The last guard against a silent cut. The clients shrink page text to fit before they get here; a prompt that still does not fit
    // (a long history, a retry) is refused, because the server would drop the beginning of it, where the rules are.
    if (this.contextTokens !== null && !options.allowCutOff) {
      const needed = estimateTokens(request) + request.max_tokens;
      if (needed > this.contextTokens) {
        throw new ContextTooSmall(`the prompt (about ${needed - request.max_tokens} tokens) and the answer (up to ${request.max_tokens}) do not fit the context of ${this.contextTokens} tokens; raise the context on the model server and provider.contextTokens, or lower provider.maxToolResultChars. Nothing was sent`);
      }
    }
    const text = await this.send("/chat/completions", { method: "POST", body: JSON.stringify({ ...request, stream: false }) }, cancel);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError(`the provider's answer is not JSON: ${this.excerpt(text)}`);
    }
    const parsed = ResponseSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError(`the provider's answer has an unexpected shape: ${this.excerpt(text)}`);
    const choice = parsed.data.choices[0]!;
    // An answer cut off by the token limit is not a short answer. Asking again at the same temperature would give the same cut.
    if (choice.finish_reason === "length" && !options.allowCutOff) throw new ProviderError("the model's answer was cut off by the token limit; raise provider.maxOutputTokens (a model that thinks aloud needs a lot) or use a model that answers briefly");
    const content = choice.message.content ?? "";
    const toolCalls = (choice.message.tool_calls ?? []).map((c, i) => ({
      id: c.id && c.id.length > 0 ? c.id : `call_${i + 1}`,
      name: c.function.name,
      arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
    }));
    const reported = parsed.data.usage;
    const usage: ChatUsage =
      reported && typeof reported.prompt_tokens === "number" && typeof reported.completion_tokens === "number"
        ? { input_tokens: Math.max(0, Math.round(reported.prompt_tokens)), output_tokens: Math.max(0, Math.round(reported.completion_tokens)), estimated: false }
        : { input_tokens: estimateTokens(request), output_tokens: Math.ceil((content.length + toolCalls.reduce((n, c) => n + c.name.length + c.arguments.length, 0)) / 3), estimated: true };
    return { content, toolCalls, usage, finishReason: choice.finish_reason ?? null };
  }
}
