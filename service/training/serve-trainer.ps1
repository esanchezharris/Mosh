# serve-trainer.ps1 - run the Mosh LoRA training server LOCALLY on the Windows/CUDA
# box (FIT-013 local-4070 lane) — the PC analogue of runpod_serve.sh, minus the pod
# bootstrap: like setup-sa3-cuda.ps1 it VALIDATES the environment and installs
# nothing (the torch/stable_audio_3 stack is environment-specific).
#
# SECURITY: runpod_server.py is an UNAUTHENTICATED HTTP server that extracts
# submitted bundles and runs training subprocesses. Trusted LAN only:
#   - bind your LAN IPv4 (-BindHost 192.168.x.x), never a public interface;
#   - allow inbound TCP <port> only on the Private firewall profile, scoped to
#     the local subnet;
#   - NEVER port-forward it through the router;
#   - stop the server when you are not training (Ctrl+C).
#
# Usage (on the PC):
#   .\service\training\serve-trainer.ps1 -Sa3TrainDir E:\stable-audio-3 -BindHost 192.168.1.50
# Then on the Mac (see service/training/RUNPOD_RUNBOOK.md "Local PC trainer"):
#   launchctl setenv MOSH_TRAINING_BACKEND remote_http
#   launchctl setenv MOSH_TRAINING_REMOTE_URL http://<pc-lan-ip>:8799
param(
    [string]$Python      = $(if ($env:MOSH_TRAINER_PYTHON) { $env:MOSH_TRAINER_PYTHON } else { $env:MOSH_SERVICE_PYTHON }),
    [string]$Sa3TrainDir = $env:SA3_TRAIN_DIR,
    [int]$Port           = 8799,
    [string]$BindHost    = "0.0.0.0"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say  { param($m) Write-Host "  $m" }
function Fail { param($m) Write-Host "`n[X] $m" -ForegroundColor Red; exit 1 }

Write-Host "- Mosh local trainer (CUDA) -"
Say "python        = $Python"
Say "SA3_TRAIN_DIR = $Sa3TrainDir"
Say "bind          = ${BindHost}:${Port}"

if (-not $Python) {
    Fail "no trainer python. Pass -Python or set MOSH_TRAINER_PYTHON / MOSH_SERVICE_PYTHON (the venv with torch+stable_audio_3)."
}
if (-not (Test-Path -LiteralPath $Python)) { Fail "python not found at: $Python" }
if (-not $Sa3TrainDir) {
    Fail "SA3_TRAIN_DIR not set. Pass -Sa3TrainDir <path to the stable-audio-3 code tree>."
}
foreach ($s in @("scripts\pre_encode_dataset.py", "scripts\train_lora.py")) {
    if (-not (Test-Path -LiteralPath (Join-Path $Sa3TrainDir $s))) {
        Fail "training script missing: $Sa3TrainDir\$s (need the proven SA3 code tree - same one runpod_serve.sh uses)."
    }
}
Say "training scripts OK"

# The venv must import the real-trainer stack AND see CUDA — else runpod_server.py
# would silently fall back to the fake (stub) trainer. Mirrors _real_available().
$probe = @'
import importlib.util, sys
for m in ("torch", "stable_audio_3", "safetensors"):
    if importlib.util.find_spec(m) is None:
        sys.stderr.write("missing module: %s\n" % m); sys.exit(2)
import torch
sys.stderr.write("torch %s, cuda_available=%s, device=%s\n" % (
    torch.__version__, torch.cuda.is_available(),
    (torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu")))
sys.exit(0 if torch.cuda.is_available() else 3)
'@
& $Python -c $probe
switch ($LASTEXITCODE) {
    0 { Say "venv OK (torch + stable_audio_3 + CUDA device visible -> real trainer)" }
    2 { Fail "the venv is missing a required module (see above). Install torch (CUDA), stable_audio_3, safetensors into $Python." }
    3 { Fail "torch is installed but torch.cuda.is_available() is False - the server would run the FAKE trainer. Fix the CUDA torch/driver first." }
    default { Fail "python probe failed (exit $LASTEXITCODE)." }
}

if ($BindHost -eq "0.0.0.0") {
    Write-Host "  WARNING: binding 0.0.0.0 exposes the unauthenticated trainer on EVERY interface." -ForegroundColor Yellow
    Write-Host "           Prefer -BindHost <your LAN IPv4> and a Private-profile firewall rule." -ForegroundColor Yellow
}

$env:SA3_TRAIN_DIR = $Sa3TrainDir
if (-not $env:MOSH_TRAINER_WORK) {
    $env:MOSH_TRAINER_WORK = Join-Path $env:LOCALAPPDATA "Mosh\trainer-work"
}
Say "work dir      = $($env:MOSH_TRAINER_WORK)"

Write-Host "`nlaunching trainer server (Ctrl+C to stop; STOP IT when not training)..." -ForegroundColor Green
& $Python (Join-Path $ScriptDir "runpod_server.py") --port $Port --host $BindHost
exit $LASTEXITCODE
