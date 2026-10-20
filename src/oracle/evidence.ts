import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../redact/redactor.ts";
import type { EvidenceRef } from "../schemas/run-record.ts";
import type { RunnerAccess } from "../tools/tool-layer.ts";

/**
 * Evidence is captured by the runner at the moment an expected result is checked. The actor does
 * not choose it (manual: Definitions, "Who decides a verdict"). It is scrubbed before it is written:
 * screenshots cover password and filled-secret fields, text files have secrets and tokens replaced.
 */
export interface EvidenceSink {
  capture(expectedRef: string, step: number): Promise<EvidenceRef[]>;
  all(): readonly EvidenceRef[];
}

export class FileEvidenceSink implements EvidenceSink {
  private readonly refs: EvidenceRef[] = [];
  private readonly runDir: string;
  private readonly access: RunnerAccess;
  private readonly redactor: Redactor;

  constructor(runDir: string, access: RunnerAccess, redactor: Redactor) {
    this.runDir = runDir;
    this.access = access;
    this.redactor = redactor;
    mkdirSync(join(runDir, "evidence"), { recursive: true });
  }

  async capture(expectedRef: string, step: number): Promise<EvidenceRef[]> {
    const made: EvidenceRef[] = [];
    const add = (kind: EvidenceRef["kind"], file: string) => {
      made.push({ id: `ev-${expectedRef}-${kind}`, kind, path: `evidence/${file}`, step, expected_ref: expectedRef });
    };
    try {
      const page = this.access.page();
      writeFileSync(join(this.runDir, "evidence", `${expectedRef}-screenshot.png`), await this.access.screenshot());
      add("screenshot", `${expectedRef}-screenshot.png`);
      const snapshot = `${this.redactor.scrubUrl(page.url())}\n\n${await page.locator("body").ariaSnapshot()}`;
      writeFileSync(join(this.runDir, "evidence", `${expectedRef}-snapshot.txt`), this.redactor.scrubText(snapshot));
      add("snapshot", `${expectedRef}-snapshot.txt`);
      // Network entries are already scrubbed when they are recorded. The whole file is scrubbed again as well.
      const network = this.access.network().filter((n) => n.step <= step).slice(-50);
      writeFileSync(join(this.runDir, "evidence", `${expectedRef}-network.json`), this.redactor.scrubText(JSON.stringify(network, null, 2)));
      add("network", `${expectedRef}-network.json`);
    } catch {
      // Whatever was captured before the failure stays. If nothing was, the result gets NO_EVIDENCE.
    }
    this.refs.push(...made);
    return made;
  }

  all(): readonly EvidenceRef[] {
    return this.refs;
  }
}
