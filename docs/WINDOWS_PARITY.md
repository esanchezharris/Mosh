# Windows/PC parity — decision record

*Last updated: 2026-07-16 (FIT-013 real-time parity pass). Companion to [ARCHITECTURE.md §Platforms](../ARCHITECTURE.md#platforms-macos-canonical--windowscuda-additive) and [WINDOWS_RUNBOOK.md](WINDOWS_RUNBOOK.md).*

> **Run repo `.ps1` scripts with `pwsh` (PowerShell 7), not Windows PowerShell 5.1.**
> The repo's BOM-less UTF-8 misdecodes under 5.1 (an em-dash becomes a CP1252
> curly-quote byte that can terminate strings mid-file). Strings in `.ps1` files are
> kept ASCII as belt-and-braces, but pwsh is the supported interpreter — it is also
> what `verify-pc-build.ps1` examples use.

**Posture (unchanged):** macOS / Apple Silicon (arm64) + MLX is **canonical**. Windows +
NVIDIA/CUDA is an **additive port of the same codebase** — every fork is `#if JUCE_WINDOWS`
/ `if(WIN32)` / `os.name == "nt"`-guarded so the macOS path stays behaviour-equivalent. This
doc records, per recent feature, whether it gets a Windows path **now**, stays **macOS-only**,
or is **asymmetric** (a Windows "path" that means something different than porting the Mac
behaviour). It is a decision record, not a status board — see `docs/FEATURE_AUDIT.md` for
runtime status.

## The reconnaissance that grounds this (2026-07-07)

Three read-only audits over the ~220 commits since the port (`962a03fd`, 2026-06-20):

1. **MSVC compile drift: zero critical breakages.** POSIX calls are already
   `#if JUCE_WINDOWS`-guarded; `.mm` files are `if(APPLE)`-guarded with a non-Apple
   `NativeSpeech_stub.cpp`. The intended Windows shape is a **flat layout**: `Mosh.exe`
   with `ui\`, `drumkits\`, `service\`, `brain.env` as siblings
   (`GenerativeJobManager` already has a tier-4 `<exeDir>\service\server.py` lookup).
2. **Two shared-code paths were macOS-hardcoded** (fixed this pass):
   `BrainProxy.cpp`'s bundled-`brain.env` fallback walked the `.app/Contents/Resources`
   layout; `server.py`'s `_venv_py()` used POSIX `bin/python` + `~/Library/Mosh/venvs`.
3. **Per-feature venvs were service-dead on Windows**: every setup script was bash
   (`setup-*.sh`), no `.ps1` except `setup-sa3-cuda.ps1`.

## Decision matrix

| Feature | Decision | Basis / mechanism |
|---|---|---|
| **SA3 generative (CUDA)** | ✅ Works now | `stable_audio3_adapter` dispatches MLX→CUDA; `service/setup-sa3-cuda.ps1` + `stable_audio3_cuda.py`. The one fully-wired adapter. FIT-013 refresh: whole-clip `coverage.render` (loop/stitch), window pinned to `SA3_SECONDS` (persisted by setup), NL-guard + manifest parity with MLX. |
| **Live render-ahead — Lane A (#319)** | ✅ Ported (FIT-013) | Orchestration (`MoshOps`/`GenerativeJobManager`/`stitch.py`) was already cross-platform; the gap was the CUDA adapter's 4s default window vs `ra.winLen`=8s — fixed by the `SA3_SECONDS` pin (#332). First-window poll ceiling honours `MOSH_RENDER_WAIT_TIMEOUT_MS` for CUDA cold loads (#335). `verify-pc-build.ps1 -RealSA3` green ×3 on the owner's 4070 (2026-07-16). |
| **Runtime LoRA rack — Lane C (#319)** | ✅ Ported (FIT-013) | **Decision: torch in-memory apply** (supersedes the disk-fuse the old `lora_merge` comments anticipated) — shared `apply_dora` math (#331), engine-parity apply/restore in `stable_audio3_cuda.py` (#332). Evidence: `-RealLoRA` smoke on the 4070 — apply ≈350–450 ms, 228-param numpy-oracle match (max 1.9e-03, f16 tolerance), bit-clean restore (2026-07-16). |
| **live-RAVE tier — Lane B (#319)** | ✅ Ported (FIT-013) | `windows-x64-release-anira` preset (Release-only: anira downloads /MD LibTorch; Debug would CRT-mismatch), **CPU LibTorch by design** (anira has no CUDA plumbing; RT block inference wants CPU latency stability; parity with the Mac build). anira.dll + LibTorch DLLs staged POST_BUILD via `$<TARGET_FILE:anira>` + glob, shipped by `run-mosh.ps1 -Package -Anira` (#333, #337: RaveEngine.cpp is `/GL-` — LTCG over the torch headers OOMs link.exe). Evidence 2026-07-16: 14/14 `verify.py` checks on the anira exe, insert smoke transformed/gap-free/reset-safe. Known limitations: `torch::jit::load` uses the ANSI codepage — keep `RAVE_MODEL_DIR` ASCII; **.ts files traced with a torch newer than the pinned LibTorch 2.4.1 can load but produce silence** — re-trace with torch ≤2.4 or bump anira's LibTorch pin. |
| **LoRA trainer — local PC lane** | ⚡ Asymmetric-plus (FIT-013) | RunPod path unchanged; NEW: `service/training/serve-trainer.ps1` runs the same server on the owner's 4070 for $0 small runs (`MOSH_TRAINING_REMOTE_URL=http://<pc>:8799`, no tunnel). Unauthenticated server ⇒ trusted-LAN-only posture (bind LAN IP, Private-profile firewall, never port-forward, stop when idle) — see RUNPOD_RUNBOOK §"local PC trainer" (#334). |
| **Lyrics generation** | ✅ Works now | `service/lyrics/*` is stdlib + `brain_client` (portable); no venv, no OS assumption. |
| **Native menu bar** | ✅ Works now | JUCE `MenuBarModel`/`ApplicationCommandManager` → an in-window menu bar; only `setMacMainMenu` is `#if JUCE_MAC`. Same command set, platform-idiomatic chrome. |
| **Per-feature venvs: transcribe / whisper / phonology / skeleton** | ✅ Windows path now | `_venv_py()` Windows branch (`Scripts\python.exe`, `%LOCALAPPDATA%\Mosh\venvs`) + `service/setup-feature-venv.ps1` (manifest mirrors the bash deps). |
| **Per-feature venvs: sketch / transform-RAVE / flp** | 🟡 Deferred follow-up | Lower value: RAVE real-time is anira-gated (OFF by default); flp is import-only (PyFLP). Add to `setup-feature-venv.ps1`'s manifest when needed. |
| **Native voice (always-on STT)** | 🍎 macOS-only v1 | `NativeSpeech.mm` = `SFSpeechRecognizer` (Apple). `NativeSpeech_stub.cpp` on Windows = safe no-op. **Browser Web Speech still works** in the WebView (`ui/src/agent/voiceInput.ts`), so voice-to-agent is available a different way. |
| **Companion — pairing + phone takes** | ✅ Works now (manual pairing) | `RemoteCompanionServer` is plain `juce::StreamingSocket` — HTTP command/snapshot API, phone takes, monitoring all cross-platform. |
| **Companion — mDNS auto-discovery** | 🍎 macOS-only v1 | `startBonjour()` is `#if JUCE_MAC` (`DNSServiceRegister` via `dlsym`). Windows has no built-in mDNS; the phone can't resolve the `.local` host. Use the manual QR/URL pairing. See "Asymmetric features" below. |
| **SoulX sing (FMS Phase-3)** | ⚡ Asymmetric — redesign, not a port | See below. The SSH-to-a-PC backend is a Mac-has-no-GPU workaround; the correct Windows path is a local-CUDA render branch, **not** built this pass. |
| **Training/SFT box (#217–#235)** | ⚡ Asymmetric | See below. `src/training/` scaffold is portable; `service/sft/` is mlx-only or rented-Linux. |

## Fixed this pass (macOS-verified, Windows build is the owner's step)

- **`src/brain/BrainProxy.cpp`** — Windows branch reads `<exeDir>\brain.env` (the flat layout).
  Without it the bundled brain key is never read on Windows.
- **`service/server.py` `_venv_py()`** — Windows venvs (`Scripts\python.exe`) under
  `%LOCALAPPDATA%\Mosh\venvs` now resolve via the conventional-default tier.
  Pinned by `service/scripts/venv_python_path_test.py`.
- **`run-mosh.ps1 -Package`** — zips a self-contained `dist\Mosh\` (exe + `ui\` + `drumkits\`
  + `service\` + a bundled `brain.env`), the analogue of `run-mosh.sh deploy`. Brain-key
  bundling reaches parity (BOM-free write + owner-only ACL). The service whitelist is kept
  identical to the bash `bundle_service` by `service/scripts/bundle_completeness_test.py`.
- **`service/setup-feature-venv.ps1`** — the generic per-feature venv installer.
- **CMake** — `if(WIN32 AND MSVC)` stages the MSVC runtime redist DLLs next to `Mosh.exe`.
- **`src/plugins/moshfx/MoshXFeedbackPlugin.cpp`** — `uint64_t` → `std::uint64_t` (to-spec).

## Asymmetric features (where "Windows path" ≠ "port the Mac behaviour")

### SoulX sing — redesign, don't port the SSH shape
The FMS sing adapter (`service/adapters/soulx_adapter.py`) gates its real backend on
`MOSH_SOULX_SSH_HOST` + an enrolled voice, and `_render_real()` shells to
`/bin/bash pc_render.sh`. That architecture exists **because the Mac has no discrete GPU** —
SSH-to-a-gamer-PC is the only way to reach CUDA SoulX-Singer. On a Windows/CUDA install the
box running Mosh **is** the GPU, so:
- The hardcoded `/bin/bash` dispatch fails on Windows regardless (no bash on PATH).
- "SSH to render" is the wrong shape — the natural Windows port is a **local-CUDA render
  path** (skip SSH; run SoulX-Singer's CUDA inference via a local subprocess, exactly how
  `stable_audio3_cuda.py` runs SA3 locally instead of remotely).

**Decision:** do **not** port `pc_render.sh` to `.ps1`. When SoulX is prioritised on Windows,
add a `available()`/`render()` local-CUDA branch to `soulx_adapter.py` mirroring the SA3
MLX→CUDA precedent. Documented; not built this pass. (Memory note: SoulX already runs locally
on the Mac via MLX — both platforms *can* run it locally; the SSH-only path is Mac-GPU-absence
plumbing, not an inherent requirement.)

### Training / SFT box — two different things, one asymmetric
- `src/training/` (type-beat LoRA scaffold): **portable** — `TrainingJobManager` already has
  a `#if JUCE_WINDOWS` spawn branch (`py -3` / `python`). Only its fake-backend `autotrain.sh`
  lacks a `.ps1`; low priority behind the fake backend.
- `service/sft/` (command-emission LoRA via mlx-lm): **Apple-Silicon-locked** by mlx-lm; its
  "CUDA" story (`setup-sft-cuda.sh`) targets a **rented Linux box** (Vast.ai/RunPod), not the
  local Windows machine. On a Windows install this stays a separate rented-cloud workflow —
  Windows gets *zero* incremental benefit despite a local GPU.

**Decision:** the genuine Windows port is to point `sft_cuda_train.py` / `serve_openai.py`
(already CUDA + `transformers`/`trl`/`peft`, closer to portable than the mlx-lm lane) at the
**local** box instead of a rented one. Documented; not built this pass.

### Companion mDNS — LAN-IP fallback, not porting Bonjour
The companion HTTP server works cross-platform; only zero-conf discovery is macOS-only
(`localBonjourHost()` returns a `.local` host with no platform check). The right fix is **not**
to port Bonjour to Windows (needs the separate Bonjour SDK/service) but a **LAN-IPv4 fallback**
(show the machine's IPv4 for the QR/manual entry, skip `.local` resolution). Deferred: the
companion is UI-only over the PR #132 backend and not yet macOS-verified on real hardware, so
a blind Windows-only LAN-IP change is out of scope this pass. Recorded as a known gap.

## Not attempted (out of scope / deferred)

- A real installer/MSI (the zip is the everyday `deploy` analogue, not the notarized DMG
  `release`). Authenticode/SmartScreen signing is a separate distribution concern.
- ASIO audio (JUCE WASAPI is the current Windows audio path).
- Linux (no build path is exercised).
