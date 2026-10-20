import type { ModelUsage } from "../model/client.ts";

// The judge decides the expected results that code cannot assert (kind "judged"). It is a separate call
// from the actor and gets only what the runner captured. There is deliberately no field here for the
// actor's observations, notes, reasoning or its own injection flag, so none of them can reach the judge
// (manual: instruction pack; prompts/judge.v1.md).

export interface JudgeEvidenceItem {
  /** The evidence id the judge must cite. */
  id: string;
  kind: "screenshot" | "snapshot" | "network";
  /** The scrubbed text of a snapshot or network log. */
  text?: string;
  /** Absolute path of a screenshot, for a client that sends images. */
  imagePath?: string;
}

export interface JudgeItem {
  expected_ref: string;
  /** What the case author wrote. This is the only statement of what is expected. */
  description: string;
  step: number;
  evidence: JudgeEvidenceItem[];
}

export interface JudgeInput {
  case_id: string;
  items: JudgeItem[];
  /** The actions the runner saw, in order: tool, arguments and whether each worked. */
  step_log: Array<{ step: number; tool: string; args: Record<string, unknown>; ok: boolean }>;
  /** Console errors, scrubbed. */
  console_errors: string[];
  /** 1 for the first request. Later requests follow an answer that failed validation. */
  attempt: number;
  /** What was wrong with the previous answer (rules and field names, never values), or null. */
  previous_error: string | null;
}

export interface JudgeClient {
  readonly name: string;
  /** Raw judge output JSON. The runner validates it and never repairs it. */
  judge(input: JudgeInput): Promise<unknown>;
  /** Tokens used since the last call, for the cost budget. Optional. */
  consumeUsage?(): ModelUsage | undefined;
}
