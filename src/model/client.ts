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

/** Tokens the provider reports for producing one action. The budget turns them into cost. */
export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

export type ModelAction =
  | { type: "tool_call"; tool: string; args: unknown; usage?: ModelUsage }
  | { type: "step_done"; usage?: ModelUsage }
  | { type: "stop"; reason: ActorStopReason; note?: string; usage?: ModelUsage };

export interface FinalContext {
  testCase: TestCase;
  /** Set when the actor itself stopped the run. */
  actorStop: { reason: ActorStopReason; step: number } | null;
  /** 1 for the first request. Later requests follow a report that failed validation. */
  attempt: number;
  /** What was wrong with the previous report (field names and rules, never values), or null on the first attempt. */
  previousError: string | null;
}

export interface ModelClient {
  readonly name: string;
  nextAction(context: ModelContext): Promise<ModelAction>;
  /** Raw actor output JSON. The runner validates it against ActorOutputSchema and never repairs it. */
  finalOutput(context: FinalContext): Promise<unknown>;
  /** Tokens used since the last call to this method, for the cost budget. Optional. */
  consumeUsage?(): ModelUsage | undefined;
}
