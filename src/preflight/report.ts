import { z } from "zod";

// The pre-flight report is written to a file. Resuming after the kill switch needs a clean one, so the format
// is shared by the pre-flight check and by the kill switch.
export const CHECK_STATUSES = ["passed", "failed", "skipped"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const PreflightReportSchema = z.strictObject({
  schema_version: z.literal(1),
  /** When the pre-flight finished. */
  at: z.string(),
  target: z.string(),
  /** True only if every check passed. A skipped check is not a pass. */
  ok: z.boolean(),
  checks: z.array(
    z.strictObject({
      name: z.string().min(1),
      status: z.enum(CHECK_STATUSES),
      /** Why. Never contains a credential. */
      detail: z.string(),
      ms: z.number().int().min(0),
    }),
  ),
});
export type PreflightReport = z.infer<typeof PreflightReportSchema>;
