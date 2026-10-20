# Runbook: the container runner

Owner: the bot maintainer. Backup: the security reviewer. Last reviewed: 20 Oct 2026.

**Status: written but not yet verified.** Docker was installed but not running when this was written, so the image has never been built and the run script has never been executed. The Dockerfile and the script are covered by static tests (`tests/ci/container.test.ts`) that stop the isolation settings from being weakened. Verifying them is the first job when Docker is available:

```powershell
npm run container:run                                # builds the image and runs TC-FORM-001 with no network
npm run container:run -- -NoSandbox                  # only if the first command fails on the browser sandbox
```

Expected result: the CLI prints `Verdict: PASS`. Then check the run record under `runs/`. `versions.browser_sandbox` must be `true`, unless you passed `-NoSandbox`.

## What the container gives you

| Setting | Why |
| --- | --- |
| Base image pinned by digest | The same bytes every time, and a change needs a reviewed commit |
| `npm ci` from the lockfile, install scripts off | No surprise packages |
| Non-root user (`pwuser`) | A browser exploit does not get root in the container |
| `--network none` | No egress at all. Right for the fixture site, which runs inside the container |
| `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`, `no-new-privileges` | Nothing to persist, nothing to escalate with |
| `--pids-limit`, `--memory`, `--cpus` | A runaway or hostile page cannot starve the host |
| Only `runs/` is mounted | Results come out, and nothing else goes in |

## The Chromium sandbox

Playwright turns the Chromium sandbox off unless told otherwise, so the bot launches the browser with the sandbox on and records `browser_sandbox` in every run record. In a container, the sandbox needs user namespaces, which Docker's default seccomp profile blocks. There are two honest options:

1. **Keep the sandbox on.** Use a seccomp profile that allows it. Playwright publishes one in its documentation for Docker. Download it from Playwright's repository, check its content, store it in this repository with its SHA-256 recorded in the commit message, and pass it with `-Seccomp <file>`.
2. **Turn the sandbox off for this run only.** Pass `-NoSandbox`. The container (non-root, no capabilities, no network) becomes the only isolation layer. The CLI prints a warning and the run record says `browser_sandbox: false`. Do not use this for untrusted pages without option 1 or another strong boundary.

Never switch to `--privileged`, `--cap-add SYS_ADMIN`, host networking or host IPC to make the browser start. A test fails if the run script contains them.

## Running against staging later

`--network none` cannot reach staging. The runner decision (a build brief item due before M4) must provide an egress policy that allows only the staging domains, the LLM endpoint and artifact storage, and blocks the cloud metadata address and internal networks. Options: a user-defined Docker network behind a filtering proxy, a Kubernetes NetworkPolicy, or firewall rules on a dedicated VM. The bot's own allowlist and browser host rule are a second layer, never the only one.
