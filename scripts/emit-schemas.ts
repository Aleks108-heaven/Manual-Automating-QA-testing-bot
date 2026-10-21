// Writes the JSON Schemas of the bot's three contracts: the case, the run record and the report. They are the
// language-neutral interface other clients read (build brief: Language support). A test compares each committed file
// with this output, so a file cannot drift from the code.
//   node scripts/emit-schemas.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ReportSchema } from "../src/report/schema.ts";
import { CaseSchema } from "../src/schemas/case.ts";
import { RunRecordSchema } from "../src/schemas/run-record.ts";

export const SCHEMA_FILES: ReadonlyArray<{ path: string; build: () => string }> = [
  // A case file is written by a person, so its schema describes what may be written: fields with defaults are optional.
  { path: "schemas/case.schema.json", build: () => json(z.toJSONSchema(CaseSchema, { io: "input" })) },
  { path: "schemas/run-record.schema.json", build: () => json(z.toJSONSchema(RunRecordSchema)) },
  { path: "schemas/report.schema.json", build: () => json(z.toJSONSchema(ReportSchema)) },
];

export const REPORT_SCHEMA_PATH = "schemas/report.schema.json";

function json(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

export function reportJsonSchema(): string {
  return json(z.toJSONSchema(ReportSchema));
}

if (import.meta.url === new URL(`file:///${process.argv[1]?.replaceAll("\\", "/")}`).href) {
  for (const file of SCHEMA_FILES) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.build());
    console.log(`Wrote ${file.path}`);
  }
}
