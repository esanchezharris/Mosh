# verify-pc-build.ps1 - headless Windows build + verification gate for the
# Mosh PC (NVIDIA/CUDA) port. Run from a shell where `cmake` is available (a normal
# PowerShell is fine with the Visual Studio 17 2022 generator).
#
#   pwsh -NoProfile -File scripts\verify-pc-build.ps1
#   pwsh -NoProfile -File scripts\verify-pc-build.ps1 -RealSA3        # exercise the CUDA SA3 path
#   pwsh -NoProfile -File scripts\verify-pc-build.ps1 -RealLoRA       # runtime-LoRA smoke on the GPU (FIT-013)
#   pwsh -NoProfile -File scripts\verify-pc-build.ps1 -Repeat 3       # determinism bar (3 isolated runs)
#
# Steps: configure (windows-x64-release) -> build app + tests + VST3 fixture ->
# run MoshTests (Catch2) -> run `Mosh.exe --selftest` (device-free, isolated port)
# N times asserting exit 0. -RealSA3 additionally wires the CUDA venv + weights and
# runs the SA3-gated selftest. -RealLoRA (implies the -RealSA3 env wiring) runs
# service\scripts\sa3_cuda_lora_smoke.py: stock vs two LoRA strengths must differ,
# tensors must match the numpy disk-merge oracle, restore must be bit-clean.
param(
    [switch]$SkipAppBuild,
    [switch]$RealSA3,
    [switch]$RealLoRA,
    [int]$Repeat = 1
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Find-CMake {
    $fromPath = Get-Command cmake -ErrorAction SilentlyContinue
    if ($fromPath) { return $fromPath.Source }
    $pf = Join-Path ${env:ProgramFiles} "CMake\bin\cmake.exe"
    if (Test-Path -LiteralPath $pf) { return $pf }
    throw "CMake was not found on PATH or at $pf"
}

function Invoke-Native {
    param([string]$Label, [scriptblock]$Command)
    Write-Host ""
    Write-Host "==> $Label"
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

function Find-FirstExe {
    param([string]$Name)
    $roots = @((Join-Path $Root "build-windows-x64-release"), (Join-Path $Root "build-windows-x64"))
    $match = $roots |
        Where-Object { Test-Path -LiteralPath $_ } |
        ForEach-Object { Get-ChildItem -Path $_ -Recurse -Filter $Name -ErrorAction SilentlyContinue } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $match) { throw "$Name was not found under the build tree" }
    return $match.FullName
}

function Get-FreeTcpPort {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try { $l.Start(); return $l.LocalEndpoint.Port } finally { $l.Stop() }
}

function Invoke-MoshSelfTest {
    param([string]$Exe, [switch]$WithRealSA3)

    $saved = @{}
    foreach ($k in "MOSH_NO_AUDIO","MOSH_ENABLE_SA3","MOSH_SELFTEST_SA3","MOSH_SERVICE_PYTHON",
                    "MOSH_SA3_MODEL_DIR","MOSH_SERVICE_PORT","MOSH_RENDER_WAIT_TIMEOUT_MS") {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k)   # $null when unset; StrictMode-safe
    }
    try {
        $env:MOSH_NO_AUDIO = "1"                       # device-free harness
        $env:MOSH_SERVICE_PORT = [string](Get-FreeTcpPort)   # isolate the service port

        if ($WithRealSA3) {
            $py = if ($env:MOSH_SERVICE_PYTHON) { $env:MOSH_SERVICE_PYTHON } else { "C:\ComfyUI\venv\Scripts\python.exe" }
            $model = if ($env:MOSH_SA3_MODEL_DIR) { $env:MOSH_SA3_MODEL_DIR } else { "E:\comfy4_models\unet" }
            if (-not ((Test-Path -LiteralPath $py) -and
                      (Test-Path -LiteralPath (Join-Path $model "model_config.json")) -and
                      (Test-Path -LiteralPath (Join-Path $model "model.safetensors")))) {
                throw "RealSA3 requested but the CUDA venv ($py) or weights ($model) are missing. Run service\setup-sa3-cuda.ps1."
            }
            $env:MOSH_SERVICE_PYTHON = $py
            $env:MOSH_SA3_MODEL_DIR = $model
            $env:MOSH_ENABLE_SA3 = "1"
            $env:MOSH_SELFTEST_SA3 = "1"
            $env:MOSH_RENDER_WAIT_TIMEOUT_MS = "600000"
        } else {
            $env:MOSH_ENABLE_SA3 = "0"
            Remove-Item Env:\MOSH_SELFTEST_SA3 -ErrorAction SilentlyContinue
        }

        $tmp = Join-Path $env:TEMP ("mosh-selftest-" + [guid]::NewGuid().ToString("N"))
        $proc = Start-Process -FilePath $Exe -ArgumentList @("--selftest") -Wait -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput "$tmp.out" -RedirectStandardError "$tmp.err"
        if (Test-Path "$tmp.out") { Get-Content "$tmp.out" | ForEach-Object { Write-Host $_ } }
        if (Test-Path "$tmp.err") { Get-Content "$tmp.err" | ForEach-Object { Write-Host $_ } }
        Remove-Item "$tmp.out","$tmp.err" -ErrorAction SilentlyContinue
        if ($proc.ExitCode -ne 0) { throw "Mosh --selftest failed with exit code $($proc.ExitCode)" }
    } finally {
        foreach ($k in $saved.Keys) {
            if ($null -eq $saved[$k]) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }
            else { Set-Item -Path "env:$k" -Value $saved[$k] }
        }
    }
}

Push-Location $Root
try {
    $CMake = Find-CMake

    Invoke-Native "configure Windows x64 (Release)" { & $CMake --preset windows-x64-release }

    if (-not $SkipAppBuild) {
        Invoke-Native "build Mosh app + UI" { & $CMake --build --preset windows-x64-release-app --parallel }
    }
    Invoke-Native "build C++ test target"        { & $CMake --build --preset windows-x64-release-tests --parallel }
    Invoke-Native "build deterministic VST3 fixture" { & $CMake --build --preset windows-x64-release-plugin-fixture --parallel }

    $MoshTests = Find-FirstExe "MoshTests.exe"
    $MoshExe   = Find-FirstExe "Mosh.exe"

    Invoke-Native "run MoshTests (Catch2)" { & $MoshTests }

    for ($i = 1; $i -le $Repeat; $i++) {
        Invoke-Native "run Mosh --selftest (run $i/$Repeat)" { Invoke-MoshSelfTest -Exe $MoshExe }
    }

    if ($RealSA3) {
        Invoke-Native "run real SA3 (CUDA) selftest" { Invoke-MoshSelfTest -Exe $MoshExe -WithRealSA3 }
    }

    if ($RealLoRA) {
        $py = if ($env:MOSH_SERVICE_PYTHON) { $env:MOSH_SERVICE_PYTHON } else { "C:\ComfyUI\venv\Scripts\python.exe" }
        if (-not (Test-Path -LiteralPath $py)) {
            throw "RealLoRA requested but the CUDA venv ($py) is missing. Run service\setup-sa3-cuda.ps1."
        }
        # The smoke needs >=1 enrolled LoRA; it prints the enroll hint itself if the
        # rack is empty (service/loras/install.py).
        Invoke-Native "run runtime-LoRA smoke (CUDA)" {
            & $py (Join-Path $Root "service\scripts\sa3_cuda_lora_smoke.py")
        }
    }

    Write-Host ""
    Write-Host "PC build verification passed." -ForegroundColor Green
    Write-Host "UI gates are platform-agnostic - run them separately:  cd ui; npm ci; npm test; npm run test:e2e"
} finally {
    Pop-Location
}
