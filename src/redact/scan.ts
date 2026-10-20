// The final artifact scan: a second line of defense after scrubbing. It looks in every file under a
// directory for any tracked secret value (in every variant) and for unredacted credential headers.
// A finding means the scrubber has a defect. Findings name the file and the secret's label, never the value.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Redactor } from "./redactor.ts";

export interface Finding {
  file: string;
  label: string;
  kind: "secret_value" | "credential_header";
}

export interface ScanResult {
  filesScanned: number;
  findings: Finding[];
}

// A header name followed by a value that is not [REDACTED], in HAR/JSON form or as a plain header line.
const HEADER_NAMES = "cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-access-token";
const JSON_HEADER = new RegExp(`"name"\\s*:\\s*"(?:${HEADER_NAMES})"\\s*,\\s*"value"\\s*:\\s*"(?!\\[REDACTED)[^"]`, "i");
const LINE_HEADER = new RegExp(`^\\s*(?:${HEADER_NAMES})\\s*:\\s*(?!\\[REDACTED)\\S`, "im");

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

export function scanArtifacts(dir: string, redactor: Redactor): ScanResult {
  const findings: Finding[] = [];
  const files = listFiles(dir);
  const variants = redactor.trackedVariants();
  for (const file of files) {
    const bytes = readFileSync(file);
    const rel = relative(dir, file).replaceAll("\\", "/");
    const seen = new Set<string>();
    for (const { variant, label } of variants) {
      if (!seen.has(label) && bytes.includes(Buffer.from(variant, "utf8"))) {
        seen.add(label);
        findings.push({ file: rel, label, kind: "secret_value" });
      }
    }
    // Header patterns only make sense in text files.
    if (/\.(json|jsonl|har|txt|log|md|html|csv)$/i.test(file)) {
      const text = bytes.toString("utf8");
      if (JSON_HEADER.test(text) || LINE_HEADER.test(text)) findings.push({ file: rel, label: "credential header", kind: "credential_header" });
    }
  }
  return { filesScanned: files.length, findings };
}
