// The agent loop: observe, decide (through the model client), act, record. After each step the
// runner, not the actor, evaluates that step's expected results. Hard caps end a runaway run as
// INCOMPLETE. Loop detection and the time and cost budgets arrive in M2.
import type { Config } from "../config.ts";
import type { PriorAction, ModelClient } from "../model/client.ts";
import { evaluateExpected } from "../oracle/assertions.ts";
import type { EvidenceSink } from "../oracle/evidence.ts";
import type { TestCase } from "../schemas/case.ts";
import type { ActorStopReason, RunnerStopReason } from "../schemas/common.ts";
import type { OutcomeRecord, StepRecord } from "../schemas/run-record.ts";
import type { RunnerAccess, ToolLayer } from "../tools/tool-layer.ts";

export interface LoopOptions {
  testCase: TestCase;
  model: ModelClient;
  tools: ToolLayer;
  access: RunnerAccess;
  config: Config;
  evidence: EvidenceSink;
}

export interface LoopResult {
  steps: StepRecord[];
  outcomes: OutcomeRecord[];
  actorStop: { reason: ActorStopReason; step: number } | null;
  runnerStop: RunnerStopReason | null;
  guardrailBlock: boolean;
  toolCalls: number;
}

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const { testCase, model, tools, access, config, evidence } = options;
  const steps: StepRecord[] = [];
  const outcomes: OutcomeRecord[] = [];
  let actorStop: LoopResult["actorStop"] = null;
  let runnerStop: RunnerStopReason | null = null;
  let toolCalls = 0;

  stepLoop: for (let index = 1; index <= testCase.steps.length; index += 1) {
    const stepText = testCase.steps[index - 1] as string;
    const record: StepRecord = { index, text: stepText, actions: [] };
    steps.push(record);
    access.setStep(index);
    const prior: PriorAction[] = [];

    for (;;) {
      if (prior.length >= config.budgets.maxToolCallsPerStep || toolCalls >= config.budgets.maxToolCallsPerRun) {
        runnerStop = "budget";
        break stepLoop;
      }
      const action = await model.nextAction({ testCase, stepIndex: index, stepText, actionsInStep: prior });
      if (action.type === "step_done") break;
      if (action.type === "stop") {
        actorStop = { reason: action.reason, step: index };
        break stepLoop;
      }
      toolCalls += 1;
      const result = await tools.call(action.tool, action.args);
      prior.push({ tool: action.tool, args: action.args, result: result.ok ? { ok: true, data: result.data } : { ok: false, code: result.code, message: result.message } });
      record.actions.push({
        tool: action.tool,
        args: (action.args && typeof action.args === "object" ? action.args : {}) as Record<string, unknown>,
        ok: result.ok,
        ...(result.ok ? {} : { error: `${result.code}: ${result.message}` }),
      });
      // A guardrail block stops the run at once. The verdict calculator turns it into INCONCLUSIVE.
      if (access.guardrails.blocked) break stepLoop;
    }

    // The step is done. Wait for the network to go quiet, then check this step's expected results in code.
    await access.settle(config.oracle.settleQuietMs, config.oracle.settleMaxMs);
    for (const expected of testCase.expected.filter((e) => e.after_step === index)) {
      outcomes.push(await evaluateExpected(expected, { access, config, evidence }));
    }
    if (access.guardrails.blocked) break;
  }

  return { steps, outcomes, actorStop, runnerStop, guardrailBlock: access.guardrails.blocked, toolCalls };
}
