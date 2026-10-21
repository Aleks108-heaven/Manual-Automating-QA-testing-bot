import { readFileSync } from "node:fs";
import { z } from "zod";
import { ACTOR_STOP_REASONS } from "../schemas/common.ts";
import type { FinalContext, ModelAction, ModelClient, ModelContext, ModelUsage } from "./client.ts";

// A scripted fake model: it plays hand-written action sequences, one list per step. It makes CI
// deterministic and free. It tests the bot's wiring, not a real model's judgment.

// Every item can carry `usage` (tokens the pretend model "used") and `delay_ms` (how long it "thought").
// They exist so the budget tests can run without a real model.
const Extras = {
  usage: z.strictObject({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }).optional(),
  delay_ms: z.number().int().min(0).optional(),
};
const ScriptItem = z.union([
  z.strictObject({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}), ...Extras }),
  z.strictObject({ stop: z.enum(ACTOR_STOP_REASONS), note: z.string().optional(), ...Extras }),
]);

export const ScriptSchema = z.strictObject({
  case_id: z.string().min(1),
  steps: z.array(z.array(ScriptItem)),
  observations: z
    .array(z.strictObject({ expected_ref: z.string().min(1), observed: z.string().nullable(), evidence: z.array(z.string()).default([]) }))
    .default([]),
  injection_suspected: z.boolean().default(false),
  notes: z.string().default(""),
  // What the pretend model answers when asked for its final report, one entry per attempt (the last
  // one repeats). The string "default" means the normal, valid report. Anything else is returned as
  // it is, so tests can feed in malformed reports.
  final_outputs: z.array(z.unknown()).optional(),
  // Tokens the pretend model "used" for each final report attempt.
  final_usage: z.strictObject({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }).optional(),
  final_delay_ms: z.number().int().min(0).optional(),
});
export type Script = z.infer<typeof ScriptSchema>;

export class ScriptedModelClient implements ModelClient {
  readonly name = "scripted";
  readonly modelId = "scripted";
  readonly live = false;
  private readonly script: Script;
  private pendingUsage: ModelUsage | undefined;

  constructor(script: Script) {
    this.script = ScriptSchema.parse(script);
  }

  static fromFile(path: string): ScriptedModelClient {
    return new ScriptedModelClient(ScriptSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
  }

  async nextAction(context: ModelContext): Promise<ModelAction> {
    // A script written for another case would run the wrong steps and could produce a misleading verdict.
    if (context.testCase.id !== this.script.case_id) {
      throw new Error(`the script is for ${this.script.case_id} but the case is ${context.testCase.id}`);
    }
    const items = this.script.steps[context.stepIndex - 1] ?? [];
    const item = items[context.actionsInStep.length];
    if (!item) return { type: "step_done" };
    if (item.delay_ms) await new Promise((resolve) => setTimeout(resolve, item.delay_ms));
    const usage = item.usage ? { usage: item.usage } : {};
    if ("stop" in item) return { type: "stop", reason: item.stop, ...(item.note ? { note: item.note } : {}), ...usage };
    return { type: "tool_call", tool: item.tool, args: item.args, ...usage };
  }

  consumeUsage(): ModelUsage | undefined {
    const usage = this.pendingUsage;
    this.pendingUsage = undefined;
    return usage;
  }

  async finalOutput(context: FinalContext): Promise<unknown> {
    if (this.script.final_delay_ms) await new Promise((resolve) => setTimeout(resolve, this.script.final_delay_ms));
    this.pendingUsage = this.script.final_usage;
    const scripted = this.script.final_outputs;
    if (scripted && scripted.length > 0) {
      const entry = scripted[Math.min(context.attempt - 1, scripted.length - 1)];
      if (entry !== "default") return entry;
    }
    const stop = context.actorStop;
    return {
      test_id: context.testCase.id,
      completed: stop === null,
      stop_reason: stop?.reason ?? null,
      stopped_at_step: stop?.step ?? null,
      observations: this.script.observations,
      injection_suspected: this.script.injection_suspected,
      notes: this.script.notes,
    };
  }
}
