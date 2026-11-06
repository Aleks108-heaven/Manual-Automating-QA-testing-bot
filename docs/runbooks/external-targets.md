# Runbook: testing a site of your own (external targets)

By default the bot tests only the local fixture site. This page is how a person adds a site of their own, for example a staging site or a dev server, in one controlled way. It is off until you turn it on, and it is built so that a mistake fails closed.

**Test only a site that you own or that its owner has allowed you to test.** A public site such as a search engine or a shop that is not yours has terms of use, bot protection and legal limits, and the bot does not check any of that. A production site needs the approval of the environment owner (manual: Guardrails and security rules, Authorization).

## Turn it on

Two things are needed, and the configuration refuses to load with only one:

1. **The exact origins** the bot may test: `https://host` or `https://host:port`. Over plain `http` only a site on this machine is allowed (`http://localhost:3000`, `http://127.0.0.1:8080`). No path, no query, no wildcard, no user name in it. Private, link-local and reserved addresses (`10.x`, `192.168.x`, `172.16-31.x`, `169.254.x` where cloud metadata lives, `100.64-127.x`, `fc00::/7`, `fe80::/10`) are refused.
2. **A statement of who allows the test**, and where that is recorded: for example `Your Name, owner of shop.example.com, ticket QA-12, 6 Nov 2026`. The bot cannot check that it is true. It writes it into the pre-flight report of every run, so a report always says who said the test was allowed.

Use environment variables, so that the statement and the origins are not committed to the repository (it is public):

```powershell
$env:QA_EXTERNAL_ORIGINS = "https://shop.example.com"
$env:QA_EXTERNAL_ATTESTATION = "Your Name, owner of shop.example.com, ticket QA-12, 6 Nov 2026"
```

(The same settings are `targets.external` in `config/default.json`: `origins`, `attestation`, `allowMutations`.)

## Run

```powershell
node src/cli.ts run cases/TC-MYSHOP-001.yaml --live --model <id> --target https://shop.example.com
```

The command says `External target ...` and who attested to it. Before the case it runs the canary pair as always, but on **a local fixture site that it starts for the purpose**: the canary cases send requests that change state, and they never touch your site. Then the case runs on your site.

Write the case with paths relative to the origin (`open /`, `open /search?q=cats`). A search case is the typical example; see [writing and running cases](writing-and-running-cases.md) and the worked examples `cases/TC-SRCH-001.yaml` to `003` (they run on the fixture, and the same shape works on your site):

```yaml
id: TC-MYSHOP-001
title: Search finds the item
priority: P2
role: none
data:
  query: "notebook"
steps:
  - open /
  - fill the Search field with data.query
  - click the Search button
expected:
  - id: e1
    after_step: 3
    kind: url
    equals: "/find?q=notebook"
    description: The address shows the query
  - id: e2
    after_step: 3
    kind: text_visible
    where: {role: status}
    text: "3 results"
    exact: true
    description: The number of results is shown
```

Check it first with `node src/cli.ts cases cases/TC-MYSHOP-001.yaml`, and prove it can fail with `--negative-control` (this checks the case, and the negative control runs on your site like any case, so it is read-only too).

## What the bot does for safety

| Protection | How |
| --- | --- |
| Only listed origins | The target must be one of them. The allowlist is worked out **for each run from its target**: an external run may reach the listed origins and nothing else, each with its port, in code in the tool layer and by the browser's own host rule. A run on the fixture (and the canary pair) never gets a listed external origin, so a case or an injected link there cannot reach your site without the rules for external targets. A page that links to another host, or a model that tries to open one, is blocked and the run is INCONCLUSIVE. |
| Read-only by default | A case that declares `allowed_mutations` is not run (it is listed as not executed, with the reason). Anything the case did not declare is blocked as always. The owner of the bot can allow declared mutations with `QA_EXTERNAL_ALLOW_MUTATIONS=1`. |
| No credentials | A case with a signed-in `role`, with a `secret:` value in its data, or with `setup` or `teardown` calls (they go to the fixture's test API) is not run on an external target. The bot has no secret manager for a real site yet. |
| Nothing unrequested | The site is asked only for what the steps ask. No `/health` request before or after the run, and the kill switch's calls (which are the fixture's) are never sent to it. |
| The canary never touches it | The canary pair runs on a local fixture site. |
| The report says so | The header of the report (`report.txt` and `report.json`, and so what the MCP server returns) has a `TARGET` line with the origin and the statement of who attested. The pre-flight report has a `target is allowed` check with the same, and `target healthy` and `build is the expected one` are shown as skipped, never as passed. A report that is rebuilt later from run records (`node src/cli.ts report`) does not carry that line, so keep the original report. |
| Logins stay on the fixture | The pre-flight check of the canary cases' roles logs in on the fixture, never on your site. |
| Page content is data | As everywhere: what the page says is not an instruction to the model, the judge or the host. |

## What it does not do

- **It cannot verify the statement.** Anyone who can set the two variables can point the bot at any site that passes the origin rules. The record is for people to read, afterwards.
- **A name that resolves to a private address is not caught.** The address rules check an address written as an IP (in any spelling: decimal, hex and short forms are read as the browser reads them), and they refuse names that are local by their form: no dot, a final dot, or `.localhost`, `.local`, `.internal`, `.lan`, `.corp`, `.intranet`, `.home.arpa`. A public-looking name that resolves to a private address is not resolved and checked, and DNS rebinding is not stopped. What bounds it: a name that is not on this machine must be https, and the browser's certificate check is never turned off, so such a host would need a valid certificate for that name. Do not list a name that you do not control. This is a known gap.
- **The port is enforced on the requests the bot sees, and by host on a redirect hop.** The browser's host rule works by host name and cannot see a port, and a redirect hop is not seen by the bot's request handler. So a listed site that answers with a redirect to another port of the same host is followed. That is why the listed host should be one you run.
- **"Read-only" is by method.** A case on an external target may not declare `allowed_mutations`, and anything that is not a GET is blocked. A GET that changes state (`/cart/add?id=1`, a logout link) is not recognised unless its path is in `mutations.stateChangingGets`. The cases you write for an external site must only read.
- **No sign-in.** A page behind a login cannot be tested yet: a signed-in role and a secret are refused on an external target.
- **Scripts and styles from other hosts are blocked.** A page that needs a CDN may not render fully. If the owner of the page agrees, list that origin too (it is then allowed for everything).
- **What the bot stores.** The screenshots, page snapshots and network log of your site are stored in `runs/` (scrubbed of the secrets the bot knows about, which is none for an external site). Do not test pages that show personal data, and do not share `runs/`.
- **What reaches the model.** The page text goes to the model. With a model on this machine that stays on the machine. A provider that is not on this machine needs its own register entry and https (see [the live model runbook](live-provider.md)).
- **One request at a time and slowly.** The cases run one after another and each action waits for the model, so a site is not hammered. There is no further rate limit.

## Checking that it is on, or off

The commands that have nothing to do with a target (`cases`, `kill-switch`, `report`, `release`, `golden`, `eval`) ignore the `QA_EXTERNAL_*` variables, so a wrong setting cannot stop the kill switch, and they never see an external target. Only `run` (and the library and the MCP server) can use one. Each run's report says so in its header; the pre-flight report of the latest run (`runs/preflight-latest.json`, overwritten by each run) shows `target is allowed`.

Turn it off by unsetting the two variables (`Remove-Item Env:QA_EXTERNAL_ORIGINS, Env:QA_EXTERNAL_ATTESTATION`). The bot then refuses any target but the fixture, and says how to allow one.
