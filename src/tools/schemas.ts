import { z } from "zod";
import { WhereSchema } from "../schemas/common.ts";

// The tool list from the build brief (module: Tool layer). fill_secret arrives in M2 with sessions.
export const TOOL_SCHEMAS = {
  goto: z.strictObject({ url: z.string().min(1) }),
  click: z.strictObject({ target: WhereSchema }),
  fill: z.strictObject({ target: WhereSchema, value: z.string() }),
  // The model names a data entry of the case, such as "data.correct_password". It never names a secret
  // and never receives a value (manual: Guardrails, "Secrets and sessions").
  fill_secret: z.strictObject({ target: WhereSchema, data_key: z.string().regex(/^data\.[A-Za-z0-9_]+$/, 'use the form "data.<key>" from the case') }),
  press: z.strictObject({ key: z.string().min(1), target: WhereSchema.optional() }),
  wait_for: z.strictObject({
    target: WhereSchema,
    state: z.enum(["visible", "hidden"]),
    timeout_ms: z.number().int().min(100).max(30_000).optional(),
  }),
  snapshot: z.strictObject({}),
  screenshot: z.strictObject({ label: z.string().min(1).max(60).optional() }),
  console_errors: z.strictObject({}),
  network_errors: z.strictObject({}),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

export type ToolErrorCode =
  | "invalid_args"
  | "unknown_tool"
  | "element_missing"
  | "ambiguous"
  | "blocked_by_guardrail"
  | "secret_not_declared"
  | "timeout"
  | "tool_error";

export type ToolResult = { ok: true; data: unknown } | { ok: false; code: ToolErrorCode; message: string };
