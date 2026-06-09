param(
    [switch]$KeepArtifacts,
    [string]$MoshExe
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

function Resolve-MoshExe {
    param([string]$Explicit)

    if ($Explicit) {
        return (Resolve-Path -LiteralPath $Explicit -ErrorAction Stop).Path
    }

    $searchRoots = @((Join-Path $Root "build-pc"), (Join-Path $Root "build"))
    $match = $searchRoots |
        Where-Object { Test-Path -LiteralPath $_ } |
        ForEach-Object { Get-ChildItem -Path $_ -Recurse -Filter "Mosh.exe" -ErrorAction SilentlyContinue } |
        Select-Object -First 1
    if ($match) {
        return $match.FullName
    }

    throw "Mosh.exe was not found under build. Build the app first."
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
        [string]$LogPath
    )

    $oldNoAudio = $env:MOSH_NO_AUDIO
    $oldEnableSa3 = $env:MOSH_ENABLE_SA3
    $oldSelftestSa3 = $env:MOSH_SELFTEST_SA3
    $oldServicePort = $env:MOSH_SERVICE_PORT
    try {
        $env:MOSH_NO_AUDIO = "1"
        $env:MOSH_ENABLE_SA3 = "0"
        $env:MOSH_SERVICE_PORT = [string](Get-FreeTcpPort)
        Remove-Item Env:\MOSH_SELFTEST_SA3 -ErrorAction SilentlyContinue

        $stdout = "$LogPath.stdout"
        $stderr = "$LogPath.stderr"
        Remove-Item $stdout,$stderr -ErrorAction SilentlyContinue
        $proc = Start-Process -FilePath $Exe -ArgumentList @("--selftest") -Wait -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $lines = @()
        if (Test-Path -LiteralPath $stdout) { $lines += Get-Content -LiteralPath $stdout }
        if (Test-Path -LiteralPath $stderr) { $lines += Get-Content -LiteralPath $stderr }
        Set-Content -LiteralPath $LogPath -Encoding UTF8 -Value $lines
        $lines | ForEach-Object { Write-Host $_ }
        if ($proc.ExitCode -ne 0) {
            throw "Mosh --selftest failed with exit code $($proc.ExitCode)"
        }
    } finally {
        if ($null -eq $oldNoAudio) { Remove-Item Env:\MOSH_NO_AUDIO -ErrorAction SilentlyContinue } else { $env:MOSH_NO_AUDIO = $oldNoAudio }
        if ($null -eq $oldEnableSa3) { Remove-Item Env:\MOSH_ENABLE_SA3 -ErrorAction SilentlyContinue } else { $env:MOSH_ENABLE_SA3 = $oldEnableSa3 }
        if ($null -eq $oldSelftestSa3) { Remove-Item Env:\MOSH_SELFTEST_SA3 -ErrorAction SilentlyContinue } else { $env:MOSH_SELFTEST_SA3 = $oldSelftestSa3 }
        if ($null -eq $oldServicePort) { Remove-Item Env:\MOSH_SERVICE_PORT -ErrorAction SilentlyContinue } else { $env:MOSH_SERVICE_PORT = $oldServicePort }
    }
}

Push-Location $Root
try {
    if (-not $MoshExe) {
        $CMake = Find-CMake
        Invoke-Native "configure Windows PC build" {
            & $CMake --preset windows-pc-debug
        }
        Invoke-Native "build Mosh app" {
            & $CMake --build --preset windows-pc-app --parallel
        }
    }

    $exe = Resolve-MoshExe -Explicit $MoshExe
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $artifactRoot = Join-Path $Root ".e2e-artifacts\pc-build"
    $artifactDir = Join-Path $artifactRoot $stamp
    New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

    $log = Join-Path $artifactDir "mosh-selftest.log"
    Write-Host "Mosh exe: $exe"
    Write-Host "Artifacts: $artifactDir"
    Invoke-MoshSelfTest -Exe $exe -LogPath $log

    $html = Join-Path $artifactDir "pc-build-summary.html"
    $escapedLog = [System.Net.WebUtility]::HtmlEncode((Get-Content -Raw -LiteralPath $log))
    Set-Content -LiteralPath $html -Encoding UTF8 -Value @"
<!doctype html>
<meta charset="utf-8">
<title>Mosh PC E2E</title>
<style>body{font-family:Consolas,monospace;background:#111;color:#eee;padding:24px}pre{white-space:pre-wrap}</style>
<h1>Mosh PC command-surface E2E</h1>
<p>Executable: $([System.Net.WebUtility]::HtmlEncode($exe))</p>
<pre>$escapedLog</pre>
"@

    if (-not $KeepArtifacts) {
        $resolvedArtifacts = (Resolve-Path -LiteralPath $artifactDir).Path
        $resolvedRoot = (Resolve-Path -LiteralPath $artifactRoot).Path
        if ($resolvedArtifacts.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedArtifacts -Recurse -Force
        }
    }

    Write-Host ""
    Write-Host "PC E2E verification passed."
    if ($KeepArtifacts) {
        Write-Host "Artifacts kept at: $artifactDir"
    }
} finally {
    Pop-Location
}
