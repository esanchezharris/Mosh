# 2026-07-17 Windows/CUDA port audit

*Read-only static audit of the Windows + NVIDIA/CUDA port on `origin/main` @ `0b6b1b34`
(2026-07-17). No Windows hardware, no MSVC/CUDA toolchain available on this Mac — every
claim below is either (a) static code/config evidence with `file:line` citations, (b) a
hermetic Python test actually **run** on this machine, or (c) explicitly marked UNKNOWN.
Prior audits: FIT-010 (2026-07-07, `docs/WINDOWS_PARITY.md` §"reconnaissance") and — more
recently and much stronger — **FIT-013 (2026-07-16)**, which included a **real SSH pass
against the owner's physical Windows/RTX-4070 box** (`docs/2026-07-16-pc-full-gate-report.md`):
native build, `--selftest` ×3, real SA3-CUDA render, runtime-LoRA smoke, anira/RAVE insert,
packaging, tsc/vitest/e2e — all green. This audit's job was narrower: **the ~49 commits that
landed between FIT-013's last Windows-specific fix (`05305cce`) and current `main`
(`0b6b1b34`)**, plus a fresh read of the pre-existing tree, to catch anything that drifted
since the last hardware-verified pass.*

## Summary tally

| | count |
|---|---|
| GREEN (confirmed correct/coherent) | 17 |
| GAP (confirmed real problem) | 3 |
| UNKNOWN (needs Windows hardware/toolchain to verify) | 4 |

One GAP was small, clearly-correct, and Windows-only — **fixed in this session** (see
"Guard fix applied" below). The other two are process/test-coverage gaps, reported only.

---

## 1. Platform forks since the port

**GREEN.** Read every `.cpp`/`.h` touched in the 49 commits since `05305cce` (`git diff
05305cce..HEAD --stat`, 19 files, +2658/-171) plus a fresh repo-wide grep for POSIX-only
headers/calls. Found zero unguarded POSIX usage, zero new bare fixed-width-int MSVC-namespace
risks, zero hardcoded `/`-separators in engine/state code.

- **`src/plugins/hosting/PluginHost.cpp`** (FIT-003 bounded-scan PR #348, the area the task
  flagged as highest-risk for "process spawning + plugin OOP scan"): `killScanWorkers()`
  (lines 27–45) is correctly `#if JUCE_WINDOWS` (documented no-op, Toolhelp32 impl deferred)
  `/ #else` (POSIX `pkill -P`, `<unistd.h>` included only inside `#if ! JUCE_WINDOWS` at
  line 8). The new FIT-003 bookkeeping (`blockPluginWithReason`/`loadBlockReasons`/
  `saveBlockReasons`/`blockReasonsFile`, `PluginHost.cpp:100-128,537-556`) uses only portable
  `juce::File`/`juce::StringPairArray` — `File::getSpecialLocation(userApplicationDataDirectory)`
  resolves correctly to `%APPDATA%\Mosh` on Windows. `src/moshops/ScanProgress.h` (new,
  header-only) is `juce_core`/`juce_data_structures` only. **Confirmed correct.**
- **`src/remote/RemoteCompanionServer.cpp`** (not touched in the recent delta, re-verified
  as still-correct): POSIX socket headers guarded `#if ! JUCE_WINDOWS` (lines 7–11); Bonjour
  `#if JUCE_MAC` (lines 14, 840, 867) — matches the documented "mDNS macOS-only" posture.
- **`src/generative/GenerativeJobManager.cpp`** (spawn-backoff + early-bail + `submitJob`
  stale-pair clear, lines 194–260, 291–301): all new code is `juce::Time`/`juce::Thread::sleep`/
  `SystemStats::getEnvironmentVariable`/`juce::File` — portable. The pre-existing
  `#if JUCE_WINDOWS` (direct `py -3`/`python`/`$MOSH_SERVICE_PYTHON` spawn, lines 226–234) vs
  `#else` (`run.sh`-mediated spawn with an explicit env-forward allowlist, lines 236–252) shape
  is **unchanged** — the delta only appends 2 new keys (`MOSH_LORA_DIR`, `MOSH_ENABLE_LORAS`)
  to the existing allowlist, in the exact established pattern. Same shape/delta in
  `src/training/TrainingJobManager.cpp:91-95`.
- **`src/multiplayer/{MultiplayerClient,MultiplayerSession,TransferQueue,LockManager}.{cpp,h}`**
  (biggest diffs in the window — MultiplayerSession +318/-, MultiplayerClient +139/-,
  TransferQueue new at 109+95 lines): grepped for `std::thread|pthread|unistd|fork(|dlopen|
  File::separatorString|getSpecialLocation|"/"` — only hits are portable `std::thread` /
  `std::mutex` (e.g. `TransferQueue.cpp:11`, `MultiplayerSession.cpp:337`). Zero OS-specific
  code. `mp_fetch_missing_stems`'s blob-fetch background thread
  (`src/moshops/MoshOps.cpp:3330-3369`) is pure `juce::File`/`juce::MessageManager::callAsync`.
- **`e29001cf` "easy warp"** (`stretch_clip`/`detect_clip_bpm`, the one new pure-C++ DSP
  addition in the window, `src/moshops/MoshOps.cpp` new `detectBpmFromFile`): only
  `std::sqrt`/`std::llround`/`std::floor`/`std::vector`/`std::pair` — no intrinsics, no SIMD,
  fully portable.
- **No new bare fixed-width-int types**: `git diff 05305cce..HEAD -- 'src/*.cpp' 'src/*.h' |
  grep uint64_t|uint32_t|...` → zero hits (the one prior instance of this bug class,
  `src/plugins/moshfx/MoshXFeedbackPlugin.cpp`, was fixed in FIT-010 commit `24d5047e`
  — `uint64_t`→`std::uint64_t`, "to-spec" — and stays fixed; unqualified `size_t` casts in
  that same file were deliberately left alone, matching the C++ standard's guarantee that
  `size_t` (unlike the fixed-width types) lives in the global namespace via `<cstddef>`).
- **`CMakeLists.txt`** (`+1` line since `05305cce`: `src/multiplayer/TransferQueue.cpp` added
  to `target_sources`, matching the new file) — no missing source-file registrations found for
  any other file touched in the window. Windows-specific blocks (WIN32/MSVC redist DLL
  staging lines 330-341 and anira LibTorch DLL staging lines 209-246) are unchanged
  and structurally sound.

## 2. Generative service — Windows/CUDA branches

**GREEN**, with the one real GAP called out separately in §5/§6 below.

- **`service/server.py:69-105`** — `venv_python(base_dir, is_windows)` (host-agnostic,
  built on `ntpath`/`posixpath` rather than the ambient `os.path` specifically so it's
  unit-testable on any host) and `_venvs_root()`/`_venv_py()` (explicit-env-var →
  `%LOCALAPPDATA%\Mosh\venvs`/`~/Library/Mosh/venvs` conventional path →
  legacy in-tree `.venv`) are unchanged since FIT-010 and still coherent with the shipped
  `service/setup-feature-venv.ps1`. **Verified by running `service/scripts/venv_python_path_test.py`
  — 6/6 PASS** (see Gate results below).
- **`service/server.py:37-45`** — Windows-only stdout/stderr→tempfile redirect
  (`os.name == "nt"`, opt-out via `MOSH_SERVICE_CONSOLE=1`) so a JUCE-spawned child with
  undrained pipes can't wedge; correctly scoped.
- **`service/brain_client.py:26-59`** — `_load_brain_env()`'s walk-up (checks
  `d/brain.env` AND `d/Resources/brain.env` at every one of 6 parent levels) correctly finds
  the flat Windows layout's `<dist>\brain.env` (a direct parent of `service\`) despite the
  docstring's macOS-flavored prose ("Contents/Resources/brain.env") — traced by hand: at
  `d = dist\Mosh\service`, iteration 2 checks `d = dist\Mosh` → `dist\Mosh\brain.env` — a
  hit. Confirmed this matches where `run-mosh.ps1:237` (`Write-BundledBrainKey (Join-Path
  $dist "brain.env")`) actually writes it. **Cosmetic-only nit: the docstring should say
  "or the flat Windows dist layout," not a functional bug.**
- **`service/adapters/stable_audio3_adapter.py:37-78`** — `available()`/`backend_name()`/
  `render()` all try `sa3.engine.engine_available()` (MLX) first, then fall through to
  `adapters.stable_audio3_cuda` — confirmed this dispatch is genuinely platform-neutral
  (MLX import failure on Windows is caught, not fatal).
- **`service/adapters/stable_audio3_cuda.py`** — LoRA-rack integration (lines 243-370,
  added/reworked in the FIT-013→hybrid-rework window) correctly imports the SAME shared
  math oracle `service/sa3/lora_merge.py` (`from sa3 import lora_merge as LM`, line 295) that
  the MLX engine uses, calling `LM.apply_dora(torch, ...)` with `xp=torch` — the shared
  function (`lora_merge.py:102-121`) is explicitly triple-backend-duck-typed (numpy/mlx/torch,
  with a `hasattr(V,"astype")` fork for torch's different `keepdim`/`.to()` API). This is
  **not** a reimplementation that could drift from the MLX math — it is the identical
  function. **Verified: `service/scripts/lora_merge_math_test.py` 19/19 PASS**,
  **`service/scripts/lora_registry_test.py` 45/45 PASS**,
  **`service/adapters/sa3_cuda_sampler_env_test.py` 6/6 PASS** (this one is explicitly
  documented as "the module's top-level imports are torch-free… loads with no GPU/no
  stable_audio_3" — confirmed it really did import & run with no torch/CUDA installed here).
- **`service/loras/registry.py`** — stdlib-only (`hashlib`/`json`/`os`/`struct`, asserted by
  its own test: "registry has no 'import numpy'/'torch'/'mlx'"), `lora_dir()` uses
  `os.path.expanduser(...)` + `os.path.join(...)` (both OS-correct on Windows); the single
  `/loras` HTTP route (`server.py:804-813`) is adapter-agnostic, so MLX and CUDA both see the
  identical registry contract.
- **`service/sa3/engine.py`** diff since `05305cce` (LoRA_APPLY_VERSION bump, time-scheduled
  steering hook) is 100% inside the `import mlx.core as mx` MLX engine — zero Windows
  relevance, confirmed by reading the diff.

## 3. Build config coherence

**GREEN**, one **UNKNOWN** (real MSVC compile, no toolchain here).

- **`CMakePresets.json`**: `windows-x64-debug`/`windows-x64-release`/
  `windows-x64-release-anira` all reference targets that exist —
  `Mosh`/`MoshStageUI` (`cmake/BuildUI.cmake`), `MoshTests` (`tests/CMakeLists.txt`),
  `MoshTestTonePlugin_VST3` (`src/plugin_fixtures`). `MoshFixInfoPlist` (APPLE-only target)
  is correctly **not** referenced by any `windows-x64-*` buildPreset.
  `windows-x64-release-anira` correctly sets `MOSH_BUILD_PLUGIN_FIXTURES: OFF` +
  `MOSH_ENABLE_ANIRA: ON` + pins `CMAKE_BUILD_TYPE: Release` (matches the documented
  "anira Release-only, LibTorch CRT mismatch in Debug" constraint,
  `CMakeLists.txt:33-38` in `run-mosh.ps1`, and `docs/WINDOWS_PARITY.md` line 41).
- **`scripts/verify-pc-build.ps1`** (235 lines) carries `-RealSA3`/`-RealLoRA`/`-RealRave`/
  `-RealTrainer`/`-PyGoldens` switches — **kept current** with every FIT-013 feature
  (confirmed these are the same flag names the 2026-07-16 PC gate report actually invoked
  over SSH).
- **`service/setup-sa3-cuda.ps1`, `service/setup-feature-venv.ps1`,
  `service/training/serve-trainer.ps1`, `service/run.ps1`** all exist, are referenced
  correctly from `docs/WINDOWS_RUNBOOK.md`, and (`service/run.ps1`, read in full, 42 lines)
  is a clean, minimal, correct interpreter-resolution launcher.
- **UNKNOWN — attempted `cmake --preset windows-x64-release`**: fails immediately at
  generator selection —
  `CMake Error: Could not create named generator Visual Studio 17 2022` — **before any
  CMakeLists.txt parsing occurs**, so this yields **zero config-level signal**, exactly as
  the task anticipated. No CMake variable/target/syntax errors were surfaced because the
  tool never got far enough to check them. A real Windows box with VS2022 installed is
  required for any further signal here.
- **Related gap, not a build-config bug**: **no Windows CI job exists at all** —
  `.github/workflows/ci.yml:40,104` is `runs-on: macos-14` (×2 jobs) and
  `.github/workflows/linux-ci.yml:44` is `runs-on: ubuntu-latest`; grepped the whole
  `.github/workflows/` dir for `windows` — zero hits. See Finding #3 below.

## 4. `run-mosh.ps1` vs `run-mosh.sh` diff

**One real GAP found and fixed** (§5). Everything else compared line-for-line is coherent:

- Both scripts' brain-key bundling (`bundle_brain_key`/`Write-BundledBrainKey`) write the
  same 9 keys in the same `KEY=value` format to the same flat-vs-bundle-relative location,
  with the same "owner-only ACL" security posture (`chmod 600` vs `icacls ... /grant:r
  $env:USERNAME:F`) and the same BOM-avoidance care on the Windows side
  (`run-mosh.ps1:157-161`, `UTF8Encoding($false)`).
  **Verified: `service/scripts/bundle_completeness_test.py` "run-mosh.ps1 top-level .py
  whitelist == run-mosh.sh" and "...dir whitelist == run-mosh.sh" both PASS** — the
  `$topFiles` (6 files) and `$dirs` (14 dirs) arrays are byte-for-byte identical to bash's.
- `run-mosh.ps1`'s package step (`-Package`) mirrors `run-mosh.sh deploy`'s shape: build →
  resolve the newest exe → stage `ui\`/`drumkits\`/DLLs/`service\`/`brain.env` → zip. Dev
  launcher `service/run.ps1` intentionally does **not** try to replicate `run.sh`'s 9-file
  dotenv-sourcing cascade or its `SA3_MLX_DIR`/`COLORRACK_DATA` MLX-flavored defaults — traced
  why this is fine, not a gap: (a) MLX never loads on Windows regardless (the CUDA path is
  reached purely because `sa3.engine.engine_available()` fails, §2), so `.sa3.env`/
  `SA3_MLX_DIR` are irrelevant there; (b) `_venv_py()`'s own fallback chain (§2) already finds
  per-feature venvs at the Windows conventional location without needing a dotenv source; (c)
  the native app's spawn path (§1) **never invokes `run.ps1` at all** — it launches
  `server.py` directly (`GenerativeJobManager.cpp:226-234`), relying on normal Windows
  process-environment inheritance from whatever launched `Mosh.exe` (typically
  `run-mosh.ps1`, which already loaded `ui\.env.local` into `$env:` before spawning). The one
  dotenv source that *is* meaningfully asymmetric (`.recipe.env` → `MOSH_RECIPE_LIBRARY`) has
  a safe bundled default (`service/recipes/generate.py:33`, `LIB_DIR = .../recipes/library`,
  which *is* bundled) — low severity, folded into the fix below for completeness rather than
  filed separately.

## 5. GAP #1 (HIGH severity) — `run-mosh.ps1` didn't bundle `service/teardown/` — FIXED

**`generate_beat_recipe` — a live, undo-transacted MoshOps command — would 500 with
`ModuleNotFoundError: No module named 'teardown'` on any `-Package`d Windows build.**

Evidence chain, each link confirmed by direct read:
1. `service/server.py:379-382` (`_generate_recipe_payload`, called from the `/generate_recipe`
   HTTP route at `server.py:1211-1213`) does
   `from teardown import recipe as recipe_model` and
   `from teardown.render.compile import compile_recipe`.
2. That route is reachable from native: `src/generative/GenerativeJobManager.cpp:456-467`
   (`generateBeatRecipe`) → `src/moshops/MoshOps.cpp:970` (dispatch) →
   `MoshOps.cpp:6027-6136` (`cmdGenerateBeatRecipe`, a **complete** command — validates args,
   calls the service, `undoManager().beginNewTransaction("generate_beat_recipe")` at line
   6059, `logLine`s to the JSONL command log, returns a structured result). This is live,
   actively-developed code (22 commits touched `service/teardown/`+`service/recipes/` since
   2026-06-01), not dead/experimental scaffolding.
3. `run-mosh.sh`'s `bundle_service()` correctly ships it:
   `run-mosh.sh:167` (`mkdir -p ... "$SVC/teardown/render"`),
   `run-mosh.sh:186-187` (`cp .../teardown/recipe.py $SVC/teardown/` and
   `cp .../teardown/render/compile.py $SVC/teardown/render/`).
4. `run-mosh.ps1`'s `Copy-ServiceBundle` (lines 87-139, pre-fix) had **zero** mentions of
   `teardown` anywhere — confirmed via `grep -n teardown run-mosh.ps1` → no match, before this
   session's fix. `service/teardown/` is also not a member of the `$dirs` whole-dir whitelist
   (correctly so — that directory also contains `discovery_smoke_test.py`, `scout.py`,
   `midi_ingest.py`, `catalog.py`, `cli.py`, `kb/`, `probe/`, `flywheel/`, `drummatch/`,
   `midi_from_screen/`, `youtube.py` — dev/offline tooling that bash *also* deliberately does
   NOT whole-dir-ship, copying only the 2 files the live route needs).

**Fix applied this session** (`run-mosh.ps1`, Windows-only PowerShell, zero macOS build
surface):
- Added `"$SvcDest\teardown\render"` to the initial directory-creation loop (line 91).
- Added `"teardown\recipe.py"`, `"teardown\render\compile.py"` to the `$extras` array
  (mirrors bash's individual `cp` lines exactly) plus a comment explaining why
  `bundle_completeness_test.py` doesn't catch this class of drift (see GAP #2).
- Added `".recipe.env"` to the machine-local-pointer copy loop, for full symmetry with bash's
  `.recipe.env` handling (low-severity completeness fix, §4).

**Verified:** `service/scripts/bundle_completeness_test.py` re-run post-fix — still 0
failures (expected: this test's ps1↔sh comparison doesn't exercise the extras it fixed —
see GAP #2). Manual trace of the resulting `Copy-ServiceBundle` logic confirms
`teardown\recipe.py` and `teardown\render\compile.py` now land at the destination paths
`from teardown import recipe` / `from teardown.render.compile import compile_recipe` need.
Brace/paren balance of the edited file is unchanged (0/0) — a cheap syntax sanity check in
lieu of an actual PowerShell parse (no `pwsh`/`powershell` binary exists on this Mac to
execute or even syntax-check the file — confirmed absent).
**This fix has NO macOS build surface** (a `.ps1` file, never read by CMake or any macOS-run
test/binary) — the "build MoshTests, prove macOS still compiles" gate is not applicable to
it; no `.cpp`/`.h`/`CMakeLists.txt` file was touched in this session.

## 6. GAP #2 (MEDIUM severity) — the sh↔ps1 parity test has a blind spot

`service/scripts/bundle_completeness_test.py:191-205` is the hermetic test whose entire
purpose is "catch bash/ps1 service-bundle drift before it ships." It compares:
- `ps1_files == bundled_files` (the `$topFiles` array vs bash's top-level `cp` list), and
- `ps1_dirs == bundled_dirs` (the `$dirs` whole-dir-whitelist array vs bash's `for d in ...`).

It does **not** compare the "extras" — individual partial-directory file copies
(`teardown\recipe.py`, `transcribe\transcribe_cli.py`, etc.) — for cross-script parity at
all. The function `_referenced_dirs()` (lines 61-67) that *would* catch this is only ever
applied to bash's own body (feeding the "every top-level module imported by bundled code is
bundled" self-check at lines 153-173), never to ps1's body. **This is exactly why GAP #1
shipped undetected**: I re-ran this test both before and after the fix
(`python3 service/scripts/bundle_completeness_test.py`) and it reports **0 failures in both
states** — it is structurally blind to this class of bug.

**Recommendation (not implemented this session — scoped out per the task's "no large
refactors" instruction, and a rushed regex-parser addition risks a subtly-wrong check that's
worse than no check):** add a `_ps1_extras()` parser (mirroring `_array()`'s existing
`$topFiles`/`$dirs` extraction, applied to the `$extras` array + the pointer-copy `foreach`
list) and assert its *referenced package names* match bash's `_referenced_dirs(body)` output.
Should be maybe 15-20 lines, same style as the existing `_ps1_whitelist()` helper.

## 7. GAP #3 (MEDIUM severity, process/infra, not a code bug) — no Windows CI

`.github/workflows/` has exactly two workflows, `ci.yml` (`runs-on: macos-14`, 2 jobs) and
`linux-ci.yml` (`runs-on: ubuntu-latest`, exploratory-spike-tier). Zero Windows runner jobs
exist. Every Windows verification to date — FIT-010's static reconnaissance, FIT-013's build,
and the 2026-07-16 PC gate report — was a **manual, human-triggered pass** (SSH to the
owner's physical PC). There is no automatic backstop between passes, which is precisely how
GAP #1 could sit undetected for however long between the last real-hardware run
(2026-07-16, before `05305cce`) and today: nothing re-ran `run-mosh.ps1 -Package` on real
Windows in between. **Recommendation:** even a Windows **config-only** CI job (`cmake
--preset windows-x64-release`, no build, on `windows-latest` — free/available on GitHub-hosted
runners, unlike a GPU) would have caught real MSVC-visible CMake errors on every PR; a full
build+`--selftest` job is the stronger (costlier) option. Out of scope to implement here
(infra decision, not a "small guard fix").

## 8. Minor / low-priority notes (not top-5, included for completeness)

- **`docs/WINDOWS_RUNBOOK.md:163-164`**'s own troubleshooting section says a service-route 500
  means "the bash↔ps1 service whitelist drifted — `python service\scripts\bundle_completeness_test.py`
  names the missing module." Per GAP #2 this is not reliably true for the extras class of
  drift (GAP #1's class) — the test would report clean while the bug is real. Worth a doc
  caveat once/if GAP #2 is addressed; not fixed in this pass (docs, not code, and low-value
  without the test fix landing first).
- **`service/sa3/guest/sa3_mlx.py`** (868 lines, new since `05305cce`) and
  **`service/sa3/guest/dit_mlx_medium.py`** (492 lines) import `mlx.core`, `termios`, and
  `tty` at module top level — all three are POSIX/Apple-Silicon-only with **no Windows
  equivalent**. Confirmed via `grep -rln "sa3\.guest\|sa3/guest"` that **nothing in the live
  service/adapter code path imports from `sa3.guest.*`** (the only hit outside the directory
  itself is a doc-comment in `service/colors/ortho.py:5` referencing the file by path, not an
  import) — so this is inert dead weight in the Windows package (it rides along because
  `sa3/` is a whole-dir whitelist entry on both scripts), not a live bug. It is a latent trap
  if a future change ever imports from `sa3.guest` inside a shared module, and needlessly
  bloats the Windows zip. Consider excluding `sa3/guest/` from both whitelist scripts, or
  moving it to a directory outside the `sa3/` whole-dir-shipped tree.
- **`service/sft/prepare_r5_prep.py:22`** has a hardcoded absolute path
  (`/Users/emiliosanchez-harris/Library/Mosh/venvs/sft/bin/python`) to this specific
  developer's machine. `service/sft/` is already documented (`WINDOWS_PARITY.md` "Training/SFT
  box") as Apple-Silicon-locked/rented-Linux-only dev tooling, never part of the shipped
  Windows (or even shipped macOS) product surface — so this is pre-existing dev-tooling debt,
  not a Windows-port regression. Flagged only for completeness.

## Gate results (real, run on this Mac)

**Required hermetic tests** (`python3 <path>`, Python 3.12.9):

```
service/scripts/bundle_completeness_test.py   → 0 failures  (6 checks, all PASS)
service/scripts/venv_python_path_test.py      → 0 failures  (6 checks, all PASS)
service/scripts/venv_locations_test.py        → all checks passed (88 "ok" checks)
```

**Supplementary CUDA/LoRA-relevant hermetic tests** (found via grep for "HERMETIC" +
CUDA/Windows references; run as bonus evidence beyond what the task required):

```
service/adapters/sa3_cuda_sampler_env_test.py → all passed (6 checks — confirms this module's
                                                  top-level imports are genuinely torch-free)
service/scripts/sa3_cuda_contract_test.py     → OK (10 checks)
service/scripts/lora_registry_test.py         → 0 failures (45 checks)
service/scripts/lora_merge_math_test.py       → 0 failures (19 checks, incl. order-sensitivity
                                                  + f16-carry-vs-upstream-torch assertions)
```

**Full service Python test suite** (bonus, all 62 `*_test.py`/`test_*.py` files under
`service/`, not just the Windows-relevant subset): **62/62 PASS, 0 failures.**

**`cmake --preset windows-x64-release`**: attempted per the task's optional step. Failed
immediately at generator selection (no Visual Studio generator available on macOS) —
`CMake Error: Could not create named generator Visual Studio 17 2022` — **before**
CMakeLists.txt is even parsed. **Zero config-level signal obtained; this is expected and
was anticipated by the task.** Windows COMPILE remains entirely **UNVERIFIED** — no MSVC/CUDA
toolchain exists on this machine, and none of the `.ps1` scripts could be executed
(`pwsh`/`powershell` both confirmed absent from `PATH`).

**Guard fix build-proof**: not applicable. The one fix applied (`run-mosh.ps1`) is a
Windows-only PowerShell packaging script — it is never read by CMake, never executed by any
macOS build or test, and touches zero `.cpp`/`.h`/`CMakeLists.txt`. No C++ guard fix was
found or needed in this pass (everything found in `src/` was already correctly guarded — see
§1). Verification for this fix is the re-run of `bundle_completeness_test.py` (unaffected, as
expected) plus manual code trace + a brace/paren balance check (no PowerShell interpreter
available to do better).

## Top 5 prioritized gaps

| # | Severity | Effort | Finding | Evidence |
|---|---|---|---|---|
| 1 | **High** | Low — **fixed this session** | `run-mosh.ps1` never bundled `service/teardown/{recipe.py,render/compile.py}` → `generate_beat_recipe` 500s (`ModuleNotFoundError: teardown`) on every packaged Windows build | `service/server.py:379-382`, `src/moshops/MoshOps.cpp:970,6027-6136`, `src/generative/GenerativeJobManager.cpp:456-467`, `run-mosh.sh:167,186-187` vs `run-mosh.ps1` (pre-fix: 0 matches for "teardown") |
| 2 | Medium | Low-Medium | `bundle_completeness_test.py`'s sh↔ps1 parity check doesn't compare "extras" (partial-dir file copies) — structurally blind to gap #1's exact class, reports 0 failures before *and* after the fix | `service/scripts/bundle_completeness_test.py:191-205` (compares only `$topFiles`/`$dirs`, never the extras) |
| 3 | Medium | Medium (infra) | Zero Windows CI — every Windows check is a manual SSH pass; no automatic backstop between them | `.github/workflows/ci.yml:40,104` (macOS only), `.github/workflows/linux-ci.yml:44` (Linux only), no Windows workflow file exists |
| 4 | Low | Low (docs) | `WINDOWS_RUNBOOK.md`'s troubleshooting section over-trusts a test that has the gap #2 blind spot | `docs/WINDOWS_RUNBOOK.md:163-164` |
| 5 | Low | Low-Medium | `service/sa3/guest/{sa3_mlx.py,dit_mlx_medium.py}` (POSIX+MLX-only, `termios`/`tty`/`mlx` top-level imports) ride inertly into every Windows package via the `sa3/` whole-dir whitelist — dead weight + a latent trap if ever imported from a shared module | `service/sa3/guest/sa3_mlx.py:14` (`import ... termios, tty ...`); confirmed zero live imports via `grep -rln "sa3\.guest\|sa3/guest"` |

## What this audit did NOT touch

Per the task's "Hands-off" list: no MoshOps behavior changes, no engine/state logic, no
`src/brain`, no `service/skills` (doesn't exist in this tree), no landing, no
`src/telemetry`. The single applied fix is scoped entirely to a Windows-only packaging
script (`run-mosh.ps1`'s `Copy-ServiceBundle`).
