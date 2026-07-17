# One-command validation for real Stable Audio 3 on NVIDIA/CUDA (Windows).
#
# The Windows analogue of setup-sa3.sh. Unlike macOS (MLX), the CUDA backend
# (service/adapters/stable_audio3_cuda.py) runs Stable Audio 3 under PyTorch and
# needs:
#   1. A Python venv with: torch (CUDA build), stable_audio_3, soundfile, numpy.
#      Point MOSH_SERVICE_PYTHON at that venv's python.exe.
#   2. The SA3 weights — model_config.json + model.safetensors — in a directory
#      named by MOSH_SA3_MODEL_DIR (default E:\comfy4_models\unet). User-provided;
#      this script VALIDATES but does NOT download them (multi-GB, licensed).
#   3. COLORRACK_DATA — already built + checked in at service/colors/COLORRACK_DATA.
#
# It does NOT install anything (the CUDA/torch + stable_audio_3 stack is environment-
# specific). On success it writes service/.sa3.cuda.ps1 — dot-source it before
# run-mosh.ps1 / run.ps1 so the service loads SA3 instead of the FakeAdapter:
#       . .\service\.sa3.cuda.ps1
#
# Usage:
#   .\service\setup-sa3-cuda.ps1
#   .\service\setup-sa3-cuda.ps1 -Python C:\sa3-venv\Scripts\python.exe -ModelDir E:\models\sa3
param(
    [string]$Python   = $env:MOSH_SERVICE_PYTHON,
    [string]$ModelDir = $(if ($env:MOSH_SA3_MODEL_DIR) { $env:MOSH_SA3_MODEL_DIR } else { "E:\comfy4_models\unet" })
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ColorRack = $(if ($env:COLORRACK_DATA) { $env:COLORRACK_DATA } else { Join-Path $ScriptDir "colors\COLORRACK_DATA" })

function Say  { param($m) Write-Host "  $m" }
function Fail { param($m) Write-Host "`n[X] $m" -ForegroundColor Red; exit 1 }

Write-Host "- Mosh SA3 (CUDA) setup -"
Say "MOSH_SERVICE_PYTHON = $Python"
Say "MOSH_SA3_MODEL_DIR  = $ModelDir"
Say "COLORRACK_DATA      = $ColorRack"

# 1. The interpreter must be named (this is how the native service launcher and
#    run.ps1 find the CUDA venv).
if (-not $Python) {
    Fail "MOSH_SERVICE_PYTHON is not set. Pass -Python C:\path\to\venv\Scripts\python.exe (the venv with torch+stable_audio_3)."
}
if (-not (Test-Path $Python)) { Fail "python not found at: $Python" }

# 2. Validate the weights — the EXACT files stable_audio3_cuda.available() checks.
$cfg  = Join-Path $ModelDir "model_config.json"
$ckpt = Join-Path $ModelDir "model.safetensors"
if (-not (Test-Path $cfg) -or -not (Test-Path $ckpt)) {
    Fail "SA3 weights not found in $ModelDir (need model_config.json + model.safetensors). Set -ModelDir or MOSH_SA3_MODEL_DIR."
}
Say "weights OK"

# 3. Validate the bundled colour rack (drives the ASTD colour controls).
if (-not (Test-Path (Join-Path $ColorRack "colors.json"))) {
    Fail "colour rack missing at $ColorRack (expected colors.json). Build it: python colors\build_colorrack.py"
}
Say "colour rack OK"

# 4. The venv must import the runtime stack AND see a CUDA device — else the
#    adapter falls back / runs on CPU. This mirrors the adapter's import surface.
$probe = @'
import importlib.util, sys
for m in ("torch", "stable_audio_3", "soundfile", "numpy"):
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
    0 { Say "venv OK (torch + stable_audio_3 + CUDA device visible)" }
    2 { Fail "the venv is missing a required module (see above). Install torch (CUDA), stable_audio_3, soundfile, numpy into $Python." }
    3 { Fail "torch is installed but torch.cuda.is_available() is False - install a CUDA build of torch and check the NVIDIA driver." }
    default { Fail "python probe failed (exit $LASTEXITCODE)." }
}

# 5. Persist the resolved env. Dot-source this before launching so the service
#    loads SA3. Safe to delete (the service falls back to the FakeAdapter).
$envFile = Join-Path $ScriptDir ".sa3.cuda.ps1"
@"
# Written by service/setup-sa3-cuda.ps1. Dot-source before run-mosh.ps1 / run.ps1:
#     . .\service\.sa3.cuda.ps1
# Safe to delete (the service falls back to the deterministic FakeAdapter).
`$env:MOSH_ENABLE_SA3     = "1"
`$env:MOSH_SERVICE_PYTHON = "$Python"
`$env:MOSH_SA3_MODEL_DIR  = "$ModelDir"
`$env:COLORRACK_DATA      = "$ColorRack"
# Pins BOTH the native render-ahead window (ra.winLen) and the CUDA adapter's
# per-window render length — they must agree or stitched coverage breaks.
`$env:SA3_SECONDS         = "8.0"
"@ | Set-Content -Encoding UTF8 $envFile
Say "wrote $envFile"

Write-Host "`n[OK] SA3 (CUDA) ready. Dot-source the env, then launch:" -ForegroundColor Green
Write-Host "       . .\service\.sa3.cuda.ps1"
Write-Host "       .\run-mosh.ps1 -Run"
Write-Host "     (Set MOSH_ENABLE_SA3=0 to force the FakeAdapter even with SA3 installed.)"
