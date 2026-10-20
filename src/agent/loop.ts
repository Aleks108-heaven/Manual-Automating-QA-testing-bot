// The agent loop: observe, decide (through the model client), act, record. After each step the
// runner, not the actor, evaluates that step's expected results. The loop enforces the budgets
// (tool calls, time, cost) and stops a run that repeats itself. A run that hits a budget is INCOMPLETE
// and a run that loops is BLOCKED (manual: Definitions, precedence rows 4 and 5).
import type { Config } from "../config.ts";
import type { PriorAction, ModelClient } from "../model/client.ts";
import type { ImplicitCollector } from "../implicit/collect.ts";
import type { JudgeClient, JudgeItem } from "../judge/client.ts";
import { evidenceItems, judgedOutcome, judgeItems, type JudgedResult } from "../judge/judge.ts";
import { evaluateExpected } from "../oracle/assertions.ts";
import type { EvidenceSink } from "../oracle/evidence.ts";
import { Redactor } from "../redact/redactor.ts";
import type { ExpectedResult, TestCase } from "../schemas/case.ts";
import type { ActorStopReason, RunnerStopReason } from "../schemas/common.ts";
import type { OutcomeRecord, StepRecord } from "../schemas/run-record.ts";
import type { RunnerAccess, ToolLayer } from "../tools/tool-layer.ts";
import { BudgetGuard, DeadlineExceeded, withDeadline, type BudgetSnapshot, type BudgetStop } from "./budget.ts";

export interface LoopOptions {
  testCase: TestCase;
  model: ModelClient;
  tools: ToolLayer;
  access: RunnerAccess;
  config: Config;
  evidence: EvidenceSink;
  /** Receives everything the model is shown and does, already scrubbed. The runner stores it. */
  transcript?: (entry: Record<string, unknown>) => void;
  redactor?: Redactor;
  /** Where this run's evidence is stored. The judge reads its evidence from here. */
  runDir: string;
  /** Decides the judged expected results. Without one, they get NO_EVIDENCE. */
  judge?: JudgeClient;
  /** Collects the implicit findings after each step. */
  implicit?: ImplicitCollector;
  /** The run's budget. The runner shares it with the final report and the judge, so they spend the same time and cost. */
  guard?: BudgetGuard;
  /** For tests: a clock the budget uses. */
  now?: () => number;
}

export interface LoopResult {
  steps: StepRecord[];
  outcomes: OutcomeRecord[];
  actorStop: { reason: ActorStopReason; step: number } | null;
  /** Who decided the stop: the model reported it, or the runner's loop detection did. */
  stopSource: "actor" | "runner" | null;
  runnerStop: RunnerStopReason | null;
  budgetStop: BudgetStop | null;
  guardrailBlock: boolean;
  toolCalls: number;
  budget: BudgetSnapshot;
  /** How the judge was used: batches asked, attempts made, rejected answers, results with an injection report. */
  judge: { calls: number; attempts: number; errors: string[]; injection: number };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const { testCase, model, tools, access, config, evidence, transcript, redactor } = options;
  const note = (entry: Record<string, unknown>) => transcript?.(redactor ? redactor.scrubJson(entry) : entry);
  const guard = options.guard ?? new BudgetGuard(config.budgets, config.pricing, options.now);
  guard.start();
  const judge = options.judge;
  const scrub = redactor ?? new Redactor();
  const judgeStats = { calls: 0, attempts: 0, errors: [] as string[], injection: 0 };

  const steps: StepRecord[] = [];
  const outcomes: OutcomeRecord[] = [];
  let actorStop: LoopResult["actorStop"] = null;
  let stopSource: LoopResult["stopSource"] = null;
  let runnerStop: RunnerStopReason | null = null;
  let budgetStop: BudgetStop | null = null;
  let toolCalls = 0;

  // Loop detection state.
  let lastSignature = "";
  let sameCount = 0;
  let failSignature = "";
  let failStreak = 0;

  const stopForBudget = (stop: BudgetStop, step: number) => {
    budgetStop = stop;
    runnerStop = stop.reason;
    note({ t: "budget_stop", step, reason: stop.reason, detail: stop.detail });
  };

  stepLoop: for (let index = 1; index <= testCase.steps.length; index += 1) {
    const stepText = testCase.steps[index - 1] as string;
    const record: StepRecord = { index, text: stepText, actions: [] };
    steps.push(record);
    access.setStep(index);
    const prior: PriorAction[] = [];
    note({ t: "step", step: index, text: stepText });

    for (;;) {
      const before = guard.check(prior.length);
      if (before) {
        stopForBudget(before, index);
        break stepLoop;
      }

      let action;
      try {
        action = await withDeadline(model.nextAction({ testCase, stepIndex: index, stepText, actionsInStep: prior }), guard.remainingMs);
      } catch (error) {
        if (!(error instanceof DeadlineExceeded)) throw error;
        stopForBudget({ reason: "timeout", detail: `time limit of ${config.budgets.maxWallMs} ms reached while waiting for the model` }, index);
        break stepLoop;
      }
      guard.chargeUsage(action.usage);

      if (action.type === "step_done") break;
      if (action.type === "stop") {
        actorStop = { reason: action.reason, step: index };
        stopSource = "actor";
        note({ t: "stop", step: index, reason: action.reason });
        break stepLoop;
      }

      // This model call may have used up the cost or the time. Then the action it chose is not carried out.
      const after = guard.check(prior.length);
      if (after) {
        stopForBudget(after, index);
        break stepLoop;
      }

      toolCalls += 1;
      guard.chargeToolCall();
      let result;
      try {
        result = await withDeadline(tools.call(action.tool, action.args), guard.remainingMs);
      } catch (error) {
        if (!(error instanceof DeadlineExceeded)) throw error;
        stopForBudget({ reason: "timeout", detail: `time limit of ${config.budgets.maxWallMs} ms reached during ${action.tool}` }, index);
        break stepLoop;
      }
      note({ t: "tool", step: index, tool: action.tool, args: action.args, result: result.ok ? { ok: true, data: result.data } : { ok: false, code: result.code, message: result.message } });
      prior.push({ tool: action.tool, args: action.args, result: result.ok ? { ok: true, data: result.data } : { ok: false, code: result.code, message: result.message } });
      record.actions.push({
        tool: action.tool,
        args: (action.args && typeof action.args === "object" ? action.args : {}) as Record<string, unknown>,
        ok: result.ok,
        ...(result.ok ? {} : { error: `${result.code}: ${result.message}` }),
      });

      // A guardrail block stops the run at once. The verdict calculator turns it into INCONCLUSIVE.
      if (access.guardrails.blocked) break stepLoop;

      // Loop detection: the same action failing again and again, or the same action repeated without end.
      const signature = `${action.tool} ${stableJson(action.args)}`;
      sameCount = signature === lastSignature ? sameCount + 1 : 1;
      lastSignature = signature;
      if (result.ok) {
        failStreak = 0;
        failSignature = "";
      } else {
        failStreak = signature === failSignature ? failStreak + 1 : 1;
        failSignature = signature;
      }
      if (failStreak >= config.loop.failureLimit || sameCount >= config.loop.repeatLimit) {
        actorStop = { reason: "loop", step: index };
        stopSource = "runner";
        note({ t: "loop_stop", step: index, tool: action.tool, failures_in_a_row: failStreak, repeats_in_a_row: sameCount });
        break stepLoop;
      }
    }

    // The step is done. Wait for the network to go quiet, then check this step's expected results in code.
    await access.settle(config.oracle.settleQuietMs, config.oracle.settleMaxMs);
    const stepExpected = testCase.expected.filter((e) => e.after_step === index);
    const stepOutcomes: OutcomeRecord[] = [];
    const judgedHere: ExpectedResult[] = [];
    for (const expected of stepExpected) {
      // Judged results go to the judge, if there is one. Everything else is checked in code.
      if (expected.kind === "judged" && judge) judgedHere.push(expected);
      else stepOutcomes.push(await evaluateExpected(expected, { access, config, evidence }));
    }

    if (judgedHere.length > 0 && judge) {
      const items: JudgeItem[] = [];
      for (const expected of judgedHere) {
        const refs = await evidence.capture(expected.id, expected.after_step);
        items.push({ expected_ref: expected.id, description: expected.description, step: expected.after_step, evidence: evidenceItems(refs, options.runDir) });
      }
      const stepLog = steps.flatMap((s) =>
        s.actions.map((a) => ({ step: s.index, tool: a.tool, args: scrub.scrubJson(a.args), ok: a.ok })),
      );
      const batch = await judgeItems({ judge, caseId: testCase.id, items, stepLog, consoleErrors: access.consoleErrors(), guard, config, redactor: scrub });
      judgeStats.calls += 1;
      judgeStats.attempts += batch.attempts;
      judgeStats.errors.push(...batch.errors);
      for (const item of items) {
        const result = batch.results.get(item.expected_ref) as JudgedResult;
        if (result.injection) judgeStats.injection += 1;
        stepOutcomes.push(judgedOutcome(item, result));
      }
      if (batch.budgetStop) stopForBudget(batch.budgetStop, index);
    }

    const position = (ref: string) => testCase.expected.findIndex((e) => e.id === ref);
    outcomes.push(...stepOutcomes.sort((a, b) => position(a.expected_ref) - position(b.expected_ref)));

    // Implicit checks run after the expected results, and only report. They never become outcomes.
    await options.implicit?.collectAfterStep(index);
    if (budgetStop || access.guardrails.blocked) break;
  }

  return {
    steps,
    outcomes,
    actorStop,
    stopSource,
    runnerStop,
    budgetStop,
    guardrailBlock: access.guardrails.blocked,
    toolCalls,
    budget: guard.snapshot(),
    judge: judgeStats,
  };
}
