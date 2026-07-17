# Full PC build verification — remote run over SSH (2026-07-16)

The entire Windows gate, driven from the Mac over `ssh pc` against the owner's box
(RTX 4070 SUPER, Python 3.12, VS 2022), on **current main `c6fbc6b`** (pulled at run
time) with PR #339's `rave_insert_check.py` overlaid for the RAVE lane (restored to
pristine after; verified clean). Serial phases — one machine, no contention.

## Results

| Lane | Result |
|---|---|
| MSVC configure + build (app, MoshTests, VST3 fixture) | ✅ |
| MoshTests (Catch2) | ✅ **539 assertions / 93 test cases** |
| `Mosh --selftest` ×3 | ✅ **1259/1259 ×3 deterministic** |
| Real SA3 (CUDA) selftest | ✅ Stage 5 (SA3) real-backend section: 9 checks, 30.7 s on the 4070 |
| Runtime-LoRA smoke (CUDA, `bro-sa3`) | ✅ stock vs strengths differ, tensor oracle, bit-clean restore |
| anira tree build + selftest (anira exe) | ✅ 1259/1259 |
| `verify.py --rave-insert` (real models) | ✅ **14/14** — pluma.ts transformed/gap-free/reset-safe, birds.ts auto-skipped `model_silent` |
| Packaging `run-mosh.ps1 -Package -Anira` | ✅ dist\Mosh + zip (service + brain.env + LibTorch DLLs) |
| UI typecheck (`tsc` src + e2e) | ✅ |
| vitest | 🟡 **995/998** — 2 platform-dependent test fixtures (below), 1 pre-existing skip |
| Playwright e2e | ✅ **126/126** (3.1 min, chromium) |
| Service py goldens (`py -3`, `PYTHONUTF8=1`) | 🟡 **50/54** — 4 Windows test-environment failures (below) |

Skipped: `-RealTrainer` (no `SA3_TRAIN_DIR`/trainer tree on the box). Evidence logs on
the PC: `verify-pc-gate.log`, `verify-pc-package.log`, `verify-pc-ui.log`,
`verify-pc-e2e.log` in the repo root (untracked).

## Findings — all six failures are test-environment classes, zero product-path bugs

1. **`PYTHONUTF8=1` is required to run the service goldens on Windows.** The goldens
   print `→ ⇒ ≤ ≈ ✗` in check lines; Windows Python encodes *redirected* stdout with
   the ANSI codepage → `UnicodeEncodeError: 'charmap'` crashes ~20 suites while
   printing PASS lines. With UTF-8 mode: 50/54. Any future Windows golden runner
   (CI, a `-PyGoldens` lane in `verify-pc-build.ps1`) must set it.
2. **`ui/src/import/emit.test.ts` — 2 failures, POSIX fixtures under win32 node.**
   `resolveAudioPath` uses `node:path` (correct: platform-native paths are what the
   engine opens); the tests hardcode `/Users/me/beats/...`, which win32 `resolve()`
   mangles by prepending the drive (`C:\Users\me\beats\...`). Product impact zero —
   `emit.ts` runs only in node-side lanes (import CLI, gepa/sft), never the WebView
   bundle. Fix: platform-gate the fixtures (win32 gets `C:\`-shaped equivalents).
3. **`bestofn_runtime_test` "unwritable archive dir"** — POSIX permission semantics
   assumed; Windows ignores the read-only bit on directories, so the archive
   "wrongly" succeeds. Guard or use a Windows-effective deny.
4. **`venv_locations_test`** — validates the 8 `setup-*.sh` **bash** scripts;
   inherently POSIX-only, needs a `sys.platform == "win32"` skip (the Windows
   analogue `setup-feature-venv.ps1` is covered by `venv_python_path_test`, which
   passes).
5. **`teardown/discovery_smoke_test` + `teardown/scout_test`** — `WinError 32` in
   `TemporaryDirectory` cleanup: a sqlite connection to `catalog.sqlite` /
   `tutorial-catalog.sqlite` is still open at rmtree time. POSIX allows
   unlink-while-open; Windows doesn't. Fix: close/`with`-scope the connections
   before the tempdir exits (dev-lane tests; the shipped service paths don't do
   delete-while-open).

Benign noise: `LNK4044: unrecognized option '/w'` on the anira link (a GCC-style flag
leaking from a dep; link.exe ignores it).

## Runbook notes (how to repeat)

- `ssh pc` (see the session memory `pc-ssh-verification-lane`); default shell is
  Windows PowerShell 5.1 — **stage `.ps1` files and run `pwsh -NoProfile -File`**
  rather than fighting nested `-Command` quoting.
- Core gate: dot-source `service\.sa3.cuda.ps1` (wires `MOSH_SERVICE_PYTHON`,
  `MOSH_SA3_MODEL_DIR=C:\mosh-models\sa3`), then
  `pwsh -NoProfile -File scripts\verify-pc-build.ps1 -RealSA3 -RealLoRA -RealRave -Repeat 3`.
- UI: `cd ui; npm run typecheck; npm test; npm run test:e2e` (node + playwright
  chromium already installed).
- Goldens: `PYTHONUTF8=1` + `py -3 <each *_test.py>`.
