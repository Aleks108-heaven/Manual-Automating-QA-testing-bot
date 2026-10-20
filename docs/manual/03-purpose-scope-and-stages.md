## Purpose, scope and stages

The bot takes over repeatable, high-risk, stable checks and leaves judgment-heavy testing to people, and its authority grows only when evidence says it has earned it.

**Purpose.** Run written test cases at the pace of releases, with evidence for every verdict, so defects surface early and testers spend their time on test design and exploratory work.

**Hybrid path.** A case that proves stable is frozen into a deterministic script and run without an LLM. This is the main lever on cost, flakiness, and determinism, and it is the second rung of the fallback ladder. Three rules stop it from hiding defects:

- A failed assertion in a frozen script is a FAIL, and it stays a FAIL. The agent never re-runs the case to turn it into a PASS.
- The agent re-engages only when a script step cannot run (a locator is stale, an element has moved), and then only to diagnose it and propose a script change.
- A human approves every change to a frozen script, and the script is versioned and stamped in the report.

**What the bot takes over**

| Candidate | Decision |
| --- | --- |
| Smoke tests and critical journeys (login, checkout) | Bot first |
| Form validation and boundary checks | Bot, with deterministic assertions |
| Calculations, business rules, API contracts | Not through the UI: use unit and API tests |
| Time-boxed exploratory sessions | Bot proposes, a human triages |
| Usability and look-and-feel judgment | Stays manual |
| Captcha, hardware, real payments or email | Stub, or stay manual |

**Non-goals.** The bot is not a release sign-off. It does not replace performance testing, security testing, accessibility audits, or real-device checks. It never runs against production or against systems you are not authorized to test.

**What a green run does not cover**

| Attribute | What the bot adds | Covered by |
| --- | --- | --- |
| Performance | Spots obvious slowness and timeouts only | [to fill: tool and owner] |
| Security | Implicit signals such as stack traces and error leaks | [to fill: scans, pen tests] |
| Accessibility | Automated rule checks, which catch only part of the issues | [to fill: manual audit] |
| Usability | Little | [to fill: reviews, user research] |
| Compatibility | Frozen scripts across browsers and viewports, later | [to fill: real-device checks] |

**Stages.** The bot moves through three stages, one at a time, and each stage change needs a review.

| Stage | Bot's authority | Humans still | Advance when |
| --- | --- | --- | --- |
| 1. Advisory | Reports only, never blocks | Run the full manual regression | Pilot gates met and PASS audits clean |
| 2. Gating subset | A FAIL on designated P1 smoke cases blocks the pipeline pending triage | Run manual regression and review non-gating results | Gates hold for [to fill: N] consecutive releases |
| 3. Partial replacement | Replaces manual execution of proven cases | Exploratory, usability, new features, ongoing PASS audits | Sustained results and stakeholder sign-off |

Current stage: **1. Advisory** (pilot not yet started).
