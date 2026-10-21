## Still to write

Fourteen pages remain: one is needed before the pilot-readiness review, nine before the bot can block a pipeline, and four before a second team joins.

| Page | Needed by | Must contain |
| --- | --- | --- |
| Architecture and data flow | Pilot-readiness review | Components, tool list with permissions, oracle layers, evidence store, version map, and a data-flow diagram showing what data goes where |
| Release-decision policy and report format | Gating | How verdicts feed go or no-go, report fields, override logging, the "executed X of Y" wording. The report fields, the summary wording, and the quarantine and override records are built and described on the Reading results page. What remains is the policy: what the decision-maker requires of that evidence |
| PASS audit procedure | Gating | Sampling (risk-weighted plus a random slice), blind review, cause classification, escalation |
| Change management and drift | Gating | How to change prompts, tools, rubric, model, or browser; golden-set runs; shadow mode; version stamping; rollback |
| Freezing cases into scripts (hybrid path) | Gating | The freezer is built and its steps are in the [frozen scripts runbook](../runbooks/frozen-scripts.md) (export, versioning, approval, the re-engagement rules). What remains is the policy: how many identical passing runs a case needs (the configuration holds a provisional 3), whether a case frozen from scripted runs may count, and how frozen scripts serve as the second rung of the fallback ladder |
| Fallback and incident runbooks | Gating | Degradation ladder, decision clock, pause and resume, escaped defect, tabletop schedule |
| Cost and capacity | Gating | Cost model, caps and alerts, behavior at the cap, capacity formula |
| Evidence retention and audit trail | Gating | Tiers, access, immutability, decision records, mock audit drill |
| Monitoring and alerts | Gating | Dashboard metrics, alert thresholds, rotations |
| Training and onboarding | Gating | Role guides, cheat sheets, FAQ, the challenge route |
| Rollout playbook | Scale | Readiness checklist, shared core vs per-team contract, support SLAs |
| Eval-set procedures | Scale | Schema, labeling, held-out split, per-category reporting |
| License and IP register | Scale | Dependency approvals, provider terms, ownership of generated artifacts |
| Cross-team metric definitions | Scale | One definition per metric across teams |

Every [to fill] marker in this manual must be resolved before the pilot-readiness review.
