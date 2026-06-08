# run-mosh-pc.ps1 — launch the Mosh PC build with the CUDA Stable Audio 3 backend.
#
# Sets the env the app + generative service read, then launches Mosh.exe. The async
# render pool spawns the Python service (in the ComfyUI venv) at startup and the SA3
# model preloads in the background, so the first ✦ render isn't a long stall. The UI
# opens in a frameless app-mode window (Edge/Chrome --app), falling back to your
# default browser if no Chromium is found.
#
# Usage:  pwsh -File run-mosh-pc.ps1            # app-mode window (default)
#         $env:MOSH_UI_MODE='browser'; pwsh -File run-mosh-pc.ps1   # force a browser tab

# ── Generative backend (CUDA Stable Audio 3) ──────────────────────────────────
$env:MOSH_ADAPTER        = "stable_audio_3"                         # 'fake' = deterministic stub
$env:MOSH_SERVICE_PYTHON = "C:\ComfyUI\venv\Scripts\python.exe"     # venv with torch+cu130 + stable_audio_3
$env:MOSH_SA3_MODEL_DIR  = "C:/mosh-models/sa3"                     # SSD (fast load); model_config.json + model.safetensors
$env:MOSH_SA3_HALF       = "1"                                      # fp16 (required to fit 12 GB)
# $env:MOSH_SA3_MAX_DURATION = "12.0"                               # OOM safety cap (seconds)

# ── Quality judge ─────────────────────────────────────────────────────────────
# 'dsp' (default) = heuristic readout. 'learned' = Meta Audiobox-Aesthetics PQ via the
# producer-lab sidecar (real learned production-quality score; falls back to DSP if the
# sidecar/venv is missing). 'none' = skip.
# $env:MOSH_JUDGE = "learned"

# ── App ───────────────────────────────────────────────────────────────────────
$env:MOSH_HTTP_PORT      = "8080"
# UI shell: 'app' (default on Windows — a frameless Edge/Chrome --app window owned by
# Mosh) | 'browser' (default system browser tab) | 'webview' (embedded; blank on this
# machine, works on macOS) | 'none' (headless).
# $env:MOSH_UI_MODE      = "app"
# $env:MOSH_NO_AUDIO     = ""          # set to '1' to skip opening an audio device

$exe = Join-Path $PSScriptRoot "build\src\app\Mosh_artefacts\Debug\Mosh.exe"
if (-not (Test-Path $exe)) {
    Write-Error "Mosh.exe not found at $exe — build it first (cmake --build build --config Debug --target Mosh)."
    exit 1
}
Write-Host "Launching Mosh (adapter=$($env:MOSH_ADAPTER), port=$($env:MOSH_HTTP_PORT))..."
Write-Host "UI: http://localhost:$($env:MOSH_HTTP_PORT)  (in-app window; browser fallback)"
& $exe
