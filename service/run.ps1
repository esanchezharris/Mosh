# Dev launcher for the Mosh generative service (Windows / PowerShell).
#
# Mirrors service/run.sh. server.py reads MOSH_SERVICE_HOST / MOSH_SERVICE_PORT
# from the environment (it does NOT parse argv), so we set those here.
#
# Backend selection:
#   • FakeAdapter (deterministic stub) runs under any stdlib Python 3.11+.
#   • Real Stable Audio 3 on NVIDIA/CUDA needs a venv with `torch` (CUDA),
#     `stable_audio_3`, `soundfile`, `numpy`, plus the SA3 weights. Point
#     MOSH_SERVICE_PYTHON at that venv's python and set MOSH_SA3_MODEL_DIR.
#     (`service/setup-sa3-cuda.ps1` validates this and prints the env block.)
#
# Usage:
#   .\run.ps1                                  # 127.0.0.1:8770
#   .\run.ps1 -BindPort 9000
#   $env:MOSH_SERVICE_PYTHON = "C:\sa3-venv\Scripts\python.exe"; .\run.ps1
#
# Note: -BindHost / -BindPort avoid clashing with PowerShell's automatic $Host.
param(
    [string]$BindHost = "127.0.0.1",
    [int]$BindPort = 8770
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# server.py binds from these (argv is ignored). Honour any pre-set values.
if (-not $env:MOSH_SERVICE_HOST) { $env:MOSH_SERVICE_HOST = $BindHost }
if (-not $env:MOSH_SERVICE_PORT) { $env:MOSH_SERVICE_PORT = "$BindPort" }

if ($env:MOSH_SERVICE_PYTHON) {
    & $env:MOSH_SERVICE_PYTHON "$ScriptDir\server.py"
    exit $LASTEXITCODE
}

$py = Get-Command py -ErrorAction SilentlyContinue
if ($py) {
    & $py.Source -3 "$ScriptDir\server.py"
    exit $LASTEXITCODE
}

& python "$ScriptDir\server.py"
