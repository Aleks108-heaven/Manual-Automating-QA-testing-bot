## Writing bot-ready test cases

A case is bot-ready when a stranger could decide pass or fail from the written expected results alone, and code can check as many of them as possible without an LLM.

**Template**

| Field | What to write |
| --- | --- |
| ID | TC-<AREA>-<NNN> |
| Title | Verb, object, condition |
| Requirement or risk | Link or ID |
| Technique | For example boundary value analysis, equivalence partitioning, decision table |
| Priority | P1 to P3 ([to fill: your definitions]) |
| Role | The user role the case runs as. The runner starts the browser from that role's stored session, so the model never sees a login. Use none for cases that test login itself |
| Preconditions | State and data, seeded through an API rather than the UI. Written as text for humans |
| Setup | The same preconditions as executable API calls, run before the case: `{call: "POST /path", body: {...}}`. Optional |
| Test data | Concrete values. Secrets appear only as references, such as secret:lock_test_01.password |
| Allowed mutations | The requests that change state which this case may trigger, as method and path, plus the GraphQL operation name where one endpoint carries many operations. Websocket sends and any GET that changes state (for example a logout link) must be listed too. The tool layer blocks every request that changes state and is not listed |
| Steps | One action per step, numbered from 1 |
| Expected results | Structured entries, one per check, each with an `id` and an `after_step` (see the next table) |
| Cleanup | Teardown steps, through an API. Written as text for humans |
| Teardown | The same cleanup as executable API calls, run after the case even when it fails. A failed teardown is reported and does not change the verdict. Optional |
| Automation notes | Known UI quirks, and whether the case is a candidate for freezing to a script |

**Expected results are structured.** Each expected result names a kind, so code can check it without an LLM. Use judged only for what cannot be asserted. Every entry also carries a plain-words description for humans and the judge.

Every entry has two more fields. `id` (for example `e1`) is unique within the case, and the actor's observations refer to it. `after_step` is the step number after which the runner evaluates the entry, waiting and retrying up to a timeout, so a message that disappears later is still caught. The runner captures the evidence at that moment. The actor does not choose it.

If the locator in `where` matches nothing, a `text_visible` or `element_state` entry gets MISMATCH, and triage routes it to the case curator when the locator is stale. A `count` entry of 0 passes when nothing matches.

| Kind | Fields | Checked by |
| --- | --- | --- |
| text_visible | where (role and name, or selector), text | Assertion |
| url | equals or matches | Assertion |
| status | request pattern, status code | Assertion on the network log |
| count | where, expected number | Assertion |
| element_state | where, state (visible, enabled, checked, and so on) | Assertion |
| judged | description only | LLM judge, citing evidence |

**Rules**

1. Prefer a structured kind. Write expected results the bot can observe: a text, an element state, a URL, a status code, a count. Use judged only when nothing can be asserted. "Works correctly" and "looks right" are not allowed.
2. One action per step, with no hidden steps.
3. State preconditions and data explicitly. Set them up through an API or seed, and use the UI only for the behavior under test.
4. Keep each case independent of other cases and of execution order.
5. For limits, write the boundary pair: just inside and just outside.
6. Never put real credentials or personal data in a case. Use secret references: the tool layer resolves them, and the model never sees a value.
7. Declare every state-changing request the case may trigger. Anything undeclared is blocked, and a block stops the run as INCONCLUSIVE (Definitions).
8. Link every case to a requirement or a risk.
9. A case needs at least one expected result, and every `after_step` must refer to an existing step.

**Weak and bot-ready expected results**

| Weak | Bot-ready |
| --- | --- |
| Page loads correctly | text_visible: the title "Orders"; status: GET /orders returns 200 |
| Order is saved | text_visible: a new row with the ID shown on the confirmation page, status "Pending", total 49.90 |
| Error is shown | text_visible: "Enter a valid email" below the email field; url: the page did not change |

**Example.** Before: "Check lockout works." After, as a YAML case:

```yaml
id: TC-AUTH-004
title: Lock account on 5th failed login
priority: P1
technique: boundary value
risk: <risk or requirement ID>
role: none                  # this case tests login itself
preconditions:
  - user lock_test_01 seeded with 4 failed attempts, via API
setup:
  - call: POST /__test/seed             # example endpoint
    body: {username: lock_test_01, failed_attempts: 4}
data:
  wrong_password: "Wrong#Pass1"
  correct_password: secret:lock_test_01.password
allowed_mutations:
  - POST /api/login         # example endpoint
steps:
  - open /login                                                  # 1
  - fill the username field with lock_test_01                    # 2
  - fill the password field with data.wrong_password             # 3
  - click the "Sign in" button                                   # 4
  - fill the password field with data.correct_password (fill_secret)  # 5
  - click the "Sign in" button                                   # 6
expected:
  - id: e1
    after_step: 4
    kind: text_visible
    where: {role: alert}
    text: "Account locked. Try again in 15 minutes."
    description: The lockout banner is shown after the 5th failed attempt
  - id: e2
    after_step: 6
    kind: text_visible
    where: {role: alert}
    text: "Account locked. Try again in 15 minutes."
    description: The banner is still shown after the correct password
  - id: e3
    after_step: 6
    kind: url
    equals: /login
    description: The user stays on the login page
  - id: e4
    after_step: 6
    kind: count
    where: {role: button, name: "Log out"}
    equals: 0
    description: No signed-in user menu is present
cleanup:
  - unlock user lock_test_01 via API
teardown:
  - call: POST /__test/reset
```

Case files live in `cases/`, one YAML file per case, named after the case ID. The working examples are `cases/TC-FORM-001.yaml`, `cases/TC-AUTH-003.yaml`, the lockout case above as `cases/TC-AUTH-004.yaml`, and `cases/TC-ACCT-001.yaml`, which runs as the role `member` with no login steps.

**Roles and secrets.** `role` names a role from the bot's configuration, or `none`. For a role, the runner logs in before the case starts and gives the browser that session, so the model never sees a login, a credential, or a session token. A secret in `data` is written as a reference, `secret:<name>`, and the model uses it only through `fill_secret`, naming the `data` key (the step text says "using fill_secret"). The runner looks the value up in the secret store and never shows it to the model. A `data` entry that is not a secret reference can be typed with a plain fill.

**How the runner checks expected results.** After each step the runner waits until the network has been quiet for a short time, then evaluates the entries whose `after_step` is that step, in the order written. A check passes as soon as it holds, so a message that appears briefly is caught. A `count` must keep holding for a short moment, so "nothing is there" is not read before a response has arrived. A check that never holds waits out the timeout and gives MISMATCH, so a case with a failing expected result takes longer to run. The timeouts are configuration.

**Judged results.** A `judged` entry has no machine check, so it goes to the judge: a separate call that never sees the actor's observations, notes or reasoning. It gets the description you wrote, and the evidence the runner captured at the entry's `after_step` (a screenshot, the page snapshot, the network log), plus the list of actions taken and the console errors. It returns MATCH, MISMATCH or NO_EVIDENCE and must cite the evidence it used. Write the description so a stranger could decide from the evidence alone, and use a structured kind whenever one can express the same check, because a structured check is exact and costs nothing. If the judge reports that the evidence tries to influence it, the result is NO_EVIDENCE, and the run is flagged for the security reviewer. Without a judge configured, judged results are NO_EVIDENCE.

**Implicit checks.** The runner also looks for things nobody wrote an expected result for: console errors, HTTP responses of 400 or more (except ones the case itself expects with a `status` entry), failed requests, images that did not load, and accessibility violations found by automated rules (once per page). They are listed in the report and the run record with the step and page where they were first seen. In version 1 they never change the verdict. They are never MATCH or MISMATCH, and they are not a substitute for an accessibility audit.

**Addressing elements.** `where` takes either `{role, name}` (the accessible role and exact accessible name) or `{selector}` (a CSS selector). Some elements have no accessible role, such as password fields, and need a selector. A locator that matches more than one element is an error for `element_state`, so make it specific.

Pair it with TC-AUTH-003, where the 4th failed attempt must not lock the account, so the boundary is covered on both sides.
