import { z } from "zod";
import { ACTOR_STOP_REASONS, OutcomeSchema } from "./common.ts";

// The actor's output, from prompts/actor.v1.md. The actor reports observations only.
// There is no verdict field on purpose: strict parsing rejects one if the model adds it.
export const ActorOutputSchema = z
  .strictObject({
    test_id: z.string().min(1),
    completed: z.boolean(),
    stop_reason: z.enum(ACTOR_STOP_REASONS).nullable(),
    stopped_at_step: z.number().int().min(1).nullable(),
    observations: z.array(
      z.strictObject({
        expected_ref: z.string().min(1),
        observed: z.string().nullable(),
        evidence: z.array(z.string()),
      }),
    ),
    injection_suspected: z.boolean(),
    notes: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.completed !== (v.stop_reason === null)) {
      ctx.addIssue({ code: "custom", message: "completed must be true if and only if stop_reason is null", path: ["completed"] });
    }
    if ((v.stopped_at_step === null) !== (v.stop_reason === null)) {
      ctx.addIssue({
        code: "custom",
        message: "stopped_at_step must be set if and only if stop_reason is set",
        path: ["stopped_at_step"],
      });
    }
  });
export type ActorOutput = z.infer<typeof ActorOutputSchema>;

// The judge's output, from prompts/judge.v1.md. Used from M3.
export const JudgeOutputSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      expected_ref: z.string().min(1),
      outcome: OutcomeSchema,
      evidence: z.array(z.string()),
      injection_suspected: z.boolean(),
    }),
  ),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;
