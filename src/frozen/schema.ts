import { z } from "zod";
import { hashText, stableJson } from "../hash.ts";
import { TOOL_SCHEMAS, type ToolName } from "../tools/schemas.ts";

export { hashText, stableJson };

/** A case id. It becomes part of file names, so nothing else (no path separator, no "..") is accepted anywhere it is read. */
export const CaseId = z.string().regex(/^TC-[A-Z]+-\d{3}$/);

// Frozen scripts (build brief: Freezer, M7; manual: Purpose, "Hybrid path"; Guardrails, "Frozen scripts"). A script is the
// acting tool calls of a case that proved stable, kept per step. The expected results stay in the case file and are still
// evaluated by the runner, so a script contains no assertion of its own and cannot loosen one.

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** The tools a script may replay. The observation tools (snapshot, screenshot and the two error lists) change nothing, and the runner takes its own evidence. */
export const FROZEN_TOOLS = ["goto", "click", "fill", "fill_secret", "press", "wait_for"] as const satisfies readonly ToolName[];
export type FrozenTool = (typeof FROZEN_TOOLS)[number];

/** One replayable action. Its arguments must satisfy the same schema the tool layer applies, so a script cannot hold a call the tool layer would reject as malformed. */
export const FrozenActionSchema = z
  .strictObject({
    tool: z.enum(FROZEN_TOOLS),
    args: z.record(z.string(), z.unknown()),
  })
  .superRefine((action, ctx) => {
    const parsed = TOOL_SCHEMAS[action.tool].safeParse(action.args);
    if (!parsed.success) ctx.addIssue({ code: "custom", path: ["args"], message: `${action.tool}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ")}` });
  });
export type FrozenAction = z.infer<typeof FrozenActionSchema>;

export const FrozenScriptSchema = z.strictObject({
  schema_version: z.literal(1),
  case_id: CaseId,
  /** 1 for the first script. A change a person approves makes the next number. */
  version: z.number().int().min(1),
  /** The hash of the case file this script was frozen from. A script does not run against a case that has changed. */
  case_hash: Sha256,
  frozen_at: z.string(),
  /** The runs that proved the case stable. live_model is false when any of them used a scripted fake. */
  source: z.strictObject({
    runs: z.array(z.strictObject({ run_id: z.string().min(1), model_live: z.boolean() })).min(1),
    live_model: z.boolean(),
  }),
  steps: z.array(z.strictObject({ index: z.number().int().min(1), actions: z.array(FrozenActionSchema) })).min(1),
});
export type FrozenScript = z.infer<typeof FrozenScriptSchema>;

/** A script is stored as text, and its hash is the hash of that text. */
export function serializeScript(script: FrozenScript): string {
  return `${JSON.stringify(FrozenScriptSchema.parse(script), null, 2)}\n`;
}

/** The register of approved scripts: who approved which hash, and when. The highest version of a case is its active script. */
const RegisterEntrySchema = z.strictObject({
  case_id: CaseId,
  version: z.number().int().min(1),
  file: z.string().min(1),
  script_hash: Sha256,
  case_hash: Sha256,
  approved_by: z.string().min(1),
  approved_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Why this version exists: the first freeze, or the proposal a person approved. */
  reason: z.string().min(1),
});
export type RegisterEntry = z.infer<typeof RegisterEntrySchema>;

export const FrozenRegisterSchema = z
  .strictObject({
    schema_version: z.literal(1),
    scripts: z.array(RegisterEntrySchema),
  })
  .superRefine((register, ctx) => {
    const seen = new Set<string>();
    for (const e of register.scripts) {
      const key = `${e.case_id}#${e.version}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `${e.case_id} version ${e.version} is registered twice` });
      seen.add(key);
    }
  });
export type FrozenRegister = z.infer<typeof FrozenRegisterSchema>;

/** The proposer's raw answer. Validated, retried and never repaired. */
export const ProposalBodySchema = z.strictObject({
  /** The step whose actions the proposal replaces. It must be the step that could not run. */
  step: z.number().int().min(1),
  actions: z.array(FrozenActionSchema).min(1),
  rationale: z.string().min(1),
});
export type ProposalBody = z.infer<typeof ProposalBodySchema>;

/**
 * What is stored when a script step could not run. It is only a proposal: nothing reads it except a person, and the
 * script changes only when a person approves it (`frozen approve-proposal`).
 */
export const ProposalSchema = z.strictObject({
  schema_version: z.literal(1),
  status: z.literal("proposed"),
  case_id: CaseId,
  /** The script the proposal is for. A proposal for any other hash is stale and cannot be approved. */
  script_version: z.number().int().min(1),
  script_hash: Sha256,
  run_id: z.string().min(1),
  proposed_by: z.strictObject({ name: z.string(), model_id: z.string(), live: z.boolean() }),
  failed: z.strictObject({ step: z.number().int().min(1), step_text: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()), error: z.string() }),
  proposal: ProposalBodySchema,
});
export type Proposal = z.infer<typeof ProposalSchema>;
