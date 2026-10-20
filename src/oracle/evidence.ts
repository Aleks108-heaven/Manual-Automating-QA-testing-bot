import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceRef } from "../schemas/run-record.ts";
import type { RunnerAccess } from "../tools/tool-layer.ts";

/**
 * Evidence is captured by the runner at the moment an expected result is checked. The actor does
 * not choose it (manual: Definitions, "Who decides a verdict").
 */
export interface EvidenceSink {
  capture(expectedRef: string, step: number): Promise<EvidenceRef[]>;
  all(): readonly EvidenceRef[];
}

export class FileEvidenceSink implements EvidenceSink {
  private readonly refs: EvidenceRef[] = [];
  private readonly runDir: string;
  private readonly access: RunnerAccess;

  constructor(runDir: string, access: RunnerAccess) {
    this.runDir = runDir;
    this.access = access;
    mkdirSync(join(runDir, "evidence"), { recursive: true });
  }

  async capture(expectedRef: string, step: number): Promise<EvidenceRef[]> {
    const made: EvidenceRef[] = [];
    const add = (kind: EvidenceRef["kind"], file: string) => {
      const ref: EvidenceRef = { id: `ev-${expectedRef}-${kind}`, kind, path: `evidence/${file}`, step, expected_ref: expectedRef };
      made.push(ref);
    };
    try {
      const page = this.access.page();
      writeFileSync(join(this.runDir, "evidence", `${expectedRef}-screenshot.png`), await page.screenshot());
      add("screenshot", `${expectedRef}-screenshot.png`);
      writeFileSync(join(this.runDir, "evidence", `${expectedRef}-snapshot.txt`), `${page.url()}\n\n${await page.locator("body").ariaSnapshot()}`);
      add("snapshot", `${expectedRef}-snapshot.txt`);
      const network = this.access.network().filter((n) => n.step <= step).slice(-50);
      writeFileSync(join(this.runDir, "evidence", `${expectedRef}-network.json`), JSON.stringify(network, null, 2));
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
