import { z } from "zod";
import { isValidDeclaration } from "../tools/mutations.ts";
import { WhereSchema } from "./common.ts";

// The case template is defined on the manual's page "Writing bot-ready test cases"
// (docs/manual/06-writing-bot-ready-test-cases.md).

const ExpectedBase = {
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "an id starts with a letter and uses letters, digits, _ or -"),
  after_step: z.number().int().min(1),
  description: z.string().min(1),
};

const TextVisible = z.strictObject({
  ...ExpectedBase,
  kind: z.literal("text_visible"),
  where: WhereSchema,
  text: z.string().min(1),
  // By default the element's text only has to contain `text`. With exact: true the whole text of the element
  // (white space collapsed) has to equal it, which also catches a message with something added or removed.
  exact: z.boolean().optional(),
});

const Url = z
  .strictObject({
    ...ExpectedBase,
    kind: z.literal("url"),
    equals: z.string().min(1).optional(),
    matches: z.string().min(1).optional(),
  })
  .refine((v) => (v.equals === undefined) !== (v.matches === undefined), {
    message: "a url entry needs exactly one of equals or matches",
  });

const Status = z.strictObject({
  ...ExpectedBase,
  kind: z.literal("status"),
  request: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/, 'use the form "METHOD /path"'),
  status: z.number().int().min(100).max(599),
});

const Count = z.strictObject({
  ...ExpectedBase,
  kind: z.literal("count"),
  where: WhereSchema,
  equals: z.number().int().min(0),
});

export const ELEMENT_STATES = ["visible", "hidden", "enabled", "disabled", "checked", "unchecked"] as const;
export type ElementState = (typeof ELEMENT_STATES)[number];

const ElementStateEntry = z.strictObject({
  ...ExpectedBase,
  kind: z.literal("element_state"),
  where: WhereSchema,
  state: z.enum(ELEMENT_STATES),
});

const Judged = z.strictObject({
  ...ExpectedBase,
  kind: z.literal("judged"),
});

// A union (not discriminatedUnion) because the url entry carries a refinement.
export const ExpectedResultSchema = z.union([TextVisible, Url, Status, Count, ElementStateEntry, Judged]);
export type ExpectedResult = z.infer<typeof ExpectedResultSchema>;
export type ExpectedKind = ExpectedResult["kind"];

/** An executable API call, used for setup and teardown through the application's test API. */
export const CallSchema = z.strictObject({
  call: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/, 'use the form "METHOD /path"'),
  body: z.record(z.string(), z.unknown()).optional(),
  description: z.string().min(1).optional(),
});
export type Call = z.infer<typeof CallSchema>;

export const CaseSchema = z.strictObject({
  id: z.string().regex(/^TC-[A-Z]+-\d{3}$/, "an id looks like TC-AUTH-003"),
  title: z.string().min(1),
  priority: z.enum(["P1", "P2", "P3"]),
  technique: z.string().min(1).optional(),
  risk: z.string().min(1).optional(),
  requirement: z.string().min(1).optional(),
  role: z.string().min(1).default("none"),
  // Human-readable text, kept as the manual's template describes.
  preconditions: z.array(z.string().min(1)).default([]),
  cleanup: z.array(z.string().min(1)).default([]),
  // Executable counterparts of preconditions and cleanup.
  setup: z.array(CallSchema).default([]),
  teardown: z.array(CallSchema).default([]),
  data: z.record(z.string(), z.string()).default({}),
  allowed_mutations: z.array(z.string().refine(isValidDeclaration, 'use "METHOD /path", "POST /path#Operation" or "WS /path"')).default([]),
  steps: z.array(z.string().min(1)).min(1, "a case needs at least one step"),
  expected: z.array(ExpectedResultSchema).min(1, "a case needs at least one expected result"),
  automation_notes: z.string().optional(),
});
export type TestCase = z.infer<typeof CaseSchema>;
