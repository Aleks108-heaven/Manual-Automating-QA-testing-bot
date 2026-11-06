// A fake model server for the tests: it speaks the OpenAI-compatible chat API on a loopback port, the way LM Studio and Ollama do.
// By default it plays a scripted case (the same script files the scripted model uses) over HTTP, in json or tools mode, so the
// live client, the prompts and the runner are exercised end to end with no real model. A test can override any reply.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ScriptSchema, type Script } from "../../../src/model/scripted.ts";

export interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string; parameters: unknown } }>;
  tool_choice?: string;
  response_format?: { type: string; json_schema?: { name: string; schema: unknown } };
  temperature?: number;
  seed?: number;
  max_tokens?: number;
}

export interface Reply {
  content?: string;
  toolCalls?: Array<{ id?: string; name: string; arguments: string | Record<string, unknown> }>;
  /** null leaves usage out of the answer, as some local servers do. */
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  status?: number;
  /** Sent as the whole body, instead of a chat answer. */
  rawBody?: string;
  delayMs?: number;
}

export interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: ChatBody | null;
  text: string;
}

export interface FakeLlmOptions {
  models?: string[];
  script?: Script;
  /** Return a reply to replace the default one, or undefined to let the default play. `n` counts chat requests from 1. */
  respond?: (body: ChatBody, n: number) => Reply | undefined;
}

/** Everything the client sent in one request, as text. */
export function allText(body: ChatBody): string {
  return body.messages.map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join("\n") : "")).join("\n---\n");
}

export class FakeLlm {
  readonly seen: Seen[] = [];
  /** How many chat requests the client closed before the server had answered them (a cancelled request). */
  aborted = 0;
  private readonly server: Server;
  private readonly options: FakeLlmOptions;
  private chats = 0;

  private constructor(server: Server, options: FakeLlmOptions) {
    this.server = server;
    this.options = options;
  }

  static async start(options: FakeLlmOptions = {}): Promise<FakeLlm> {
    const holder: { fake?: FakeLlm } = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => void holder.fake!.handle(req, Buffer.concat(chunks).toString("utf8"), res));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    holder.fake = new FakeLlm(server, options);
    return holder.fake;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  get chatBodies(): ChatBody[] {
    return this.seen.filter((s) => s.path === "/v1/chat/completions" && s.body).map((s) => s.body!);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, text: string, res: import("node:http").ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0] ?? "";
    let body: ChatBody | null = null;
    try {
      body = text ? (JSON.parse(text) as ChatBody) : null;
    } catch {
      body = null;
    }
    this.seen.push({ method: req.method ?? "", path, headers: req.headers, body, text });
    if (path === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: (this.options.models ?? ["fake-coder-14b"]).map((id) => ({ id, object: "model" })) }));
      return;
    }
    if (path !== "/v1/chat/completions" || !body) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    this.chats += 1;
    res.on("close", () => {
      if (!res.writableFinished) this.aborted += 1;
    });
    const reply = this.options.respond?.(body, this.chats) ?? this.play(body);
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    res.statusCode = reply.status ?? 200;
    if (reply.rawBody !== undefined) {
      res.end(reply.rawBody);
      return;
    }
    res.setHeader("content-type", "application/json");
    const message: Record<string, unknown> = { role: "assistant", content: reply.content ?? null };
    if (reply.toolCalls) message["tool_calls"] = reply.toolCalls.map((c, i) => ({ id: c.id ?? `fake_${this.chats}_${i}`, type: "function", function: { name: c.name, arguments: c.arguments } }));
    const usage = reply.usage === undefined ? { prompt_tokens: 100, completion_tokens: 10 } : reply.usage;
    res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }], ...(usage ? { usage } : {}) }));
  }

  /** Plays the script: the next action for the step in the prompt, or the final report. */
  private play(body: ChatBody): Reply {
    const script = this.options.script ? ScriptSchema.parse(this.options.script) : null;
    if (!script) return { content: JSON.stringify({ type: "step_done" }) };
    const text = allText(body);
    if (text.includes("Now write your final report as one JSON object") && !body.tools) {
      const stop = /was stopped at step (\d+) with stop_reason "(\w+)"/.exec(text);
      return {
        content: JSON.stringify({
          test_id: script.case_id,
          completed: !stop,
          stop_reason: stop ? stop[2] : null,
          stopped_at_step: stop ? Number(stop[1]) : null,
          observations: script.observations,
          injection_suspected: script.injection_suspected,
          notes: script.notes,
        }),
      };
    }
    const step = Number(/NOW: step (\d+) of/.exec(text)?.[1] ?? "1");
    const done = body.messages.filter((m) => m.role === "assistant" && (m.tool_calls !== undefined || (typeof m.content === "string" && m.content.startsWith('{"type":"tool_call"')))).length;
    const item = script.steps[step - 1]?.[done];
    if (!item) return body.tools ? { toolCalls: [{ name: "step_done", arguments: "{}" }] } : { content: JSON.stringify({ type: "step_done" }) };
    if ("stop" in item) return body.tools ? { toolCalls: [{ name: "stop", arguments: JSON.stringify({ reason: item.stop, note: item.note }) }] } : { content: JSON.stringify({ type: "stop", reason: item.stop, note: item.note }) };
    return body.tools ? { toolCalls: [{ name: item.tool, arguments: JSON.stringify(item.args) }] } : { content: JSON.stringify({ type: "tool_call", tool: item.tool, args: item.args }) };
  }
}
