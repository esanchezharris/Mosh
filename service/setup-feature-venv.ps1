# setup-feature-venv.ps1 - create a per-feature Python venv for Mosh on Windows.
#
# The PowerShell analogue of the per-feature bash setup-*.sh scripts (which are macOS/Linux
# only). One parametrised script, driven by a manifest that mirrors each bash script's deps
# byte-for-byte, covering the features with clear Windows value: transcribe (Basic Pitch),
# whisper, skeleton (FCPE), phonology (Bar-IQ). sketch / transform-RAVE / flp are deferred.
#
# The venv is created at the SAME conventional location server.py's _venv_py resolves on
# Windows — %LOCALAPPDATA%\Mosh\venvs\<feature> (override with $env:MOSH_VENVS_DIR) — so the
# feature works with NO env exports and NO service restart. A dotenv pointer
# (service\<feature>\.<feature>.env, e.g. WHISPER_PY=...) is also written for parity and for
# an explicit MOSH_SERVICE_PYTHON-style override.
#
# Usage:
#   .\service\setup-feature-venv.ps1 -Feature whisper
#   .\service\setup-feature-venv.ps1 -Feature all
#   .\service\setup-feature-venv.ps1 -Feature transcribe -Reinstall
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("transcribe", "whisper", "skeleton", "phonology", "all")]
    [string]$Feature,
    [switch]$Reinstall
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path   # service\

# Per-feature manifest — deps/pins/import/env MIRROR the bash setup-*.sh scripts.
$MANIFEST = @{
    transcribe = @{ Pkgs = @("basic-pitch[onnx]");            Pins = @("setuptools<81"); Import = "basic_pitch"; EnvVar = "BASIC_PITCH_PY"; EnvFile = "transcribe\.transcribe.env" }
    whisper    = @{ Pkgs = @("openai-whisper");               Pins = @("setuptools<81"); Import = "whisper";     EnvVar = "WHISPER_PY";     EnvFile = "whisper\.whisper.env" }
    skeleton   = @{ Pkgs = @("torch", "torchaudio", "torchfcpe"); Pins = @("setuptools<81"); Import = "torchfcpe"; EnvVar = "SKELETON_PY"; EnvFile = "skeleton\.skeleton.env" }
    phonology  = @{ Pkgs = @("pronouncing", "cmudict");       Pins = @("setuptools<81"); Optional = @("g2p-en"); Import = "pronouncing"; EnvVar = "PHONOLOGY_PY"; EnvFile = "phonology\.phonology.env" }
}

function Get-VenvsRoot {
    if ($env:MOSH_VENVS_DIR) { return $env:MOSH_VENVS_DIR }
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $HOME }
    return (Join-Path $base "Mosh\venvs")
}

# A python launcher for CREATING the venv (prefer the py launcher, 3.11 for best wheels).
function Resolve-BootstrapPython {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        foreach ($v in @("-3.11", "-3.12", "-3")) {
            try { & $py.Source $v --version *> $null; if ($LASTEXITCODE -eq 0) { return @($py.Source, $v) } } catch { }
        }
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) { return @($python.Source) }
    throw "no Python found on PATH (install Python 3.11+ and the 'py' launcher)"
}

function Test-VenvImport {
    param([string]$PyBin, [string]$Module)
    if (-not (Test-Path $PyBin)) { return $false }
    & $PyBin -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('$Module') else 1)" *> $null
    return ($LASTEXITCODE -eq 0)
}

function Write-EnvPointer {
    param([string]$Path, [string]$EnvVar, [string]$PyBin)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $body = "# Written by service\setup-feature-venv.ps1. Points server.py's _venv_py at the venv.`n$EnvVar=$PyBin`n"
    [System.IO.File]::WriteAllText($Path, $body, $utf8NoBom)
}

function Install-Feature {
    param([string]$Name)
    $m = $MANIFEST[$Name]
    $venv = Join-Path (Get-VenvsRoot) $Name
    $pybin = Join-Path $venv "Scripts\python.exe"
    Write-Host "== $Name =="

    if ((-not $Reinstall) -and (Test-VenvImport $pybin $m.Import)) {
        Write-Host "  venv OK ($venv - install skipped; -Reinstall forces a top-up)"
    } else {
        if (-not (Test-Path $pybin)) {
            Write-Host "  creating venv at $venv ..."
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $venv) | Out-Null
            $boot = Resolve-BootstrapPython
            & $boot[0] @($boot[1..($boot.Count - 1)]) -m venv $venv
            if ($LASTEXITCODE -ne 0) { throw "venv creation failed for $Name" }
        }
        Write-Host "  installing $($m.Pkgs -join ', ') (may pull torch - can take minutes) ..."
        & $pybin -m pip install --quiet --upgrade pip @($m.Pins)
        if ($LASTEXITCODE -ne 0) { throw "pip pin install failed for $Name" }
        & $pybin -m pip install --quiet @($m.Pkgs)
        if ($LASTEXITCODE -ne 0) { throw "pip install failed for $Name" }
        if ($m.ContainsKey("Optional")) {
            foreach ($opt in $m.Optional) {
                & $pybin -m pip install --quiet $opt *> $null
                if ($LASTEXITCODE -eq 0) { Write-Host "  optional: $opt installed" }
                else { Write-Host "  optional: $opt skipped (degrades gracefully)" }
            }
        }
        if (-not (Test-VenvImport $pybin $m.Import)) {
            throw "the venv cannot import $($m.Import) - install failed; inspect $venv"
        }
        Write-Host "  venv OK ($($m.Import) importable)"
    }

    Write-EnvPointer (Join-Path $ScriptDir $m.EnvFile) $m.EnvVar $pybin
    Write-Host "  wrote $($m.EnvFile) ($($m.EnvVar)=$pybin)"
}

if ($Feature -eq "all") {
    foreach ($f in @("transcribe", "whisper", "skeleton", "phonology")) { Install-Feature $f }
} else {
    Install-Feature $Feature
}

Write-Host ""
Write-Host "done. The venv lives at the conventional location server.py resolves on Windows —" -ForegroundColor Green
Write-Host "no exports needed. Restart Mosh (or the service) if it was already running."
