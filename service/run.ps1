# Dev launcher for the Mosh generative service (Windows / PowerShell).
#
# Zero external dependencies - runs against any stdlib Python 3.11+.
# Usage:
#   .\run.ps1                          # 127.0.0.1:8765
#   .\run.ps1 -BindPort 9000           # custom port
#   .\run.ps1 -BindHost 0.0.0.0 -BindPort 9000
#
# Note: -BindHost / -BindPort avoid clashing with PowerShell's automatic $Host.
param(
    [string]$BindHost = "127.0.0.1",
    [int]$BindPort = 8765
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($env:MOSH_SERVICE_PYTHON) {
    & $env:MOSH_SERVICE_PYTHON "$ScriptDir\server.py" --host $BindHost --port $BindPort
    exit $LASTEXITCODE
}

$py = Get-Command py -ErrorAction SilentlyContinue
if ($py) {
    & $py.Source -3 "$ScriptDir\server.py" --host $BindHost --port $BindPort
    exit $LASTEXITCODE
}

& python "$ScriptDir\server.py" --host $BindHost --port $BindPort
