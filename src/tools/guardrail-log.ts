import type { GuardrailEvent } from "../schemas/run-record.ts";

/**
 * Collects every allowlist decision made by the tool layer. A blocked decision stops the run
 * as INCONCLUSIVE (manual: Definitions, precedence row 2), and the events go into the run record.
 */
export class GuardrailLog {
  readonly events: GuardrailEvent[] = [];

  record(event: Omit<GuardrailEvent, "at">): void {
    this.events.push({ at: new Date().toISOString(), ...event });
  }

  get blocked(): boolean {
    return this.events.some((e) => e.decision === "blocked");
  }

  blockedEvents(): GuardrailEvent[] {
    return this.events.filter((e) => e.decision === "blocked");
  }
}
