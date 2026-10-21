// Writes the report's JSON Schema, the language-neutral contract other clients read (build brief: Language support).
// A test compares the committed file with this output, so the file cannot drift from the code.
//   node scripts/emit-schemas.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ReportSchema } from "../src/report/schema.ts";

export const REPORT_SCHEMA_PATH = "schemas/report.schema.json";

export function reportJsonSchema(): string {
  return `${JSON.stringify(z.toJSONSchema(ReportSchema), null, 2)}\n`;
}

if (import.meta.url === new URL(`file:///${process.argv[1]?.replaceAll("\\", "/")}`).href) {
  mkdirSync(dirname(REPORT_SCHEMA_PATH), { recursive: true });
  writeFileSync(REPORT_SCHEMA_PATH, reportJsonSchema());
  console.log(`Wrote ${REPORT_SCHEMA_PATH}`);
}
