import { readFileSync } from "node:fs";
import { z } from "zod";
import { ACTOR_STOP_REASONS } from "../schemas/common.ts";
import type { FinalContext, ModelAction, ModelClient, ModelContext } from "./client.ts";

// A scripted fake model: it plays hand-written action sequences, one list per step. It makes CI
// deterministic and free. It tests the bot's wiring, not a real model's judgment.

const ScriptItem = z.union([
  z.strictObject({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }),
  z.strictObject({ stop: z.enum(ACTOR_STOP_REASONS), note: z.string().optional() }),
]);

export const ScriptSchema = z.strictObject({
  case_id: z.string().min(1),
  steps: z.array(z.array(ScriptItem)),
  observations: z
    .array(z.strictObject({ expected_ref: z.string().min(1), observed: z.string().nullable(), evidence: z.array(z.string()).default([]) }))
    .default([]),
  injection_suspected: z.boolean().default(false),
  notes: z.string().default(""),
});
export type Script = z.infer<typeof ScriptSchema>;

export class ScriptedModelClient implements ModelClient {
  readonly name = "scripted";
  private readonly script: Script;

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
    if ("stop" in item) return { type: "stop", reason: item.stop, ...(item.note ? { note: item.note } : {}) };
    return { type: "tool_call", tool: item.tool, args: item.args };
  }

  async finalOutput(context: FinalContext): Promise<unknown> {
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
