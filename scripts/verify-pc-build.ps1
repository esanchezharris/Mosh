param(
    [switch]$SkipAppBuild,
    [switch]$SkipE2E,
    [switch]$RealSA3,
    [switch]$KeepArtifacts
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Find-CMake {
    $fromPath = Get-Command cmake -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }

    $programFiles = Join-Path ${env:ProgramFiles} "CMake\bin\cmake.exe"
    if (Test-Path -LiteralPath $programFiles) {
        return $programFiles
    }

    throw "CMake was not found on PATH or at $programFiles"
}

function Invoke-Native {
    param(
        [string]$Label,
        [scriptblock]$Command
    )

    Write-Host ""
    Write-Host "==> $Label"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

function Find-FirstExe {
    param([string]$Name)

    $searchRoots = @((Join-Path $Root "build-pc"), (Join-Path $Root "build"))
    $match = $searchRoots |
        Where-Object { Test-Path -LiteralPath $_ } |
        ForEach-Object { Get-ChildItem -Path $_ -Recurse -Filter $Name -ErrorAction SilentlyContinue } |
        Select-Object -First 1
    if (-not $match) {
        throw "$Name was not found under build"
    }
    return $match.FullName
}

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return $listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }
}

function Invoke-MoshSelfTest {
    param(
        [string]$Exe,
        [switch]$WithRealSA3
    )

    $oldNoAudio = $env:MOSH_NO_AUDIO
    $oldEnableSa3 = $env:MOSH_ENABLE_SA3
    $oldSelftestSa3 = $env:MOSH_SELFTEST_SA3
    $oldServicePython = $env:MOSH_SERVICE_PYTHON
    $oldSa3ModelDir = $env:MOSH_SA3_MODEL_DIR
    $oldServicePort = $env:MOSH_SERVICE_PORT
    $oldRenderWait = $env:MOSH_RENDER_WAIT_TIMEOUT_MS
    try {
        $env:MOSH_NO_AUDIO = "1"
        $env:MOSH_SERVICE_PORT = [string](Get-FreeTcpPort)
        if ($WithRealSA3) {
            $cudaPython = if ($env:MOSH_SERVICE_PYTHON) { $env:MOSH_SERVICE_PYTHON } else { "C:\ComfyUI\venv\Scripts\python.exe" }
            $cudaModel = if ($env:MOSH_SA3_MODEL_DIR) { $env:MOSH_SA3_MODEL_DIR } else { "E:\comfy4_models\unet" }
            $cudaConfig = Join-Path $cudaModel "model_config.json"
            $cudaWeights = Join-Path $cudaModel "model.safetensors"

            if ((Test-Path -LiteralPath $cudaPython) -and
                (Test-Path -LiteralPath $cudaConfig) -and
                (Test-Path -LiteralPath $cudaWeights)) {
                $env:MOSH_SERVICE_PYTHON = $cudaPython
                $env:MOSH_SA3_MODEL_DIR = $cudaModel
            } else {
                $sa3Dir = if ($env:SA3_MLX_DIR) { $env:SA3_MLX_DIR } else { Join-Path $HOME "AI\stable-audio-3\optimized\mlx" }
                $sa3Script = Join-Path $sa3Dir "scripts\sa3_mlx.py"
                if (-not (Test-Path -LiteralPath $sa3Script)) {
                    throw "Real SA3 gate requested, but neither Windows CUDA SA3 ($cudaPython, $cudaModel) nor SA3_MLX_DIR is available at $sa3Dir"
                }
            }
            $env:MOSH_ENABLE_SA3 = "1"
            $env:MOSH_SELFTEST_SA3 = "1"
            $env:MOSH_RENDER_WAIT_TIMEOUT_MS = "600000"
        } else {
            $env:MOSH_ENABLE_SA3 = "0"
            Remove-Item Env:\MOSH_SELFTEST_SA3 -ErrorAction SilentlyContinue
        }

        $tmpBase = Join-Path $env:TEMP ("mosh-selftest-" + [guid]::NewGuid().ToString("N"))
        $stdout = "$tmpBase.out"
        $stderr = "$tmpBase.err"
        $proc = Start-Process -FilePath $Exe -ArgumentList @("--selftest") -Wait -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout | ForEach-Object { Write-Host $_ } }
        if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr | ForEach-Object { Write-Host $_ } }
        Remove-Item $stdout,$stderr -ErrorAction SilentlyContinue
        if ($proc.ExitCode -ne 0) {
            throw "Mosh --selftest failed with exit code $($proc.ExitCode)"
        }
    } finally {
        if ($null -eq $oldNoAudio) { Remove-Item Env:\MOSH_NO_AUDIO -ErrorAction SilentlyContinue } else { $env:MOSH_NO_AUDIO = $oldNoAudio }
        if ($null -eq $oldEnableSa3) { Remove-Item Env:\MOSH_ENABLE_SA3 -ErrorAction SilentlyContinue } else { $env:MOSH_ENABLE_SA3 = $oldEnableSa3 }
        if ($null -eq $oldSelftestSa3) { Remove-Item Env:\MOSH_SELFTEST_SA3 -ErrorAction SilentlyContinue } else { $env:MOSH_SELFTEST_SA3 = $oldSelftestSa3 }
        if ($null -eq $oldServicePython) { Remove-Item Env:\MOSH_SERVICE_PYTHON -ErrorAction SilentlyContinue } else { $env:MOSH_SERVICE_PYTHON = $oldServicePython }
        if ($null -eq $oldSa3ModelDir) { Remove-Item Env:\MOSH_SA3_MODEL_DIR -ErrorAction SilentlyContinue } else { $env:MOSH_SA3_MODEL_DIR = $oldSa3ModelDir }
        if ($null -eq $oldServicePort) { Remove-Item Env:\MOSH_SERVICE_PORT -ErrorAction SilentlyContinue } else { $env:MOSH_SERVICE_PORT = $oldServicePort }
        if ($null -eq $oldRenderWait) { Remove-Item Env:\MOSH_RENDER_WAIT_TIMEOUT_MS -ErrorAction SilentlyContinue } else { $env:MOSH_RENDER_WAIT_TIMEOUT_MS = $oldRenderWait }
    }
}

Push-Location $Root
try {
    $CMake = Find-CMake

    Invoke-Native "configure Windows PC build" {
        & $CMake --preset windows-pc-debug
    }

    if (-not $SkipAppBuild) {
        Invoke-Native "build Mosh app" {
            & $CMake --build --preset windows-pc-app --parallel
        }
    }

    Invoke-Native "build C++ test target" {
        & $CMake --build --preset windows-pc-tests --parallel
    }

    Invoke-Native "build deterministic VST3 fixture" {
        & $CMake --build --preset windows-pc-plugin-fixture --parallel
    }

    $MoshTests = Find-FirstExe "MoshTests.exe"
    $MoshExe = Find-FirstExe "Mosh.exe"

    Invoke-Native "run MoshTests" {
        & $MoshTests
    }

    Invoke-Native "run Mosh command-surface selftest" {
        Invoke-MoshSelfTest -Exe $MoshExe
    }

    if (-not $SkipE2E) {
        Invoke-Native "run PC command-surface E2E" {
            $e2eArgs = @("-NoProfile", "-File", (Join-Path $Root "scripts\e2e-pc-build.ps1"), "-MoshExe", $MoshExe)
            if ($KeepArtifacts) {
                $e2eArgs += "-KeepArtifacts"
            }
            & pwsh @e2eArgs
        }
    }

    if ($RealSA3) {
        Invoke-Native "run real SA3 selftest" {
            Invoke-MoshSelfTest -Exe $MoshExe -WithRealSA3
        }
    }

    Write-Host ""
    Write-Host "PC build verification passed."
} finally {
    Pop-Location
}
