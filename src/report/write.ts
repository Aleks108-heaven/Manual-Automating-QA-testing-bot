import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Redactor } from "../redact/redactor.ts";
import { scanArtifacts } from "../redact/scan.ts";
import { formatReport } from "./format.ts";
import { ReportSchema, type Report } from "./schema.ts";

export function newReportId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return `${stamp}-report-${randomBytes(2).toString("hex")}`;
}

/**
 * Stores a report as report.json (the contract) and report.txt (the same report as text) in <runsDir>/reports/<id>.
 * The report is built from records the runner already scrubbed. The scan below is a last check that no credential
 * header slipped through, and a finding stops the write.
 */
export function writeReport(report: Report, runsDir: string): { dir: string; json: string; text: string } {
  ReportSchema.parse(report);
  const dir = join(runsDir, "reports", report.report_id);
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "report.json");
  const text = join(dir, "report.txt");
  writeFileSync(json, JSON.stringify(report, null, 2));
  writeFileSync(text, formatReport(report));
  const scan = scanArtifacts(dir, new Redactor());
  if (scan.findings.length > 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`a credential header was found in the report (${scan.findings.map((f) => f.file).join(", ")}). The report was not trusted and was removed.`);
  }
  return { dir, json, text };
}
