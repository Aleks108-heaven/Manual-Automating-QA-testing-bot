import type { FinalContext, ModelAction, ModelClient, ModelContext } from "../model/client.ts";
import type { ActorStopReason } from "../schemas/common.ts";
import type { FrozenScript } from "./schema.ts";

// Replays a frozen script through the same runner as any other run. The runner still applies the allowlist, the
// mutation rules and the redactor, and still evaluates the case's expected results in code. The only thing this client
// does is hand the loop the recorded actions in order. It never decides a verdict and never calls a model.
//
// If an action fails, the script step cannot run (a locator is stale, an element has moved). The client then stops the
// run with a stop reason, which the verdict table turns into BLOCKED. It does not retry, search for another locator, or
// carry on, because carrying on could let a later check pass for the wrong reason.

export class FrozenScriptModel implements ModelClient {
  readonly name = "frozen-script";
  readonly modelId = "frozen-script";
  readonly live = false;
  private readonly script: FrozenScript;

  constructor(script: FrozenScript) {
    this.script = script;
  }

  async nextAction(context: ModelContext): Promise<ModelAction> {
    if (context.testCase.id !== this.script.case_id) {
      throw new Error(`the frozen script is for ${this.script.case_id} but the case is ${context.testCase.id}`);
    }
    const failed = [...context.actionsInStep].reverse().find((a) => !a.result.ok);
    if (failed) {
      const reason: ActorStopReason = failed.result.code === "ambiguous" ? "step_ambiguous" : "element_missing";
      return { type: "stop", reason, note: `frozen script step ${context.stepIndex} could not run: ${failed.result.code ?? "error"}` };
    }
    const actions = this.script.steps.find((s) => s.index === context.stepIndex)?.actions ?? [];
    const next = actions[context.actionsInStep.length];
    return next ? { type: "tool_call", tool: next.tool, args: next.args } : { type: "step_done" };
  }

  async finalOutput(context: FinalContext): Promise<unknown> {
    const stop = context.actorStop;
    // A script observes nothing in words: the runner's own evidence decides every expected result.
    return {
      test_id: context.testCase.id,
      completed: stop === null,
      stop_reason: stop?.reason ?? null,
      stopped_at_step: stop?.step ?? null,
      observations: [],
      injection_suspected: false,
      notes: `Replayed frozen script version ${this.script.version}. No model was called.`,
    };
  }
}
