import { checkRecord } from "../report/build.ts";
import type { TestCase } from "../schemas/case.ts";
import type { RunRecord } from "../schemas/run-record.ts";
import { FROZEN_TOOLS, FrozenScriptSchema, stableJson, type FrozenAction, type FrozenScript } from "./schema.ts";

// Exporting a script from run records (build brief: Freezer). The export is a view over the stored records, like the
// report: it adds nothing the records do not hold. It refuses when the case has not proved itself, and it says why.

export interface ExportInput {
  /** The run records of the case, each already read and validated. */
  runs: readonly RunRecord[];
  testCase: TestCase;
  /** The hash of the case file the runs were made with. */
  caseHash: string;
  /** How many identical passing runs a case needs (config: frozen.minPassingRuns). */
  minPassingRuns: number;
  /** 1 for a first script. */
  version: number;
  now: string;
}

export type ExportResult = { ok: true; script: FrozenScript } | { ok: false; reasons: string[] };

const ACTING = new Set<string>(FROZEN_TOOLS);

/** The acting calls of one run, per step. A failed call makes the run unusable, so the caller has already refused it. */
function actingSteps(run: RunRecord): FrozenAction[][] {
  return run.steps.map((s) => s.actions.filter((a) => ACTING.has(a.tool)).map((a) => ({ tool: a.tool as FrozenAction["tool"], args: a.args })));
}

export function exportScript(input: ExportInput): ExportResult {
  const { runs, testCase } = input;
  const reasons: string[] = [];

  if (testCase.expected.some((e) => e.kind === "judged")) {
    reasons.push("the case has a judged expected result, and a frozen script runs without a model or a judge, so it could not decide that result");
  }
  if (runs.length < input.minPassingRuns) {
    reasons.push(`${runs.length} run${runs.length === 1 ? "" : "s"} given, and the case needs ${input.minPassingRuns} identical passing runs before it counts as stable`);
  }

  for (const run of runs) {
    const label = run.run_id;
    if (run.case.id !== testCase.id) reasons.push(`${label} is a run of ${run.case.id}, not ${testCase.id}`);
    if (run.frozen !== null) reasons.push(`${label} replayed a frozen script, so it cannot prove the case stable (only runs driven by an actor can)`);
    if (run.verdict !== "PASS") reasons.push(`${label} is ${run.verdict}, and only a PASS run can be frozen`);
    // A record that contradicts itself is not evidence of anything.
    const problems = checkRecord(run);
    if (problems.length > 0) reasons.push(`${label} was rejected by the reporter's checks: ${problems.join("; ")}`);
    if (run.case.steps_total !== testCase.steps.length || run.steps.length !== testCase.steps.length) {
      reasons.push(`${label} does not have the ${testCase.steps.length} steps of the case`);
    }
    if (run.steps.some((s) => s.actions.some((a) => !a.ok))) {
      reasons.push(`${label} had a tool call that failed, so the case is not yet stable (a script would have to guess which attempt to keep)`);
    }
  }
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)] };

  const first = actingSteps(runs[0]!);
  for (const run of runs.slice(1)) {
    if (stableJson(actingSteps(run)) !== stableJson(first)) reasons.push(`${run.run_id} did not do the same actions as ${runs[0]!.run_id}, so the case is not stable yet`);
  }
  if (first.every((actions) => actions.length === 0)) reasons.push("the runs made no acting tool call, so there is nothing to replay");
  // The stored record has secrets scrubbed. A script made from it would type the marker instead of the value.
  if (stableJson(first).includes("[REDACTED")) reasons.push("an action typed a value that the redactor scrubbed (a secret typed with fill), so the script could not replay it. Secrets are entered with fill_secret");
  if (reasons.length > 0) return { ok: false, reasons };

  const script = FrozenScriptSchema.safeParse({
    schema_version: 1,
    case_id: testCase.id,
    version: input.version,
    case_hash: input.caseHash,
    frozen_at: input.now,
    source: { runs: runs.map((r) => ({ run_id: r.run_id, model_live: r.versions.model_live })), live_model: runs.every((r) => r.versions.model_live) },
    steps: first.map((actions, i) => ({ index: i + 1, actions })),
  });
  if (!script.success) return { ok: false, reasons: script.error.issues.map((i) => `${i.path.join(".") || "(script)"}: ${i.message}`) };
  return { ok: true, script: script.data };
}
