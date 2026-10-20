import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ModelUsage } from "../model/client.ts";
import { OUTCOMES } from "../schemas/common.ts";
import type { JudgeClient, JudgeInput } from "./client.ts";

// A scripted fake judge for CI. It answers from a small script, and it records every input it was given
// (`inputs`) so tests can check exactly what the judge was shown.

export const JudgeScriptSchema = z.strictObject({
  // The outcome for each expected result id. Anything not listed gets NO_EVIDENCE.
  outcomes: z.record(z.string(), z.enum(OUTCOMES)).default({}),
  // What the judge cites: the first evidence item, all of them, none, or an id the runner never supplied.
  cite: z.enum(["first", "all", "none", "unknown"]).default("first"),
  // Expected result ids for which the judge reports an injection attempt in the evidence.
  injection: z.record(z.string(), z.boolean()).default({}),
  // Raw answers per attempt (the last repeats). "default" means the answer built from the fields above.
  raw: z.array(z.unknown()).optional(),
  usage: z.strictObject({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }).optional(),
  delay_ms: z.number().int().min(0).optional(),
});
export type JudgeScript = z.infer<typeof JudgeScriptSchema>;

export class ScriptedJudge implements JudgeClient {
  readonly name = "scripted-judge";
  readonly inputs: JudgeInput[] = [];
  private readonly script: JudgeScript;
  private pendingUsage: ModelUsage | undefined;

  constructor(script: Partial<z.input<typeof JudgeScriptSchema>> = {}) {
    this.script = JudgeScriptSchema.parse(script);
  }

  static fromFile(path: string): ScriptedJudge {
    return new ScriptedJudge(JSON.parse(readFileSync(path, "utf8")));
  }

  consumeUsage(): ModelUsage | undefined {
    const usage = this.pendingUsage;
    this.pendingUsage = undefined;
    return usage;
  }

  async judge(input: JudgeInput): Promise<unknown> {
    this.inputs.push(structuredClone(input));
    if (this.script.delay_ms) await new Promise((resolve) => setTimeout(resolve, this.script.delay_ms));
    this.pendingUsage = this.script.usage;
    const raw = this.script.raw;
    if (raw && raw.length > 0) {
      const entry = raw[Math.min(input.attempt - 1, raw.length - 1)];
      if (entry !== "default") return entry;
    }
    return {
      results: input.items.map((item) => ({
        expected_ref: item.expected_ref,
        outcome: this.script.outcomes[item.expected_ref] ?? "NO_EVIDENCE",
        evidence:
          this.script.cite === "none"
            ? []
            : this.script.cite === "unknown"
              ? ["ev-does-not-exist"]
              : this.script.cite === "all"
                ? item.evidence.map((e) => e.id)
                : item.evidence.slice(0, 1).map((e) => e.id),
        injection_suspected: this.script.injection[item.expected_ref] ?? false,
      })),
    };
  }
}
