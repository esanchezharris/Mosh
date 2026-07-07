# Windows/PC port refresh + release path — design

*Date: 2026-07-07 · Backlog: FIT-010 (`docs/fitness-check/REPORT-2026-07-07.md`) · Author: autonomous build*

## Context & constraint

The Windows/CUDA port last had meaningful work on 2026-06-20 (`962a03fd`, `run-mosh.ps1`).
Since then ~220 commits landed macOS-first with no Windows path: companion controller
(#239), FMS SoulX sing (#226/#229), training/SFT (#217–#235), skeleton promotion (#227),
plus MoshFX, robustness, and the notarized-release pipeline. Windows also ships the `.exe`
straight from the build tree — no packaging, no bundled brain.

**Hard constraint:** this design was produced on macOS (arm64). The actual
build/smoke/verify steps (`run-mosh.ps1 -Build`, `-Smoke`, `verify-pc-build.ps1`) require
the owner's Windows box (VS 2022 generator). They are **not** executed here. The deliverable
is *everything staged so the owner runs one command on Windows*, plus a macOS-verifiable
proof that none of the shared-code changes regress the canonical platform.

### Reconnaissance result (three read-only audits)

- **MSVC compile drift: zero critical breakages.** Every POSIX call is already
  `#if JUCE_WINDOWS`-guarded; every `.mm` is `if(APPLE)`-guarded with a
  `NativeSpeech_stub.cpp` for non-Apple. `GenerativeJobManager.cpp` already has a tier-4
  lookup for `<exeDir>\service\server.py` — i.e. the **intended Windows shape is a flat
  layout**: `Mosh.exe` with `ui\`, `drumkits\`, `service\`, `brain.env` as siblings. CMake
  already stages `ui\` (`MoshStageUI`) and `drumkits\` (non-Apple POST_BUILD) next to the exe.
- **Two shared-code paths are macOS-hardcoded** and must be forked for Windows:
  `BrainProxy.cpp`'s `brain.env` fallback (walks the `.app/Contents/Resources` layout) and
  `server.py`'s `_venv_py()` (POSIX `bin/python` + `~/Library/Mosh/venvs`).
- **Per-feature venvs are service-dead on Windows**: every setup script is bash
  (`setup-*.sh`) with no `.ps1`; only `service/setup-sa3-cuda.ps1` exists.

## Goals / non-goals

**Goals**
1. Fix the shared-code drift so the owner's first Windows build compiles *and* the
   bundled-brain + per-feature-venv paths actually resolve on Windows.
2. Record a Windows-parity **decision** (`docs/WINDOWS_PARITY.md`): which recent macOS
   features get a Windows path now, stay macOS-only, or are genuinely asymmetric.
3. Add Windows release packaging: a `run-mosh.ps1 -Package` mode producing a zipped
   self-contained build with a bundled `brain.env` — the analogue of `run-mosh.sh deploy`.
4. Prove on macOS that (1) does not regress the canonical platform.

**Non-goals (this pass)**
- Building/running anything on Windows (owner step; captured in `docs/WINDOWS_RUNBOOK.md`).
- A real installer/MSI (deferred; the zip is the `deploy` analogue, not the notarized DMG `release`).
- Porting the asymmetric features' backends (SoulX local-CUDA render, SFT-on-local-box,
  companion Bonjour/mDNS) — these are documented recommendations, not built here.
- Authenticode signing (SmartScreen) — separate concern from this parity mirror.

## Workstream 1 — Drift fixes (shared C++/Python)

All three are macOS-verifiable: the `#else`/POSIX branches stay byte-identical, so a macOS
`--selftest` + Catch2 + golden-audio gate proves no regression.

1. **`src/brain/BrainProxy.cpp`** — the `brain.env` fallback (lines 19–23) is hardcoded to
   `currentExecutableFile → ..(MacOS) → ..(Contents) → Resources/brain.env`. Add a
   `#if JUCE_WINDOWS` branch reading `<exeDir>\brain.env` (flat), matching the convention
   already used in `GenerativeJobManager.cpp` and `cmake/BuildUI.cmake`. **Load-bearing**:
   without it, the Windows `brain.env` written by `-Package` is never read.
2. **`service/server.py` `_venv_py()`** (lines 59–73) — hardcodes `bin/python` and
   `~/Library/Mosh/venvs`. Refactor the pure path logic into a helper
   `venv_python_path(venvs_root, name, *, is_windows)` and branch: on Windows use
   `Scripts\python.exe` and a Windows venvs root (`%LOCALAPPDATA%\Mosh\venvs`, overridable
   by `MOSH_VENVS_DIR`). Tier-1 explicit env var (`WHISPER_PY`, etc.) already works
   cross-platform. Add golden `service/scripts/venv_python_path_test.py` (runs on macOS by
   passing `is_windows=True/False` explicitly — no interpreter switch needed; 3× deterministic).
3. **`src/plugins/moshfx/MoshXFeedbackPlugin.cpp`** — `uint64_t` → `std::uint64_t`
   (to-spec cleanup; `<cstdint>` is already included via `MoshFxPlugins.h`).

## Workstream 2 — Parity decision (`docs/WINDOWS_PARITY.md`)

A product artifact recording the posture (macOS/MLX canonical, Windows/CUDA additive) and a
per-feature decision matrix:

| Feature | Windows decision | Basis |
|---|---|---|
| SA3 generative (CUDA) | **Works now** | `stable_audio3_adapter` dispatches MLX→CUDA; `setup-sa3-cuda.ps1` exists |
| Lyrics generation | **Works now** | stdlib + `brain_client` (portable) |
| Native menu bar | **Works now** | JUCE `MenuBarModel` → in-window chrome; `setMacMainMenu` is `#if JUCE_MAC` |
| Per-feature venvs: transcribe / whisper / phonology / skeleton | **Windows path now** | `_venv_py` fix + generic `setup-feature-venv.ps1` |
| Per-feature venvs: sketch / transform-RAVE / flp | **Deferred follow-up** | lower value; RAVE is anira-gated OFF; flp is import-only |
| Native voice (always-on) | **macOS-only v1** | `NativeSpeech.mm`/`SFSpeechRecognizer`; stub on Windows; browser Web Speech still works |
| Companion mDNS discovery | **macOS-only v1** | `startBonjour` is `#if JUCE_MAC`; manual QR/URL pairing works; Bonjour port deferred |
| **SoulX sing** | **Asymmetric — redesign** | SSH-to-a-PC is a Mac-has-no-GPU workaround; on Windows the box *is* the CUDA GPU → future local-CUDA render branch, not a `.ps1` of `pc_render.sh` |
| **Training/SFT box** | **Asymmetric** | `src/training/` scaffold is portable; `service/sft/` is mlx-only or rented-Linux → future: point `sft_cuda_train.py` at the local box |

The doc also carries the prose analysis of the three asymmetric features (recommended
Windows-native architecture for each) and updates the ARCHITECTURE.md platform matrix + the
CLAUDE.md PC-port note to link it.

## Workstream 3 — Windows release packaging

### `run-mosh.ps1 -Package`
A new mode (symmetric with `run-mosh.sh deploy`) that:
1. Builds Release (reuses `windows-x64-release` / `windows-x64-release-app`).
2. Resolves the newest `Mosh.exe` (existing logic).
3. Stages exe + `ui\` + `drumkits\` (already next to the exe) into `dist\Mosh\`.
4. `Package-Service` — mirrors `bundle_service`'s **exact whitelist** into `dist\Mosh\service\`
   (flat, matching `GenerativeJobManager` tier-4). Uses `run.ps1` in place of `run.sh`.
5. `Package-BrainKey` — mirrors `bundle_brain_key`: same 9 keys
   (`MOSHI_BRAIN_PROVIDER`, `{OPENAI,DEEPSEEK,XAI}_{BASE_URL,MODEL,API_KEY}`), `KEY=value`
   lines, non-empty only, delete-if-empty; `icacls` to restrict the ACL (the `chmod 600`
   analogue). Written flat as `dist\Mosh\brain.env` (read by the Workstream-1 BrainProxy fix).
6. `Compress-Archive` → `dist\Mosh-win-x64.zip`.

### Whitelist drift guard
`service/scripts/bundle_completeness_test.py` currently parses only `run-mosh.sh`. Extend it
to also parse `run-mosh.ps1`'s `Package-Service` whitelist and **assert the two whitelists
are identical** (same top-level files modulo `run.sh`↔`run.ps1`, same dir set). This keeps the
mirror honest without a risky refactor of the battle-tested bash path.

### MSVC runtime (decision: dynamic CRT + bundle redist DLLs)
The repo doesn't configure the CRT either way and references no redist. Default: keep the
default dynamic CRT and have `-Package` copy the MSVC runtime DLLs
(`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll`) next to the exe via CMake's
`InstallRequiredSystemLibraries` (resolves `${CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS}`). Rationale:
most compatible across JUCE/tracktion/deps (static `/MT` risks CRT-mismatch across the whole
build graph). WebView2Loader.dll (staged by JUCE's `NEEDS_WEBVIEW2`) and any other exe-adjacent
DLLs are covered because step 3 copies the whole build-output directory. CUDA DLLs need **no**
native bundling — they live in the Python CUDA venv (`torch` wheels), pointed at by
`MOSH_SERVICE_PYTHON`.

### Generic per-feature venv setup (`service/setup-feature-venv.ps1`)
The bash `setup-*.sh` scripts are near-identical (create venv, `pip install`, write a
`.env` pointer). One parametrized PowerShell script driven by a per-feature requirements
manifest (`service/scripts/win_feature_venvs.psd1` or inline table) covering
**transcribe / whisper / phonology / skeleton** now, writing the same `.<feature>.env` →
`<FEATURE>_PY` pointer the bash scripts write (so `_venv_py` tier-1 resolves it). Venvs land
under `%LOCALAPPDATA%\Mosh\venvs\<feature>` (or `MOSH_VENVS_DIR`). Per-feature specifics
(e.g. `setuptools<81` for basic-pitch, nltk data for phonology) live in the manifest.

## Verification plan

**macOS-side (executed here):**
- macOS Release build stays green: `--selftest` ×3 deterministic, Catch2, `verify.py --gate`
  golden-audio. Proves the BrainProxy `#else` + MoshFX + server.py changes are byte-neutral on Mac.
- `service/scripts/venv_python_path_test.py` (new) 3× deterministic.
- `service/scripts/bundle_completeness_test.py` (extended) passes — bash↔ps1 whitelists match.
- PowerShell is authored pattern-faithfully; `pwsh` is absent on this Mac, so first-run
  syntax verification is the owner's step (documented).

**Windows-box (owner, via `docs/WINDOWS_RUNBOOK.md`):**
`run-mosh.ps1 -Build` → `-Smoke` → `scripts\verify-pc-build.ps1 -Repeat 3` → `-Package` →
optional `setup-feature-venv.ps1` per feature → optional `-RealSA3`.

## Deliverables

- Code: `BrainProxy.cpp`, `service/server.py` (+ test), `MoshXFeedbackPlugin.cpp`.
- Packaging: `run-mosh.ps1 -Package`, extended `bundle_completeness_test.py`,
  `service/setup-feature-venv.ps1` (+ manifest).
- Docs: `docs/WINDOWS_PARITY.md`, `docs/WINDOWS_RUNBOOK.md`, ARCHITECTURE.md + CLAUDE.md edits.
- Proof: macOS gate output pasted into the PR/commit body.

## Risks / open items

- **Cannot prove the Windows build here.** Mitigated by the zero-critical-drift audit +
  macOS regression proof + a precise runbook. Residual breakage is a fast follow-up.
- **`RealtimeAudioGuard`** (Debug-only global `operator new`) — standard-conformant but
  unproven on MSVC's Debug CRT; runbook flags one Debug smoke test.
- **MoshFX golden-audio** may *flake* (not break) under MSVC `/fp` vs Clang; the golden gate
  is macOS-anchored, so this is a Windows-CI note, not a blocker.
- **Companion on Windows** functions via manual pairing but has no mDNS auto-discovery;
  recorded as a known gap, not silently shipped as "works".
