// Budgets for one run: tool calls, wall-clock time, and cost. A run that exceeds any of them stops, and
// the verdict is INCOMPLETE, never PASS (manual: Definitions, precedence row 5; Running tests, "Run rules").
import type { Config } from "../config.ts";
import type { RunnerStopReason } from "../schemas/common.ts";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface BudgetStop {
  /** budget for tool calls and cost, timeout for wall-clock time. */
  reason: Extract<RunnerStopReason, "budget" | "timeout">;
  /** Which limit, in words. Contains numbers only, never page content. */
  detail: string;
}

export interface BudgetSnapshot {
  tool_calls: number;
  wall_ms: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export class BudgetGuard {
  private readonly limits: Config["budgets"];
  private readonly pricing: Config["pricing"];
  private readonly now: () => number;
  private startedAt = 0;
  private toolCalls = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(limits: Config["budgets"], pricing: Config["pricing"], now: () => number = Date.now) {
    this.limits = limits;
    this.pricing = pricing;
    this.now = now;
  }

  start(): void {
    this.startedAt = this.now();
  }

  chargeToolCall(): void {
    this.toolCalls += 1;
  }

  chargeUsage(usage: Usage | undefined): void {
    if (!usage) return;
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
  }

  get costUsd(): number {
    return (this.inputTokens / 1e6) * this.pricing.inputPerMTok + (this.outputTokens / 1e6) * this.pricing.outputPerMTok;
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.limits.maxWallMs - this.elapsedMs);
  }

  /** Time first, then tool calls, then cost. Returns null while the run is within its budgets. */
  check(toolCallsInThisStep: number): BudgetStop | null {
    if (this.elapsedMs >= this.limits.maxWallMs) return { reason: "timeout", detail: `time limit of ${this.limits.maxWallMs} ms reached` };
    if (this.toolCalls >= this.limits.maxToolCallsPerRun) return { reason: "budget", detail: `limit of ${this.limits.maxToolCallsPerRun} tool calls per run reached` };
    if (toolCallsInThisStep >= this.limits.maxToolCallsPerStep) return { reason: "budget", detail: `limit of ${this.limits.maxToolCallsPerStep} tool calls per step reached` };
    if (this.costUsd >= this.limits.maxCostUsd) return { reason: "budget", detail: `cost limit of ${this.limits.maxCostUsd} USD reached` };
    return null;
  }

  snapshot(): BudgetSnapshot {
    return {
      tool_calls: this.toolCalls,
      wall_ms: Math.round(this.elapsedMs),
      cost_usd: Number(this.costUsd.toFixed(6)),
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
    };
  }
}

/** Thrown by withDeadline when the time budget runs out while waiting for the model or a tool. */
export class DeadlineExceeded extends Error {}

/** Waits for a promise, but gives up when the time budget is gone. The promise itself is not cancelled. */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceeded("the time budget ran out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
