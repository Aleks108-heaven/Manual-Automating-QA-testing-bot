import type { GuardrailEvent } from "../schemas/run-record.ts";

/**
 * Collects every allowlist decision made by the tool layer. A blocked decision stops the run
 * as INCONCLUSIVE (manual: Definitions, precedence row 2), and the events go into the run record.
 * URLs and details pass through the scrubber first, so a token in a blocked URL is never stored.
 */
export class GuardrailLog {
  readonly events: GuardrailEvent[] = [];
  private readonly scrubUrl: (text: string) => string;
  private readonly scrubText: (text: string) => string;

  constructor(scrubUrl: (text: string) => string = (t) => t, scrubText: (text: string) => string = (t) => t) {
    this.scrubUrl = scrubUrl;
    this.scrubText = scrubText;
  }

  record(event: Omit<GuardrailEvent, "at">): void {
    this.events.push({ at: new Date().toISOString(), ...event, url: this.scrubUrl(event.url), detail: this.scrubText(event.detail) });
  }

  get blocked(): boolean {
    return this.events.some((e) => e.decision === "blocked");
  }

  blockedEvents(): GuardrailEvent[] {
    return this.events.filter((e) => e.decision === "blocked");
  }
}
