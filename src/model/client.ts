import type { ActorStopReason } from "../schemas/common.ts";
import type { TestCase } from "../schemas/case.ts";

// The model client is the only thing that talks to a model. CI uses the scripted fake in
// ./scripted.ts. A live client for the chosen provider arrives later (build brief: Model client).

export interface PriorAction {
  tool: string;
  args: unknown;
  result: { ok: boolean; data?: unknown; code?: string; message?: string };
}

export interface ModelContext {
  testCase: TestCase;
  stepIndex: number; // 1-based
  stepText: string;
  /** Tool calls already made in this step, with their results. */
  actionsInStep: readonly PriorAction[];
}

export type ModelAction =
  | { type: "tool_call"; tool: string; args: unknown }
  | { type: "step_done" }
  | { type: "stop"; reason: ActorStopReason; note?: string };

export interface FinalContext {
  testCase: TestCase;
  /** Set when the actor itself stopped the run. */
  actorStop: { reason: ActorStopReason; step: number } | null;
}

export interface ModelClient {
  readonly name: string;
  nextAction(context: ModelContext): Promise<ModelAction>;
  /** Raw actor output JSON. The runner validates it against ActorOutputSchema. */
  finalOutput(context: FinalContext): Promise<unknown>;
}
