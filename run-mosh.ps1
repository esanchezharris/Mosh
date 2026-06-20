# run-mosh.ps1 - build / launch Mosh on Windows (NVIDIA/CUDA), the PowerShell
# analogue of run-mosh.sh. macOS deploys a /Applications/Mosh.app bundle; Windows
# runs the .exe straight from the build tree (CMake already stages ui\ + drumkits\
# next to it), so there is no "deploy" mode here.
#
# THIS SCRIPT CONTAINS NO KEYS. It loads brain keys from ui\.env.local (gitignored)
# and from the current environment. For real Stable Audio 3 on CUDA, dot-source the
# env written by setup-sa3-cuda.ps1 first:
#       . .\service\.sa3.cuda.ps1
#       .\run-mosh.ps1 -Run
#
# Usage:
#   .\run-mosh.ps1            launch the GUI (talk/type to Moshi)
#   .\run-mosh.ps1 -Build     (re)configure + build (Release), then launch the GUI
#   .\run-mosh.ps1 -Smoke     non-interactive native brain round-trip; prints the reply
#   .\run-mosh.ps1 -Debug     use the Debug preset (with -Build) / prefer the Debug build
param(
    [switch]$Build,
    [switch]$Smoke,
    [switch]$Debug
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

# --- build (optional) --------------------------------------------------------------
if ($Build) {
    if ($Debug) {
        cmake --preset windows-x64-debug
        cmake --build --preset windows-x64-app
    } else {
        cmake --preset windows-x64-release
        cmake --build --preset windows-x64-release-app
    }
}

# --- resolve the newest Mosh.exe ---------------------------------------------------
$searchDirs = @()
if ($Debug) { $searchDirs += (Join-Path $Root "build-windows-x64") }
$searchDirs += (Join-Path $Root "build-windows-x64-release")
$searchDirs += (Join-Path $Root "build-windows-x64")

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

if ($Smoke) {
    Write-Host "smoke: $exe --brain-smoke"
    & $exe --brain-smoke
    exit $LASTEXITCODE
}

Write-Host "launching Mosh ($exe)..."
& $exe
exit $LASTEXITCODE
