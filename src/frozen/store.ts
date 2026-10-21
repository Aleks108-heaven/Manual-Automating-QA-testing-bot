import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "../config.ts";
import { READ_LIMITS, readTextCapped, TooLargeError } from "../safe-read.ts";
import { FrozenRegisterSchema, FrozenScriptSchema, hashText, ProposalSchema, serializeScript, type FrozenRegister, type FrozenScript, type Proposal, type RegisterEntry } from "./schema.ts";

// Where scripts live and who approved them (manual: Guardrails, "Frozen scripts"). A script runs only if it is in the
// register and the file still has the hash the register holds, and the case file still has the hash the script was frozen
// from. A person approves every script and every change: nothing here approves anything by itself.

export class FrozenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrozenError";
  }
}

export interface ApprovedScript {
  script: FrozenScript;
  entry: RegisterEntry;
  scriptHash: string;
  caseHash: string;
}

/** Reads and parses a JSON file the bot wrote earlier. Anything wrong with it is a FrozenError that says what, never a stack trace. */
function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readTextCapped(path, READ_LIMITS.small, what);
  } catch (error) {
    throw new FrozenError(error instanceof TooLargeError ? error.message : `${what} at ${path} could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FrozenError(`${what} at ${path} is not valid JSON`);
  }
}

export function loadFrozenRegister(path: string): FrozenRegister {
  if (!existsSync(path)) return { schema_version: 1, scripts: [] };
  const parsed = FrozenRegisterSchema.safeParse(readJson(path, "the register"));
  if (!parsed.success) throw new FrozenError(`the register at ${path} is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return parsed.data;
}

function activeEntry(register: FrozenRegister, caseId: string): RegisterEntry | null {
  const versions = register.scripts.filter((s) => s.case_id === caseId);
  return versions.length === 0 ? null : versions.reduce((a, b) => (b.version > a.version ? b : a));
}

/** True when `file` is inside `directory`. A register that points outside the scripts folder is refused, so it cannot make the bot read some other file. */
function isInside(directory: string, file: string): boolean {
  const rel = relative(resolve(directory), resolve(file));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Finds the approved script for a case and checks it. Throws FrozenError with the reason when it must not run:
 * no approval, a file outside the scripts folder or missing, a script whose hash changed, or a case that changed
 * since the script was approved.
 */
export function loadApprovedScript(args: { register: FrozenRegister; caseId: string; caseText: string; stepsInCase: number; scriptsDirectory: string }): ApprovedScript {
  const entry = activeEntry(args.register, args.caseId);
  if (!entry) throw new FrozenError(`${args.caseId} has no approved frozen script, so it does not run as one`);
  if (!isInside(args.scriptsDirectory, entry.file)) throw new FrozenError(`the register points to ${entry.file}, which is not inside ${args.scriptsDirectory}, so it does not run`);
  if (!existsSync(entry.file)) throw new FrozenError(`the approved script ${entry.file} is missing`);
  let text: string;
  try {
    text = readTextCapped(entry.file, READ_LIMITS.small, "the script");
  } catch (error) {
    throw new FrozenError(error instanceof TooLargeError ? error.message : `the script ${entry.file} could not be read`);
  }
  const scriptHash = hashText(text);
  if (scriptHash !== entry.script_hash) {
    throw new FrozenError(`the script ${entry.file} has changed since ${entry.approved_by} approved it on ${entry.approved_on} (its hash is not the registered one), so it does not run. A person must approve the change`);
  }
  const caseHash = hashText(args.caseText);
  if (caseHash !== entry.case_hash) {
    throw new FrozenError(`the case ${args.caseId} has changed since the script was approved, so the script may no longer test what the case says. Freeze and approve it again`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new FrozenError(`the script ${entry.file} is not valid JSON`);
  }
  const parsed = FrozenScriptSchema.safeParse(json);
  if (!parsed.success) throw new FrozenError(`the script ${entry.file} is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  const script = parsed.data;
  if (script.case_id !== args.caseId || script.version !== entry.version || script.case_hash !== entry.case_hash) {
    throw new FrozenError(`the script ${entry.file} does not match its register entry (case, version or case hash)`);
  }
  if (script.steps.length !== args.stepsInCase) throw new FrozenError(`the script has ${script.steps.length} steps and the case has ${args.stepsInCase}`);
  return { script, entry, scriptHash, caseHash };
}

export function scriptsDirectory(config: Config): string {
  return join(config.frozen.directory, "scripts");
}

export function scriptPath(config: Config, caseId: string, version: number): string {
  return join(scriptsDirectory(config), `${caseId}.v${version}.json`);
}

export function draftPath(config: Config, caseId: string, version: number): string {
  return join(config.frozen.directory, "drafts", `${caseId}.v${version}.json`);
}

/** The next version number for a case. */
export function nextVersion(register: FrozenRegister, caseId: string): number {
  return (activeEntry(register, caseId)?.version ?? 0) + 1;
}

/** Writes a file so that a reader sees the old content or the new content, never half of it. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/** Runs `work` while holding the register's lock file, so two approvals cannot interleave. A stale lock has to be removed by a person. */
function withRegisterLock<T>(config: Config, work: () => T): T {
  const lock = `${config.frozen.registerFile}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    throw new FrozenError(`another approval is in progress (${lock} exists). If none is, a person removes the lock file`);
  }
  try {
    return work();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

/** Writes a script that nobody has approved yet. A draft is not in the register, so it cannot run. */
export function writeDraft(config: Config, script: FrozenScript): string {
  const path = draftPath(config, script.case_id, script.version);
  writeAtomic(path, serializeScript(script));
  return path;
}

/** Reads a draft a person is about to approve. */
export function readFrozenScript(path: string): FrozenScript {
  if (!existsSync(path)) throw new FrozenError(`there is no script at ${path}`);
  const parsed = FrozenScriptSchema.safeParse(readJson(path, "the script"));
  if (!parsed.success) throw new FrozenError(`the script at ${path} is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return parsed.data;
}

export function requireApprover(config: Config, by: string): void {
  if (by.trim() === "") throw new FrozenError("--by <name> is required: a person approves a script");
  if (!config.release.approvers.includes(by)) {
    throw new FrozenError(`${by} is not a configured approver (release.approvers), so ${by} cannot approve a frozen script${config.release.approvers.length === 0 ? ". No approver is configured yet" : ""}`);
  }
}

/** Registers a script that a person approved: copies it to its permanent file and records its hash. */
export function approveScript(args: { config: Config; script: FrozenScript; caseText: string; by: string; today: string; reason: string }): RegisterEntry {
  const { config, script } = args;
  requireApprover(config, args.by);
  return withRegisterLock(config, () => {
    const register = loadFrozenRegister(config.frozen.registerFile);
    if (hashText(args.caseText) !== script.case_hash) throw new FrozenError(`the case file given is not the one ${script.case_id} was frozen from (its hash differs: the case changed, or this is another file). Freeze it again, or pass the right file with --case`);
    const expected = nextVersion(register, script.case_id);
    if (script.version !== expected) throw new FrozenError(`${script.case_id} is at version ${expected - 1}, so the next script must be version ${expected}, not ${script.version}`);
    const file = scriptPath(config, script.case_id, script.version);
    const text = serializeScript(script);
    // A file with no register entry is left over from an approval that stopped half way. The same content may be finished; other content is never overwritten.
    if (existsSync(file) && hashText(readFileSync(file, "utf8")) !== hashText(text)) throw new FrozenError(`${file} already exists with other content. A registered script is never overwritten`);
    writeAtomic(file, text);
    const entry: RegisterEntry = {
      case_id: script.case_id,
      version: script.version,
      file,
      script_hash: hashText(text),
      case_hash: script.case_hash,
      approved_by: args.by,
      approved_on: args.today,
      reason: args.reason,
    };
    writeAtomic(config.frozen.registerFile, `${JSON.stringify(FrozenRegisterSchema.parse({ ...register, scripts: [...register.scripts, entry] }), null, 2)}\n`);
    return entry;
  });
}

export function readProposal(path: string): Proposal {
  if (!existsSync(path)) throw new FrozenError(`there is no proposal at ${path}`);
  const parsed = ProposalSchema.safeParse(readJson(path, "the proposal"));
  if (!parsed.success) throw new FrozenError(`the proposal at ${path} is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return parsed.data;
}

/** Writes a proposal into a run directory. */
export function writeProposal(runDir: string, proposal: Proposal): string {
  const file = "proposal.json";
  writeAtomic(join(runDir, file), `${JSON.stringify(ProposalSchema.parse(proposal), null, 2)}\n`);
  return file;
}

/**
 * Turns a proposal a person approved into the next script version. The proposal must be for the script that is active
 * now (same version and hash), and it replaces the actions of exactly one step. The result is registered like any script.
 */
export function approveProposal(args: { config: Config; proposal: Proposal; caseText: string; stepsInCase: number; by: string; today: string }): RegisterEntry {
  const { config, proposal } = args;
  requireApprover(config, args.by);
  const active = loadApprovedScript({
    register: loadFrozenRegister(config.frozen.registerFile),
    caseId: proposal.case_id,
    caseText: args.caseText,
    stepsInCase: args.stepsInCase,
    scriptsDirectory: scriptsDirectory(config),
  });
  if (active.entry.version !== proposal.script_version || active.scriptHash !== proposal.script_hash) {
    throw new FrozenError(`the proposal is for ${proposal.case_id} version ${proposal.script_version}, which is not the active script (version ${active.entry.version}), so it is stale`);
  }
  const step = proposal.proposal.step;
  if (!active.script.steps.some((s) => s.index === step)) throw new FrozenError(`the script has no step ${step}`);
  const next = FrozenScriptSchema.parse({
    ...active.script,
    version: active.script.version + 1,
    frozen_at: `${args.today}T00:00:00.000Z`,
    steps: active.script.steps.map((s) => (s.index === step ? { ...s, actions: proposal.proposal.actions } : s)),
  });
  return approveScript({ config, script: next, caseText: args.caseText, by: args.by, today: args.today, reason: `proposal from run ${proposal.run_id} for step ${step}, approved by a person (${proposal.proposal.rationale})` });
}
