# Runbook: the container runner

Owner: the bot maintainer. Backup: the security reviewer. Last reviewed: 20 Oct 2026.

**Status (6 Nov 2026): verified with the browser sandbox OFF; verified that it refuses to run with the sandbox on and no seccomp profile.** The image builds (about a minute, 968 MB), and the container runs `TC-FORM-001` with no network: the canary pair gives PASS and FAIL, and the case gives `Verdict: PASS`. The report says `sandbox OFF` and "Needs a person: the browser sandbox was off. That is acceptable only inside an isolating container." Two defects were found and fixed by that first real run: the Dockerfile did not copy `evals/`, which `src/cli.ts` imports at load time (the container failed with `ERR_MODULE_NOT_FOUND`), and the documented `npm run container:run -- -NoSandbox` does not pass the switch (PowerShell and npm turn `-NoSandbox` into an unknown npm flag), so run the script directly. The Dockerfile and the script are also covered by static tests (`tests/ci/container.test.ts`) that stop the isolation settings from being weakened.

```powershell
npm run container:run                                              # builds the image and runs TC-FORM-001 with no network
powershell -NoProfile -File scripts/container-run.ps1 -NoSandbox   # the same with the browser sandbox off (see below)
```

**With the sandbox on, the first command ends INCONCLUSIVE, by design.** Docker's default seccomp profile blocks what Chromium's sandbox needs, so the browser cannot start (`Chromium sandboxing failed!`), the canary pair fails, and the pre-flight check refuses the run. That is the right behaviour (nothing runs with a half-working browser), and it is why `-NoSandbox` or a seccomp profile (below) is needed. **Still to do:** keep the sandbox on with Playwright's seccomp profile (option 1 below), which needs a file to be downloaded, read and stored with its SHA-256; it has not been done.

Check after any run: the run record under `runs/` has `versions.browser_sandbox` (`true` with a seccomp profile, `false` with `-NoSandbox`).

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

## Docker on this machine, and what is not built (6 Nov 2026)

**Docker Desktop did not start**: `HCS_E_SERVICE_NOT_AVAILABLE` from WSL. WSL 2.7 and hardware virtualization were fine (the hypervisor was running). The first thing to look at is the Host Compute Service, which is what "HCS" means. In any PowerShell:

```powershell
Get-Service vmcompute | Format-List Name, Status, StartType
```

On this machine it was **Stopped and Disabled**, and nobody had restarted the computer since the Windows features were first looked at. A disabled service cannot be started, so WSL could not create its virtual machine. In an **administrator** PowerShell:

```powershell
Set-Service -Name vmcompute -StartupType Manual
Start-Service -Name vmcompute
Get-Service vmcompute          # must say Running
wsl --shutdown
```

Then start Docker Desktop. If the service comes back as Disabled after a restart, something on the machine turns it off (a Windows "optimizer" tool or a group policy), and that has to be found and removed. If `Start-Service` fails, the Windows features may be missing (administrator PowerShell, then restart):

```powershell
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
Restart-Computer
```

Docker then runs (verified on 6 Nov 2026, see the status at the top). It also helps to limit what WSL may take, in `C:\Users\<you>\.wslconfig` (`[wsl2]` with `memory=6GB`, `processors=4`, `swap=4GB`, and `[experimental]` with `autoMemoryReclaim=gradual`), and to stop Docker and WSL when they are not needed (`wsl --shutdown`), because a model on this machine needs the memory.

**The container has no network, so it cannot reach a model server.** `--network none` is right for the fixture and the scripted fake, which run inside it, and it is why the container cannot call Ollama or LM Studio on the host. So "start Docker, start Ollama, start the bot in the container" does not work as it stands, and Docker would not make the model faster (the model still runs on the host's CPU) or show the browser window. For a run with a local model, run the bot on the host, as the live model runbook says.

A bot in a container that does talk to a model on the host needs something that is **not built**, and each part is a security decision:

1. A way for the container to reach only the model server: an internal Docker network (`docker network create --internal`) holding the bot's container and a small forwarding container that is the only one with a route to `host.docker.internal:11434`. The bot's container keeps `--network none`'s promise for everything else: no internet.
2. A way to tell the configuration that the forwarding container's name is on this machine. Today `provider.baseUrl` that is not a loopback address needs a register entry and https (the data handling rule), which is right for a remote provider and too strict for a sidecar on the same machine. It would be a new, explicit setting that names that one host, and it would go through review like any change to that rule.
3. The same for an external target: the egress policy that allows only the listed origins is the "staging" decision below.

## Running against staging later

`--network none` cannot reach staging. The runner decision (a build brief item due before M4) must provide an egress policy that allows only the staging domains, the LLM endpoint and artifact storage, and blocks the cloud metadata address and internal networks. Options: a user-defined Docker network behind a filtering proxy, a Kubernetes NetworkPolicy, or firewall rules on a dedicated VM. The bot's own allowlist and browser host rule are a second layer, never the only one.
