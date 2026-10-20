// The kill switch (manual: Roles and decision rights). One person can pause the bot at any time without asking
// anyone. Engaging it writes the paused state first, so running runs stop and new runs refuse to start, and then
// revokes the runner's credentials: its private session files, and whatever the configuration lists (on the
// fixture, a test endpoint that ends all sessions and disables the bot accounts). Resuming needs a named reviewer,
// a fix reference, and a clean pre-flight report that is newer than the engagement. Every action is written to an
// append-only audit log, including the ones that were refused.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../config.ts";
import { PreflightReportSchema } from "../preflight/report.ts";
import type { Call } from "../schemas/case.ts";

export class KillSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KillSwitchError";
  }
}

/** Thrown when a run is asked to start while the switch is engaged. */
export class RunnerPausedError extends KillSwitchError {
  constructor(state: KillSwitchState) {
    super(`The runner is paused by the kill switch (engaged ${state.engaged_at ?? "earlier"} by ${state.engaged_by ?? "someone"}: ${state.reason ?? "no reason recorded"}). Resume it first.`);
    this.name = "RunnerPausedError";
  }
}

export interface RevokeResult {
  session_files_removed: number;
  calls: Array<{ call: string; ok: boolean; detail: string }>;
}

export interface KillSwitchState {
  paused: boolean;
  engaged_at?: string;
  engaged_by?: string;
  reason?: string;
  revoked?: RevokeResult;
  resumed_at?: string;
  resumed_by?: string;
}

/** What the runner asks. Kept tiny so the agent loop does not depend on the files. */
export interface PauseSource {
  isPaused(): boolean;
}

export interface KillSwitchOptions {
  config: Config;
  targetOrigin: string;
  now?: () => Date;
}

export class KillSwitch implements PauseSource {
  private readonly config: Config;
  private readonly targetOrigin: string;
  private readonly now: () => Date;

  constructor(options: KillSwitchOptions) {
    this.config = options.config;
    this.targetOrigin = options.targetOrigin;
    this.now = options.now ?? (() => new Date());
  }

  private get stateFile(): string {
    return this.config.killSwitch.stateFile;
  }

  status(): KillSwitchState {
    if (!existsSync(this.stateFile)) return { paused: false };
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as KillSwitchState;
    } catch {
      // A state file that cannot be read is treated as engaged. Failing closed is the safe direction.
      return { paused: true, reason: "the kill-switch state file is unreadable", engaged_by: "unknown" };
    }
  }

  isPaused(): boolean {
    return this.status().paused;
  }

  private write(state: KillSwitchState): void {
    mkdirSync(dirname(resolve(this.stateFile)), { recursive: true });
    const temp = `${this.stateFile}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(state, null, 2));
    renameSync(temp, this.stateFile); // atomic on the same volume, so a runner never reads half a file
  }

  private audit(entry: Record<string, unknown>): void {
    mkdirSync(dirname(resolve(this.config.killSwitch.auditLog)), { recursive: true });
    appendFileSync(this.config.killSwitch.auditLog, `${JSON.stringify({ at: this.now().toISOString(), ...entry })}\n`);
  }

  private async callTarget(call: Call): Promise<{ call: string; ok: boolean; detail: string }> {
    const [method, path] = call.call.split(" ") as [string, string];
    try {
      const response = await fetch(this.targetOrigin + path, {
        method,
        headers: { "content-type": "application/json", ...this.config.testApi.headers },
        ...(call.body && method !== "GET" ? { body: JSON.stringify(call.body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
      return { call: call.call, ok: response.ok, detail: `answered ${response.status}` };
    } catch (error) {
      return { call: call.call, ok: false, detail: `failed: ${(error as Error).name}` };
    }
  }

  private removeSessionFiles(): number {
    const dir = resolve(this.config.sessions.directory);
    if (!existsSync(dir)) return 0;
    let removed = 0;
    for (const name of readdirSync(dir)) {
      rmSync(join(dir, name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  /** Pauses the runner and revokes its credentials. Safe to call again: a second call changes nothing. */
  async engage(args: { by: string; reason: string }): Promise<KillSwitchState> {
    const by = args.by.trim();
    const reason = args.reason.trim();
    if (!by) throw new KillSwitchError("Say who is engaging the kill switch (--by).");
    if (!reason) throw new KillSwitchError("Say why (--reason). The reason goes in the audit log.");
    const holders = this.config.killSwitch.holders;
    if (holders.length > 0 && !holders.includes(by)) {
      this.audit({ action: "engage-refused", by, reason, why: "not a kill-switch holder" });
      throw new KillSwitchError(`${by} is not a kill-switch holder (${holders.join(", ")}).`);
    }
    const existing = this.status();
    if (existing.paused) {
      this.audit({ action: "engage-ignored", by, reason, why: "already engaged" });
      return existing;
    }

    // The paused state comes first, so that every running run stops before anything else happens.
    const state: KillSwitchState = { paused: true, engaged_at: this.now().toISOString(), engaged_by: by, reason };
    this.write(state);
    this.audit({ action: "engage", by, reason });

    const revoked: RevokeResult = { session_files_removed: this.removeSessionFiles(), calls: [] };
    for (const call of this.config.killSwitch.revokeCalls) {
      const result = await this.callTarget(call);
      revoked.calls.push(result);
      this.audit({ action: "revoke", call: result.call, ok: result.ok, detail: result.detail });
    }
    const final = { ...state, revoked };
    this.write(final);
    return final;
  }

  /**
   * Resumes the runner. Needs the three things the manual names: a completed review, a verified fix, and a clean run.
   * Until the golden set exists (M5) the clean run is a pre-flight report in which every check passed, written after
   * the switch was engaged.
   */
  async resume(args: { by: string; review: string; fix: string; preflightReport: string }): Promise<KillSwitchState> {
    const refuse = (why: string): never => {
      this.audit({ action: "resume-refused", by: args.by, review: args.review, fix: args.fix, why });
      throw new KillSwitchError(`Cannot resume: ${why}`);
    };
    const state = this.status();
    if (!state.paused) return refuse("the kill switch is not engaged");
    if (!args.by.trim()) return refuse("say who is resuming (--by)");
    if (!args.review.trim()) return refuse("a completed review is required (--review <reference>)");
    if (!args.fix.trim()) return refuse("a verified fix is required (--fix <reference>)");
    if (!args.preflightReport.trim() || !existsSync(args.preflightReport)) return refuse("a clean pre-flight report is required (--preflight-report <file>), and that file does not exist");

    let report;
    try {
      report = PreflightReportSchema.parse(JSON.parse(readFileSync(args.preflightReport, "utf8")));
    } catch {
      return refuse("the pre-flight report is not a valid report");
    }
    if (!report.ok || report.checks.some((c) => c.status !== "passed")) return refuse("the pre-flight report is not clean: every check must have passed, and none may be skipped");
    if (state.engaged_at && Date.parse(report.at) <= Date.parse(state.engaged_at)) return refuse("the pre-flight report is older than the engagement, so it does not show that the problem is fixed");

    // Restore the credentials before the runner is allowed to run. If this fails, the runner stays paused.
    const restored = [];
    for (const call of this.config.killSwitch.restoreCalls) {
      const result = await this.callTarget(call);
      restored.push(result);
      this.audit({ action: "restore", call: result.call, ok: result.ok, detail: result.detail });
      if (!result.ok) return refuse(`restoring access failed (${result.call} ${result.detail}). The runner stays paused`);
    }

    const next: KillSwitchState = { paused: false, resumed_at: this.now().toISOString(), resumed_by: args.by.trim() };
    this.write(next);
    this.audit({ action: "resume", by: args.by.trim(), review: args.review.trim(), fix: args.fix.trim(), preflight_report: args.preflightReport });
    return next;
  }
}
