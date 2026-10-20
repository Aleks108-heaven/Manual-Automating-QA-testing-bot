# Builds the runner image and runs one case in a locked-down container.
#   powershell -File scripts/container-run.ps1 [-Case cases/TC-FORM-001.yaml] [-Seccomp <profile.json>] [-NoSandbox]
#
# The container has no network at all (fine for the fixture site, which runs inside it), a read-only
# root file system, no Linux capabilities, a memory and process limit, and a non-root user.
# The Chromium sandbox needs user namespaces, which Docker's default seccomp profile blocks. Pass
# -Seccomp with Playwright's seccomp profile to keep the sandbox on. -NoSandbox turns the sandbox off
# for this run only, and the run record and the CLI both say so.
param(
  [string]$Case = "cases/TC-FORM-001.yaml",
  [string]$Seccomp = "",
  [switch]$NoSandbox,
  [string[]]$CaseArgs = @()
)
$ErrorActionPreference = "Stop"
docker build -t qa-bot:local .

$runs = Join-Path (Get-Location) "runs"
New-Item -ItemType Directory -Force $runs | Out-Null

$dockerArgs = @(
  "run", "--rm",
  "--network", "none",
  "--read-only",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--pids-limit", "512",
  "--memory", "2g",
  "--cpus", "2",
  "--shm-size", "1g",
  "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
  "-e", "HOME=/tmp",
  "-e", "QA_RUNS_DIR=/app/runs",
  "-v", "${runs}:/app/runs"
)
if ($Seccomp -ne "") { $dockerArgs += @("--security-opt", "seccomp=$Seccomp") }
if ($NoSandbox) { $dockerArgs += @("-e", "QA_BROWSER_SANDBOX=off") }
$dockerArgs += @("qa-bot:local", $Case) + $CaseArgs

docker @dockerArgs
exit $LASTEXITCODE
