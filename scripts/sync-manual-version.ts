// Keeps the manual's version in step with its change log, so the two cannot drift apart (they did: the Document control table said
// 0.12 while the log and the index said 0.15).
//
// The last row of the change log is the single source. This script copies its version into the Document control table ("Manual
// version") and into the first line of the index, and its date into that line. Nothing else is touched. In particular it never
// writes "Last reviewed", the owner or the status: those say that a person did something, and writing them by machine would make the
// manual untrue. It never edits the change log, which is append-only.
//
//   node scripts/sync-manual-version.ts           rewrite the two places
//   node scripts/sync-manual-version.ts --check   change nothing; exit 1 if they differ (CI runs the same check as a test)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOG_ROW = /^\| (\d{1,2} [A-Z][a-z]{2} \d{4}) \| (\d+\.\d+) \|/gm;
const TABLE_ROW = /^(\| Manual version \| )(\d+\.\d+)( \(draft\) \|)/m;
const INDEX_LINE = /^(Version )(\d+\.\d+)( \(draft\), )(\d{1,2} [A-Z][a-z]{2} \d{4})(\.)/m;

export interface ManualVersionResult {
  control: string;
  index: string;
  /** What was out of step, one line each. Empty when the two places already agree with the log. */
  changes: string[];
}

export class ManualVersionError extends Error {}

/** The version and date of the last row of the change log. */
export function lastLogEntry(controlText: string): { date: string; version: string } {
  const rows = [...controlText.matchAll(LOG_ROW)];
  const last = rows[rows.length - 1];
  if (!last) throw new ManualVersionError("the change log has no row of the form: | 6 Nov 2026 | 0.16 | ... |");
  return { date: last[1] as string, version: last[2] as string };
}

/** Pure: takes the text of the Document control page and of the index, and returns both with the version and date filled in. */
export function syncTexts(controlText: string, indexText: string): ManualVersionResult {
  const { date, version } = lastLogEntry(controlText);
  const changes: string[] = [];
  let control = controlText;
  let index = indexText;

  const table = TABLE_ROW.exec(control);
  if (!table) throw new ManualVersionError('the Document control page has no row "| Manual version | X.Y (draft) |"');
  if (table[2] !== version) {
    changes.push(`Document control table: Manual version ${table[2]} -> ${version}`);
    control = control.replace(TABLE_ROW, `$1${version}$3`);
  }

  const line = INDEX_LINE.exec(index);
  if (!line) throw new ManualVersionError('the index has no first line "Version X.Y (draft), D Mon YYYY."');
  if (line[2] !== version || line[4] !== date) {
    changes.push(`index first line: Version ${line[2]}, ${line[4]} -> Version ${version}, ${date}`);
    index = index.replace(INDEX_LINE, `$1${version}$3${date}$5`);
  }
  return { control, index, changes };
}

const CONTROL = "docs/manual/01-document-control.md";
const INDEX = "docs/manual/00-index.md";

/** Reads the two pages from a repository root and returns what they should be. */
export function checkManualVersion(root: string): ManualVersionResult {
  return syncTexts(readFileSync(join(root, CONTROL), "utf8"), readFileSync(join(root, INDEX), "utf8"));
}

/** Rewrites the two pages if they are out of step. Returns what changed. */
export function syncManualVersion(root: string): string[] {
  const result = checkManualVersion(root);
  if (result.changes.length > 0) {
    writeFileSync(join(root, CONTROL), result.control);
    writeFileSync(join(root, INDEX), result.index);
  }
  return result.changes;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  try {
    if (check) {
      const { changes } = checkManualVersion(process.cwd());
      if (changes.length > 0) {
        for (const c of changes) console.error(`out of step: ${c}`);
        console.error("Run: npm run docs:sync");
        process.exit(1);
      }
      console.log("docs:check ok: the manual's version agrees with the last row of its change log.");
    } else {
      const changes = syncManualVersion(process.cwd());
      console.log(changes.length > 0 ? changes.map((c) => `updated: ${c}`).join("\n") : "docs:sync: nothing to change, the manual's version already agrees with its change log.");
    }
  } catch (error) {
    if (error instanceof ManualVersionError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
