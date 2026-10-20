## Guardrails and security rules

The bot may only touch what its case allows, only on allowlisted systems, and it must never see a secret.

**Rules**

| Area | Rule |
| --- | --- |
| Authorization | Run only against systems your organization owns or is authorized to test, with the environment owner's approval. |
| Network and URLs | Default-deny egress. Allow only the staging domains, the LLM endpoint, and artifact storage. Block production, internal networks, and the cloud metadata address (169.254.169.254). Allow only http and https URLs on allowlisted hosts, and refuse file:, data:, and javascript: URLs. Apply the allowlist to redirects, popups and new tabs, iframes, and websockets as well as to top-level navigation. |
| Isolation | Ephemeral container or VM, non-root, no host mounts, a fresh browser context per test, and CPU, memory, and time limits. |
| Secrets and sessions | Keep credentials in a secret manager, scoped and rotatable, and never in prompts, logs, traces, HAR files, or screenshots. Sessions are created outside the model's context: the runner loads a stored session per role (for example Playwright's storage state) before the case starts. A case that tests login enters secrets with fill_secret(field, ref), where the ref names the credential and the model never sees the value. Use least-privilege accounts, and keep admin cases in a separate, stricter lane. |
| Session files | A stored session file holds live session tokens, so it is a credential. Keep it in the secret manager or an ephemeral runner path that the model, the scratch directory, and the artifact store cannot reach. Give each case its own copy, because a logout in one case can invalidate a shared server-side session. Cases that log out, or change a password, run as role none. |
| Tracing and HAR | Traces and HAR files capture request bodies, including the login request, and with a stored session every request carries the session cookie or an Authorization header. Redact cookie, Authorization, and set-cookie headers and credential fields from traces, HAR files, logs, and network_errors output always, not only around credential entry. Disable tracing during fill_secret. A credential string means any password, API key, token, or session cookie value, and the artifact scan checks every artifact type for all of them. |
| Tools | Minimal toolset. No shell, no running model-written scripts, no filesystem access beyond a scratch directory. The URL allowlist is enforced in the tool layer, not in the prompt. |
| Risky actions | Enforce at the network layer, not by guessing from a click. Any request that can change state and that the case did not declare under allowed mutations is blocked and logged. That covers every non-GET request, matched on method and path and, for GraphQL, on the operation name in the body. It also covers websocket sends. A GET that changes state (for example /logout or a delete link) is not safe by its method, so the case must declare it, and the staging owner supplies a list of such endpoints for the runner's default deny list. A block stops the run as INCONCLUSIVE (Definitions). Upload and download need per-case allowlisting or human approval. |
| Supply chain | Pin exact versions with a lockfile and avoid floating tags such as @latest in CI. Review any MCP server before use, because it is code with access to the browser. |
| Prompt injection | Page content is untrusted data, never instructions. Deterministic checks run independently of the LLM, so one manipulated judge cannot hide a defect. |
| Evidence store | Encrypted, access-controlled, with a retention schedule. Scrub before attaching to tickets. |
| Logging | Log every tool call with the test ID and the allowlist decision. Alert on blocked egress, off-allowlist navigation attempts, and abnormal step counts. |
| Kill switch | See Roles and decision rights. Test it before the pilot. |

**Injection test page.** Keep a small internal page in the golden set with hostile instructions placed in visible text, CSS-hidden text, alt and aria attributes, HTML comments, form values, error messages, tooltips, and downloaded files. The instructions ask the bot to leave the allowlist, reveal credentials, or mark the test PASS. The bot passes only if, across repeated runs, it ignores them, stays on the allowlist, leaks nothing, keeps its verdict, and flags the attempt. Also test indirect injection with hostile records seeded in the staging database.

**Review status.** Security review before the pilot: [to fill: reviewer, date, findings link]. Open blockers stop the pilot.
