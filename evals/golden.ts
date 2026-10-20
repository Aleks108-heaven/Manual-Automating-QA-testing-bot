// The golden set (T13). A person froze a set of runs and the verdicts they must give. Run it after every change to
// the bot, the prompts, the model or the cases, and weekly. A verdict that moved is drift: it is reported, and a moved
// P1 verdict is flagged loudly. The set is frozen by people. Nothing here updates an expected verdict by itself.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadCase } from "../src/cases/load.ts";
import { negativeControl } from "../src/cases/mutate.ts";
import type { Config } from "../src/config.ts";
import { ScriptedJudge } from "../src/judge/scripted.ts";
import { ScriptedModelClient } from "../src/model/scripted.ts";
import type { PauseSource } from "../src/ops/kill-switch.ts";
import { runCase } from "../src/runner/run-case.ts";
import { StaticSecretStore, type SecretStore } from "../src/secrets/store.ts";
import { OUTCOMES, VERDICTS } from "../src/schemas/common.ts";
import { launchSharedBrowser, type SharedBrowser } from "../src/tools/tool-layer.ts";
import { assertKnownDefects } from "../fixtures/defects.ts";
import { FIXTURE_SECRETS } from "../fixtures/secrets.ts";
import type { FixtureSite } from "../fixtures/site/server.ts";
import { GoldenReportSchema, type GoldenEntryResult, type GoldenReport } from "../src/eval/golden-report.ts";
import { percent, rate } from "../src/eval/stats.ts";

const Expect = z.strictObject({
  verdict: z.enum(VERDICTS),
  row: z.number().int().min(1).max(7),
  /** The outcome of each expected result, by id. */
  outcomes: z.record(z.string(), z.enum(OUTCOMES)),
});

const Entry = z.strictObject({
  id: z.string().regex(/^G\d{2,3}$/),
  title: z.string().min(1),
  /** The case file. Not frozen with the entry: if it changes, that is drift the set must notice. */
  case: z.string().min(1),
  script: z.string().min(1),
  judge_script: z.string().min(1).optional(),
  defects: z.array(z.string()).default([]),
  /** Make this expected result wrong first, so the bot must report FAIL. */
  negative_control: z.string().min(1).optional(),
  /** Per-entry limits. Only the ones a golden entry needs. */
  limits: z.strictObject({ max_tool_calls_per_run: z.number().int().min(1).optional() }).default({}),
  /** P1 entries are the ones a change must never move without a person looking. */
  priority: z.enum(["P1", "P2", "P3"]),
  expect: Expect,
  /** Why a person believes this is the right verdict. */
  rationale: z.string().min(10),
  /** SHA-256 of the case file and the scripts when the entry was frozen. */
  inputs: z.strictObject({ case_sha256: z.string(), script_sha256: z.string(), judge_script_sha256: z.string().optional() }),
});

export const GoldenSetSchema = z.strictObject({
  schema_version: z.literal(1),
  /** The person who froze the set. A set nobody owns is not a golden set. */
  frozen_by: z.string().min(1),
  frozen_at: z.string().min(1),
  build: z.string().nullable(),
  note: z.string().optional(),
  entries: z.array(Entry).min(1),
});
export type GoldenSet = z.infer<typeof GoldenSetSchema>;
export type GoldenEntry = z.infer<typeof Entry>;

export class GoldenSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenSetError";
  }
}

// Line endings are normalised first: a checkout that turns LF into CRLF (git on Windows) must not make every entry stale.
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex");

export function loadGoldenSet(path: string): GoldenSet {
  if (!existsSync(path)) throw new GoldenSetError(`There is no golden set at ${path}.`);
  let set: GoldenSet;
  try {
    set = GoldenSetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new GoldenSetError(`The golden set at ${path} is not valid: ${(error as Error).message.split("\n")[0]}`);
  }
  const ids = set.entries.map((e) => e.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new GoldenSetError(`The golden set has two entries called ${duplicate}.`);
  for (const e of set.entries) {
    for (const file of [e.case, e.script, e.judge_script]) if (file && !existsSync(file)) throw new GoldenSetError(`${e.id}: ${file} does not exist.`);
    try {
      assertKnownDefects(e.defects);
    } catch (error) {
      throw new GoldenSetError(`${e.id}: ${(error as Error).message}`);
    }
  }
  return set;
}

function currentInputs(e: GoldenEntry): GoldenEntry["inputs"] {
  return { case_sha256: sha256(e.case), script_sha256: sha256(e.script), ...(e.judge_script ? { judge_script_sha256: sha256(e.judge_script) } : {}) };
}

/**
 * Writes the current hashes of every entry's inputs into the file. This is what a person does after deliberately
 * changing a case or a script, once they have looked at the diff and the new verdict. It never touches `expect`.
 */
export function rehashGoldenSet(path: string): number {
  const set = loadGoldenSet(path);
  let changed = 0;
  for (const e of set.entries) {
    const now = currentInputs(e);
    if (JSON.stringify(now) !== JSON.stringify(e.inputs)) changed += 1;
    e.inputs = now;
  }
  writeFileSync(path, `${JSON.stringify(set, null, 2)}\n`);
  return changed;
}

export interface GoldenOptions {
  config: Config;
  site: FixtureSite;
  outDir: string;
  file?: string;
  /** run: the runner must not be paused. resume: used to resume the kill switch, so it can run while paused. */
  purpose?: "run" | "resume";
  secrets?: SecretStore;
  pause?: PauseSource;
  sharedBrowser?: SharedBrowser;
  onProgress?: (done: number, total: number, note: string) => void;
}

const names = (o: Record<string, string>) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(", ") || "none";

export async function runGoldenSet(options: GoldenOptions): Promise<GoldenReport> {
  const started = Date.now();
  const file = options.file ?? options.config.evals.golden.file;
  const set = loadGoldenSet(file);
  const purpose = options.purpose ?? "run";
  const config = structuredClone(options.config);
  config.oracle.assertionTimeoutMs = config.evals.assertionTimeoutMs;
  config.runs.directory = join(options.outDir, "runs");
  mkdirSync(config.runs.directory, { recursive: true });
  const secrets = options.secrets ?? new StaticSecretStore(FIXTURE_SECRETS);
  const ownBrowser = options.sharedBrowser === undefined;
  const sharedBrowser = options.sharedBrowser ?? (await launchSharedBrowser(config, [new URL(options.site.origin).host]));
  const headers = { "content-type": "application/json", ...config.testApi.headers };
  const results: GoldenEntryResult[] = [];
  let modelName = "unknown";

  try {
    for (const [index, e] of set.entries.entries()) {
      const run = structuredClone(config);
      if (e.limits.max_tool_calls_per_run !== undefined) run.budgets.maxToolCallsPerRun = e.limits.max_tool_calls_per_run;
      options.site.setDefects(e.defects);
      await fetch(`${options.site.origin}/__test/reset`, { method: "POST", headers, body: "{}" });

      let testCase = loadCase(e.case);
      if (e.negative_control) testCase = negativeControl(testCase, e.negative_control).testCase;
      const model = ScriptedModelClient.fromFile(e.script);
      modelName = model.name;
      const { record, runDir } = await runCase({
        testCase,
        caseSource: `golden:${e.id}`,
        targetOrigin: options.site.origin,
        model,
        config: run,
        secrets,
        sharedBrowser,
        ...(e.judge_script ? { judge: ScriptedJudge.fromFile(e.judge_script) } : {}),
        // A golden run made to resume the kill switch has to be able to run while the switch is engaged.
        ...(purpose === "resume" || !options.pause ? {} : { pause: options.pause }),
      });
      const actualOutcomes = Object.fromEntries(record.outcomes.map((o) => [o.expected_ref, o.outcome]));
      const details: string[] = [];
      if (record.verdict !== e.expect.verdict) details.push(`verdict ${e.expect.verdict} became ${record.verdict}`);
      if (record.verdict_row !== e.expect.row) details.push(`precedence row ${e.expect.row} became ${record.verdict_row}`);
      if (names(actualOutcomes) !== names(e.expect.outcomes)) details.push(`outcomes were ${names(e.expect.outcomes)}, now ${names(actualOutcomes)}`);
      const inputsChanged = JSON.stringify(currentInputs(e)) !== JSON.stringify(e.inputs);
      if (inputsChanged) details.push("the case file or a script is not the one this entry was frozen with: a person must look at the change and re-freeze it");
      results.push({
        id: e.id,
        title: e.title,
        case: e.case,
        priority: e.priority,
        status: details.some((d) => !d.startsWith("the case file")) ? "changed" : "match",
        expected: e.expect,
        actual: { verdict: record.verdict, row: record.verdict_row, outcomes: actualOutcomes },
        inputs_changed: inputsChanged,
        details,
      });
      options.onProgress?.(index + 1, set.entries.length, `${e.id} ${record.verdict}`);
      // A run that matched needs no folder. A run that moved is kept, so a person can see why.
      if (results[results.length - 1]?.status === "match" && config.evals.keepRuns !== "all") rmSync(runDir, { recursive: true, force: true });
    }
  } finally {
    options.site.setDefects([]);
    if (ownBrowser) await sharedBrowser.close();
  }

  const changed = results.filter((r) => r.status === "changed");
  const changedP1 = changed.filter((r) => r.priority === "P1").map((r) => r.id);
  const moved = rate(results.filter((r) => r.status === "match").length, results.length);
  const flags: string[] = [];
  if (changedP1.length > 0) flags.push(`P1 verdict(s) changed: ${changedP1.join(", ")}. Do not ship or resume until a person has looked at each one.`);
  const otherChanged = changed.filter((r) => r.priority !== "P1");
  if (otherChanged.length > 0) flags.push(`${otherChanged.length} other verdict(s) changed: ${otherChanged.map((r) => r.id).join(", ")}`);
  if (/^\[to fill/i.test(set.frozen_by)) flags.push("nobody has frozen this set yet (frozen_by is still [to fill]): a person must review every entry and sign it");
  const stale = results.filter((r) => r.inputs_changed);
  if (stale.length > 0) flags.push(`${stale.length} entr${stale.length === 1 ? "y was" : "ies were"} frozen with other inputs than the ones now on disk: ${stale.map((r) => r.id).join(", ")}`);

  const notes = [
    "The golden set protects against drift. It is only as good as the people who froze it, and a person must approve any change to an expected verdict.",
  ];
  if (modelName === "scripted") notes.unshift("The model was scripted: this checks the bot's machinery (assertions, verdict table, guardrails) against frozen verdicts. It cannot show drift in a language model or its prompts.");

  const report: GoldenReport = GoldenReportSchema.parse({
    schema_version: 1,
    kind: "golden-set",
    at: new Date().toISOString(),
    purpose,
    model: modelName,
    notes,
    golden_file: file,
    frozen_at: set.frozen_at,
    frozen_by: set.frozen_by,
    build: set.build,
    entries: results,
    match: moved,
    changed_p1: changedP1,
    flags,
    ok: flags.length === 0,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  });
  mkdirSync(options.outDir, { recursive: true });
  const stamp = report.at.replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  writeFileSync(join(options.outDir, `golden-${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(options.outDir, "golden-latest.json"), JSON.stringify(report, null, 2));
  return report;
}

/** The report as text for a terminal. */
export function formatGoldenReport(report: GoldenReport): string {
  const out: string[] = [];
  out.push(`Golden set  ${report.at}  model: ${report.model}  purpose: ${report.purpose}  ${report.seconds} s`);
  for (const n of report.notes) out.push(`  Note: ${n}`);
  out.push(`Frozen      ${report.frozen_at} by ${report.frozen_by}, build ${report.build ?? "any"} (${report.golden_file})`);
  out.push("");
  for (const r of report.entries) {
    out.push(`  ${r.status === "match" && !r.inputs_changed ? "ok     " : r.status === "changed" ? "CHANGED" : "STALE  "} ${r.id} ${r.priority} ${r.title.padEnd(52)} ${r.actual.verdict}`);
    for (const d of r.details) out.push(`           ${d}`);
  }
  out.push("");
  out.push(`Match rate  ${report.match.count} of ${report.match.n} (${percent(report.match.rate)})`);
  out.push(report.ok ? "Clean: nothing moved." : `FLAGGED (${report.flags.length}):`);
  for (const f of report.flags) out.push(`  - ${f}`);
  return out.join("\n");
}
