## Data handling rules

Only synthetic or masked data reaches the LLM provider, and nothing is stored longer than its tier allows. This page is a checklist for your compliance team, not legal advice, and the retention periods are theirs to set.

**What the bot sees and stores.** Classify each item as synthetic, masked, personal, or regulated or confidential: page text and snapshots, screenshots, console and network logs, traces and HAR files, prompt and output logs, and bug-draft text.

| Data class | May go to the LLM provider? | Handling |
| --- | --- | --- |
| Synthetic | Yes, after vendor review | Normal retention |
| Masked | Yes, once masking is verified | Redaction layer: mask text and blur screenshots before sending |
| Personal | Only with approval from [to fill: compliance owner] | Restricted pages, zero-retention terms |
| Regulated or confidential | No | Self-hosted or in-VPC model, or scripted tests without an LLM |

**Provider register.** For each LLM provider, record the answers and the version of the terms you reviewed in [to fill: register location]:

- Is our data used for training?
- What is the retention period, and is a zero-retention option available?
- Where is the data processed?
- Who are the sub-processors?
- Is a contract or data processing agreement in place?
- What access controls and audit logs exist?

A standby provider for failover needs its own review before it is ever used.

**Evidence tiers**

| Tier | Contents | Retention |
| --- | --- | --- |
| Release record | Summary report, verdicts, versions, approvals, overrides, decision records | [to fill: compliance] |
| FAIL evidence | Traces, videos, HAR files, screenshots | Until the fix is verified, plus [to fill] |
| PASS evidence | Screenshots at expected-result checks | [to fill: short], plus audit samples |
| Bot logs | Prompts, outputs, tool calls | [to fill], redacted |
| Versions and config | Model ID, prompt hash, rubric, browser, app build | Kept with the release record |

**Rules**

- Redact before long-term storage.
- Credentials never appear in prompts or evidence.
- Scrub traces and HAR files before sharing them.
- Delete at the end of the retention period, with a legal-hold override.
- Which rules apply depends on where your users and data are, so ask compliance before the pilot.
