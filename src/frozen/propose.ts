import { readFileSync } from "node:fs";
import { z } from "zod";
import { describeProblem } from "../runner/final-output.ts";
import type { ModelUsage } from "../model/client.ts";
import type { TestCase } from "../schemas/case.ts";
import type { Redactor } from "../redact/redactor.ts";
import { ProposalBodySchema, type FrozenScript, type ProposalBody } from "./schema.ts";

// When a script step cannot run, the agent may be asked to diagnose it and propose a change. That is all it may do
// (manual: Purpose, "Hybrid path"). It does not run the case again, it does not touch the script, and its answer does not
// reach the verdict. A person reads the proposal and approves it or not. As with every model output, an invalid answer is
// sent back and asked for again, never repaired.

export interface ProposalRequest {
  testCase: TestCase;
  script: FrozenScript;
  step: number;
  stepText: string;
  failed: { tool: string; args: Record<string, unknown>; error: string };
  /** The page as the runner saw it when the step stopped, scrubbed, or null. It is page content, so it is data and never instructions. */
  snapshot: string | null;
  attempt: number;
  /** What was wrong with the previous answer (field names and rules, never values), or null on the first attempt. */
  previousError: string | null;
}

export interface Proposer {
  readonly name: string;
  readonly modelId: string;
  /** False for a scripted fake. The proposal says so. */
  readonly live: boolean;
  /** The raw answer. The runner validates it against ProposalBodySchema. */
  propose(request: ProposalRequest): Promise<unknown>;
  consumeUsage?(): ModelUsage | undefined;
}

const ScriptedProposalsSchema = z.strictObject({ case_id: z.string().min(1), answers: z.array(z.unknown()).min(1) });

/** A fake proposer for CI and the fixture: it plays the answers written in a file, one per attempt (the last repeats). */
export class ScriptedProposer implements Proposer {
  readonly name = "scripted-proposer";
  readonly modelId = "scripted";
  readonly live = false;
  readonly requests: ProposalRequest[] = [];
  private readonly caseId: string;
  private readonly answers: readonly unknown[];

  constructor(caseId: string, answers: readonly unknown[]) {
    if (answers.length === 0) throw new Error("a scripted proposer needs at least one answer");
    this.caseId = caseId;
    this.answers = answers;
  }

  static fromFile(path: string): ScriptedProposer {
    const parsed = ScriptedProposalsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return new ScriptedProposer(parsed.case_id, parsed.answers);
  }

  async propose(request: ProposalRequest): Promise<unknown> {
    if (request.testCase.id !== this.caseId) throw new Error(`the scripted proposals are for ${this.caseId} but the case is ${request.testCase.id}`);
    this.requests.push(request);
    return this.answers[Math.min(request.attempt - 1, this.answers.length - 1)];
  }
}

export interface ProposalResult {
  body: ProposalBody | null;
  attempts: number;
  /** One description per rejected answer. */
  errors: string[];
}

export async function requestProposal(args: {
  proposer: Proposer;
  request: Omit<ProposalRequest, "attempt" | "previousError">;
  maxAttempts: number;
  redactor: Redactor;
  /** Called with the tokens each attempt used, so the run's budget pays for them. Return false to stop asking (the budget is spent). */
  charge?: (usage: ModelUsage | undefined) => boolean;
}): Promise<ProposalResult> {
  const { proposer, request, maxAttempts, redactor } = args;
  const errors: string[] = [];
  let previousError: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await proposer.propose({ ...request, attempt, previousError });
    const mayContinue = args.charge ? args.charge(proposer.consumeUsage?.()) : true;
    const parsed = ProposalBodySchema.safeParse(raw);
    let problem: string | null = null;
    if (!parsed.success) problem = describeProblem(parsed.error);
    else if (parsed.data.step !== request.step) problem = `step: must be ${request.step}, the step that could not run`;
    if (problem === null && parsed.success) return { body: parsed.data, attempts: attempt, errors };
    problem = redactor.scrubText(problem ?? "invalid proposal");
    errors.push(problem);
    previousError = problem;
    if (!mayContinue) return { body: null, attempts: attempt, errors };
  }
  return { body: null, attempts: maxAttempts, errors };
}
