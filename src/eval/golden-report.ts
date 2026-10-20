import { z } from "zod";
import { VERDICTS, OUTCOMES } from "../schemas/common.ts";

// The golden-set report is a file. Resuming the kill switch needs a clean one, so the format is shared by the
// golden-set runner and by the kill switch. Kept free of the runner's own imports for that reason.
const Rate = z.strictObject({ count: z.number().int().min(0), n: z.number().int().min(0), rate: z.number().nullable(), lower95: z.number(), upper95: z.number() });

export const GoldenEntryResultSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  case: z.string(),
  priority: z.enum(["P1", "P2", "P3"]),
  status: z.enum(["match", "changed"]),
  expected: z.strictObject({ verdict: z.enum(VERDICTS), row: z.number().int(), outcomes: z.record(z.string(), z.enum(OUTCOMES)) }),
  actual: z.strictObject({ verdict: z.enum(VERDICTS), row: z.number().int(), outcomes: z.record(z.string(), z.enum(OUTCOMES)) }),
  /** The case file or the script is not the one the entry was frozen with. */
  inputs_changed: z.boolean(),
  details: z.array(z.string()),
});
export type GoldenEntryResult = z.infer<typeof GoldenEntryResultSchema>;

export const GoldenReportSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal("golden-set"),
  at: z.string(),
  /** resume: made while the kill switch is engaged, so that it can be used to resume. */
  purpose: z.enum(["run", "resume"]),
  model: z.string(),
  notes: z.array(z.string()),
  golden_file: z.string(),
  frozen_at: z.string(),
  frozen_by: z.string(),
  build: z.string().nullable(),
  entries: z.array(GoldenEntryResultSchema),
  match: Rate,
  changed_p1: z.array(z.string()),
  flags: z.array(z.string()),
  /** True only if every entry matched and no input changed. */
  ok: z.boolean(),
  seconds: z.number(),
});
export type GoldenReport = z.infer<typeof GoldenReportSchema>;
