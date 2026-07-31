# Windows (NVIDIA/CUDA) build · smoke · verify · package — runbook

*The exact command sequence to build, verify, and package Mosh on a Windows box. Run these
natively (PowerShell), **not** under WSL. Companion decisions: [WINDOWS_PARITY.md](WINDOWS_PARITY.md).*

> **Why this is a runbook, not a CI log:** the 2026-07-07 port refresh (FIT-010) was prepared
> on macOS — the shared-code drift was fixed and macOS regression-proven, but the Windows
> build/smoke/verify below could not be run from a Mac. Run them once and report any breakage;
> the reconnaissance found **zero critical MSVC compile drift**, so a clean first build is
> expected.

## Prerequisites (one time)

- **Visual Studio 2022** with the "Desktop development with C++" workload (MSVC v143 + Windows SDK).
- **CMake** ≥ 3.24 on `PATH` (the VS installer's copy is fine).
- **Node.js** (for the Vite UI build) + **Python 3.11+** with the `py` launcher.
- **Git**. Clone with submodules (JUCE + Tracktion): `git submodule update --init --recursive`.
- Brain key (optional but recommended): paste one provider block into `ui\.env.local`
  (see `ui\.env.example`). Format: `OPENAI_API_KEY=...` etc. Never commit it.

## 1. Build + smoke

```powershell
# From the repo root:
.\run-mosh.ps1 -Build      # cmake --preset windows-x64-release ; build Mosh + MoshStageUI, then launch the GUI
.\run-mosh.ps1 -Smoke      # non-interactive native brain round-trip; prints Moshi's reply (exit 0 = ok)
```

`-Build` stages `ui\` and `drumkits\` next to `Mosh.exe` automatically (CMake targets).
If `-Smoke` reports that Moshi cannot reach its brain, no provider or proxy is configured —
check `ui\.env.local`. Packaged builds never substitute demo commands.

**After the first build, verify the exe-adjacent DLLs are present** (JUCE stages the WebView
runtime; CMake stages the MSVC redist):

```powershell
Get-ChildItem (Split-Path (Get-ChildItem -Recurse -Filter Mosh.exe build-windows-x64-release | Select -First 1).FullName) -Filter *.dll
# expect: WebView2Loader.dll, vcruntime140*.dll, msvcp140.dll
```

## 2. Verification gate

```powershell
pwsh -NoProfile -File scripts\verify-pc-build.ps1 -Repeat 3
# configure → build app+tests+VST3 fixture → MoshTests (Catch2) → Mosh --selftest ×3 (device-free, isolated port)
```

Optional, if you have the CUDA SA3 venv + weights wired (see step 4):

```powershell
pwsh -NoProfile -File scripts\verify-pc-build.ps1 -RealSA3
```

**One-time smoke worth doing (flagged by the port audit):** a **Debug** build exercises the
`RealtimeAudioGuard` global `operator new` override (Release compiles it out). It's
standard-conformant but unproven on MSVC's Debug CRT — confirm a Debug `--selftest` exits 0:

```powershell
.\run-mosh.ps1 -Build -Debug ; .\run-mosh.ps1 -Debug -Smoke
```

The UI gates are platform-agnostic — run them separately:

```powershell
cd ui ; npm ci ; npm test ; npm run test:e2e ; cd ..
```

## 3. Package a self-contained build (+ bundled brain)

```powershell
.\run-mosh.ps1 -Package
```

This builds Release and stages `dist\Mosh\` — `Mosh.exe` + `ui\` + `drumkits\` + exe-adjacent
DLLs + `service\` (the same subtree the macOS `deploy` bundles) + a `brain.env` written from
your non-empty `ui\.env.local` proxy/provider fields (owner-only ACL). It then zips it to
`dist\Mosh-win-x64.zip`.

- The folder is portable: copy it anywhere and run `Mosh.exe`. The bundled `brain.env` (read
  by the BrainProxy Windows fallback next to the exe) means Moshi has a brain on any launch —
  including a double-click that inherits no shell environment.
- Prefer proxy-only packaging with `MOSH_BRAIN_PROXY_URL` and its publishable/anon
  `MOSH_BRAIN_PROXY_APIKEY`; leave direct-provider API keys blank. If provider keys are
  included, `brain.env` holds them in cleartext and anyone with the folder/zip can read them.

## 4. Real generative / FMS features (per-feature venvs)

The packaged `service\` has the Python code but **not** the model venvs (GBs). Install them on
the target machine. Each venv lands at `%LOCALAPPDATA%\Mosh\venvs\<feature>` — exactly where
`server.py` resolves it, so no exports are needed.

```powershell
# Real Stable Audio 3 on CUDA (imagine/transform):
.\service\setup-sa3-cuda.ps1                 # validates the CUDA venv + weights; prints the env block

# FMS + Bar-IQ per-feature venvs (transcribe / whisper / phonology / skeleton):
.\service\setup-feature-venv.ps1 -Feature all
# or individually, e.g.  .\service\setup-feature-venv.ps1 -Feature whisper
```

Point the service at the CUDA SA3 venv when launching for real renders (else FakeAdapter):

```powershell
. .\service\.sa3.cuda.ps1        # if setup-sa3-cuda.ps1 wrote it, or set $env:MOSH_SERVICE_PYTHON manually
.\run-mosh.ps1                   # launches the GUI with the CUDA backend selected
```

## 5. Live-RAVE tier (anira + LibTorch) — FIT-013

The RAVE insert needs the anira build tree (separate from the default build; **Release-only**
— anira downloads release-CRT LibTorch, a Debug app against it is a CRT mismatch):

```powershell
.\run-mosh.ps1 -Build -Anira          # configure windows-x64-release-anira + build (first
                                      # configure downloads LibTorch ~190 MB — be patient)
pwsh scripts\verify-pc-build.ps1 -RealRave    # selftest on the anira exe + insert smoke
.\run-mosh.ps1 -Package -Anira        # package WITH anira.dll + torch DLLs staged
```

Drop `.ts` models into `%USERPROFILE%\AI\rave-models` (or set `RAVE_MODEL_DIR`) — the Dock's
RAVE dropdown lists them. RAVE inference runs **CPU LibTorch by design** (real-time block
inference wants CPU latency stability; anira has no CUDA plumbing) — the GPU serves SA3 +
training instead. Known limitation: LibTorch opens model paths with the ANSI codepage — keep
`RAVE_MODEL_DIR` ASCII-only. `link.exe` may warn `LNK4044: unrecognized option '-w'` from an
anira interface flag — harmless.

## 6. Local LoRA trainer on this PC — FIT-013

Small training runs can skip RunPod and use this box's GPU. The server is **unauthenticated
and executes submitted bundles** — trusted LAN only: bind the LAN IP, Private-profile
firewall rule scoped to the subnet, never port-forward, stop it when not training.

```powershell
# needs the SA3 code tree (scripts\pre_encode_dataset.py + train_lora.py) on disk:
.\service\training\serve-trainer.ps1 -Sa3TrainDir E:\stable-audio-3 -BindHost <lan-ip>
pwsh scripts\verify-pc-build.ps1 -RealTrainer   # /health probe: backend must be "real"
```

Mac side (then relaunch Mosh so it inherits the env; `launchctl unsetenv` to go back):

```bash
launchctl setenv MOSH_TRAINING_BACKEND remote_http
launchctl setenv MOSH_TRAINING_REMOTE_URL http://<pc-lan-ip>:8799
```

The client has a 60s per-request timeout (`trainer_job._post_json`) — fine over LAN for
typical corpora; if a very large bundle ever trips it, that's the knob to look at.

## Known Windows differences (see WINDOWS_PARITY.md for the full record)

- **Voice:** always-on native STT is macOS-only; on Windows use the in-app browser voice
  input. Menu bar renders in-window (not a global menu). Both are expected, not bugs.
- **Companion:** pairing + phone takes work via the manual QR/URL; there is no mDNS
  auto-discovery on Windows.
- **SoulX sing** and the **SFT training box** are *asymmetric* — they need a local-CUDA
  redesign, not a script port. Not available on Windows yet (see WINDOWS_PARITY.md).
- **Golden-audio checksums** (`verify.py --gate`) are macOS-anchored; MoshFX DSP may differ at
  the sample level under MSVC `/fp` vs Clang. That's a Windows-CI note, not a build failure.

## If something breaks

- Configure/compile error: capture the first error + `file:line`. The port audit found no
  critical drift, so a new break is likely a fresh commit — note the file.
- `--selftest` non-zero: run it directly for the full output —
  `$env:MOSH_NO_AUDIO=1 ; & <path>\Mosh.exe --selftest`.
- Service route 500 (ModuleNotFoundError) in the packaged app: the bash↔ps1 service whitelist
  drifted — `python service\scripts\bundle_completeness_test.py` names the missing module.
