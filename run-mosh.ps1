# run-mosh.ps1 - build / launch / PACKAGE Mosh on Windows (NVIDIA/CUDA), the PowerShell
# analogue of run-mosh.sh. macOS deploys a /Applications/Mosh.app bundle; on Windows the
# app is a FLAT layout — Mosh.exe with ui\, drumkits\, service\, and brain.env as siblings
# (CMake stages ui\ + drumkits\ next to the exe; -Package adds service\ + brain.env + a zip).
#
# THIS SCRIPT CONTAINS NO KEYS. It loads brain keys from ui\.env.local (gitignored) and from
# the current environment. For real Stable Audio 3 on CUDA, dot-source the env written by
# setup-sa3-cuda.ps1 first:
#       . .\service\.sa3.cuda.ps1
#       .\run-mosh.ps1 -Run
#
# Usage:
#   .\run-mosh.ps1            launch the GUI (talk/type to Moshi)
#   .\run-mosh.ps1 -Build     (re)configure + build (Release), then launch the GUI
#   .\run-mosh.ps1 -Smoke     non-interactive native brain round-trip; prints the reply
#   .\run-mosh.ps1 -Debug     use the Debug preset (with -Build) / prefer the Debug build
#   .\run-mosh.ps1 -Package   build Release, then stage a self-contained dist\Mosh\ (exe +
#                             ui\ + drumkits\ + service\ + a bundled brain.env) and zip it —
#                             the Windows analogue of `run-mosh.sh deploy`. No keys in git.
param(
    [switch]$Build,
    [switch]$Smoke,
    [switch]$Debug,
    [switch]$Package
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- load a dotenv file WITHOUT printing any values --------------------------------
function Import-DotEnv {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    foreach ($line in Get-Content $Path) {
        $t = $line.Trim()
        if ($t -eq "" -or $t.StartsWith("#") -or ($t -notmatch "=")) { continue }
        $key = ($t -split "=", 2)[0].Trim()
        $val = ($t -split "=", 2)[1].Trim()
        if ($val.StartsWith('"') -and $val.EndsWith('"')) { $val = $val.Trim('"') }
        elseif ($val.StartsWith("'") -and $val.EndsWith("'")) { $val = $val.Trim("'") }
        else { $val = ($val -split "\s+#", 2)[0].Trim() }   # strip " # inline comment"
        if ($key) { Set-Item -Path "env:$key" -Value $val }
    }
}

$envFile = if ($env:MOSH_BRAIN_ENV) { $env:MOSH_BRAIN_ENV } else { Join-Path $Root "ui\.env.local" }
Import-DotEnv $envFile

# SA3 imagine on by default (service auto-selects the CUDA backend when the model +
# stable_audio_3 are present, else FakeAdapter). Set MOSH_ENABLE_SA3=0 to force the stub.
if (-not $env:MOSH_ENABLE_SA3) { $env:MOSH_ENABLE_SA3 = "1" }

# Let the launched .exe find the repo service/ regardless of working directory
# (GenerativeJobManager checks MOSH_SERVICE_SCRIPT first). The CUDA venv comes from
# MOSH_SERVICE_PYTHON (see setup-sa3-cuda.ps1); absent → FakeAdapter via py/python.
if (-not $env:MOSH_SERVICE_SCRIPT) { $env:MOSH_SERVICE_SCRIPT = Join-Path $Root "service\server.py" }

# --- report which providers are configured (names only, never values) -------------
if (Test-Path $envFile) { Write-Host "env: $envFile" } else { Write-Host "env: shell only (no $envFile)" }
$haveAny = $false
foreach ($p in @("DEEPSEEK", "OPENAI", "XAI")) {
    if (Get-Item -Path "env:${p}_API_KEY" -ErrorAction SilentlyContinue) {
        Write-Host "  - ${p}: key present"; $haveAny = $true
    }
}
if (-not $haveAny) {
    Write-Host "  - no brain key found - paste one into ui\.env.local (the brain falls back to the offline mock)"
}

# --- packaging helpers (the Windows analogue of run-mosh.sh's bundle_service /
#     bundle_brain_key; the flat service\ layout matches GenerativeJobManager's tier-4
#     <exeDir>\service\server.py lookup, and brain.env sits next to Mosh.exe where the
#     BrainProxy Windows fallback reads it) ----------------------------------------
function Copy-ServiceBundle {
    param([string]$SvcDest)   # <dist>\service
    Write-Host "bundling service -> $SvcDest"
    if (Test-Path $SvcDest) { Remove-Item -Recurse -Force $SvcDest }
    foreach ($sub in @($SvcDest, "$SvcDest\transcribe", "$SvcDest\sketch", "$SvcDest\transform")) {
        New-Item -ItemType Directory -Force -Path $sub | Out-Null
    }

    # Top-level modules imported (transitively) by the bundled dirs below. Keep this list
    # BYTE-FOR-BYTE in sync with run-mosh.sh's bundle_service (guarded by
    # service/scripts/bundle_completeness_test.py). run.ps1 replaces run.sh on Windows.
    $topFiles = @(
        "server.py", "run.ps1", "quality_readout.py", "audio_io.py",
        "brain_client.py", "coverage.py", "stitch.py", "setup-sa3.sh"
    )
    foreach ($f in $topFiles) {
        $src = Join-Path $Root "service\$f"
        if (Test-Path $src) { Copy-Item $src -Destination $SvcDest }
    }

    # Whole-dir whitelist (MUST match run-mosh.sh bundle_service's `for d in ...`).
    $dirs = @(
        "adapters", "colors", "recipes", "sa3", "scripts", "training", "lyrics",
        "phonology", "skeleton", "whisper", "soulx", "bestofn", "compiler"
    )
    foreach ($d in $dirs) {
        $src = Join-Path $Root "service\$d"
        if (Test-Path $src) { Copy-Item $src -Destination $SvcDest -Recurse }
    }

    # Extra per-feature CLIs + setup scripts (the venvs themselves are NEVER bundled).
    $extras = @(
        "transcribe\transcribe_cli.py", "transcribe\setup-transcribe.sh",
        "sketch\beatbox_cli.py", "sketch\make_fixtures.py", "sketch\setup-sketch.sh", "sketch\README.md",
        "transform\transform_cli.py", "transform\setup-transform.sh"
    )
    foreach ($e in $extras) {
        $src = Join-Path $Root "service\$e"
        if (Test-Path $src) { Copy-Item $src -Destination (Join-Path $SvcDest (Split-Path -Parent $e)) }
    }
    $sketchFix = Join-Path $Root "service\sketch\fixtures"
    if (Test-Path $sketchFix) { Copy-Item $sketchFix -Destination "$SvcDest\sketch" -Recurse }

    # Machine-local venv pointers (gitignored). Absent ones fall back to the conventional
    # %LOCALAPPDATA%\Mosh\venvs default that server.py's _venv_py resolves on Windows.
    foreach ($ptr in @(".sa3.env", "transcribe\.transcribe.env", "sketch\.sketch.env", "transform\.transform.env")) {
        $src = Join-Path $Root "service\$ptr"
        if (Test-Path $src) { Copy-Item $src -Destination (Join-Path $SvcDest $ptr) }
    }

    Get-ChildItem -Path $SvcDest -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

function Write-BundledBrainKey {
    param([string]$BrainFile)   # <dist>\brain.env
    # Same 9 keys + format as run-mosh.sh's bundle_brain_key: one KEY=value line per
    # NON-EMPTY var, from the ui\.env.local values already loaded into the environment.
    $keys = @(
        "MOSHI_BRAIN_PROVIDER",
        "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_API_KEY",
        "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "DEEPSEEK_API_KEY",
        "XAI_BASE_URL", "XAI_MODEL", "XAI_API_KEY"
    )
    $lines = @()
    foreach ($k in $keys) {
        $v = [Environment]::GetEnvironmentVariable($k)
        if ($v) { $lines += "$k=$v" }
    }
    if ($lines.Count -gt 0) {
        # CRITICAL: write WITHOUT a UTF-8 BOM. Set-Content/Out-File default to a BOM on
        # Windows PowerShell 5.1, which would prefix the first key name and BrainProxy's
        # key lookup would silently miss it.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($BrainFile, ($lines -join "`n") + "`n", $utf8NoBom)
        # chmod-600 analogue: drop inheritance, grant the current user only.
        try { icacls $BrainFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null } catch { }
        $count = ($lines | Where-Object { $_ -match "_API_KEY=" }).Count
        Write-Host "bundled brain key -> brain.env ($count provider key(s); Moshi has a brain on any launch)"
    } else {
        if (Test-Path $BrainFile) { Remove-Item $BrainFile }
        Write-Host "no brain key in env - skipped brain.env (paste one into ui\.env.local to bundle it)"
    }
}

# --- build (optional; -Package always builds Release) ------------------------------
if ($Build -or $Package) {
    if ($Debug -and -not $Package) {
        cmake --preset windows-x64-debug
        cmake --build --preset windows-x64-app
    } else {
        cmake --preset windows-x64-release
        cmake --build --preset windows-x64-release-app
    }
}

# --- resolve the newest Mosh.exe ---------------------------------------------------
# -Package always ships the Release build; otherwise honour -Debug.
$searchDirs = @()
if ($Package) {
    $searchDirs += (Join-Path $Root "build-windows-x64-release")
} else {
    if ($Debug) { $searchDirs += (Join-Path $Root "build-windows-x64") }
    $searchDirs += (Join-Path $Root "build-windows-x64-release")
    $searchDirs += (Join-Path $Root "build-windows-x64")
}

$exe = $null
foreach ($d in $searchDirs) {
    if (Test-Path $d) {
        $cand = Get-ChildItem -Path $d -Recurse -Filter "Mosh.exe" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($cand) { $exe = $cand.FullName; break }
    }
}

if (-not $exe) {
    Write-Host "Mosh.exe not built. Build it first:  .\run-mosh.ps1 -Build" -ForegroundColor Red
    exit 1
}

# --- package (self-contained zip + bundled brain) ----------------------------------
if ($Package) {
    $exeDir   = Split-Path -Parent $exe            # build-output dir: exe + ui\ + drumkits\ + DLLs
    $distRoot = Join-Path $Root "dist"
    $dist     = Join-Path $distRoot "Mosh"
    Write-Host "packaging from $exeDir -> $dist"
    if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
    New-Item -ItemType Directory -Force -Path $dist | Out-Null

    Copy-Item (Join-Path $exeDir "Mosh.exe") -Destination $dist
    foreach ($sub in @("ui", "drumkits")) {
        $p = Join-Path $exeDir $sub
        if (Test-Path $p) { Copy-Item $p -Destination $dist -Recurse }
        else { Write-Host "  WARNING: $sub\ not found next to the exe (MoshStageUI / drumkits staging?)" -ForegroundColor Yellow }
    }
    # DLLs staged next to the exe: WebView2Loader.dll + the MSVC runtime redist (CMake's
    # InstallRequiredSystemLibraries POST_BUILD). CUDA DLLs live in the Python venv, not here.
    Get-ChildItem -Path $exeDir -Filter *.dll -File -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item $_.FullName -Destination $dist }

    Copy-ServiceBundle (Join-Path $dist "service")
    Write-BundledBrainKey (Join-Path $dist "brain.env")

    $zip = Join-Path $distRoot "Mosh-win-x64.zip"
    if (Test-Path $zip) { Remove-Item $zip }
    Compress-Archive -Path $dist -DestinationPath $zip

    Write-Host ""
    Write-Host "packaged self-contained build:" -ForegroundColor Green
    Write-Host "  folder: $dist"
    Write-Host "  zip:    $zip"
    Write-Host "Copy the folder anywhere and run Mosh.exe. Real generative/FMS features need the"
    Write-Host "per-feature venvs — see docs\WINDOWS_RUNBOOK.md (setup-feature-venv.ps1 / setup-sa3-cuda.ps1)."
    exit 0
}

if ($Smoke) {
    Write-Host "smoke: $exe --brain-smoke"
    & $exe --brain-smoke
    exit $LASTEXITCODE
}

Write-Host "launching Mosh ($exe)..."
& $exe
exit $LASTEXITCODE
