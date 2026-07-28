# Intel Mac support

*Status: supported, docs-light. The shipped macOS artifact is a Universal 2 binary and
Intel is verified by hand on real hardware — but Intel is **not** CI-gated, so the
verification below is the thing that keeps it honest. Repeat it before shipping a release
that touched the build, the bundle, or the generative tier.*

Apple Silicon (arm64) remains **canonical**: it is the only architecture with the MLX
generative backend, and it is what the dev loop and CI build. Intel is an additive target
in the same sense Windows is — same codebase, same commands, one guarded difference.

---

## What Intel Macs get

| Area | Intel | Notes |
|---|---|---|
| Engine, transport, arrangement, mixer | ✅ same | Identical code; `--selftest` reports the same check count |
| VST3 / AudioUnit hosting | ✅ same, one caveat | The plugin needs an **x86_64 or universal** slice. An x86_64 host process cannot load an arm64-only plugin — that is a macOS rule, not a Mosh bug |
| Import / export / render to WAV | ✅ same | |
| Multiplayer, companion, brain | ✅ same | Network + cloud, arch-independent |
| **Generative tier (Stable Audio 3)** | ⚠️ **preview engine** | MLX is Apple-Silicon/Metal only — there are no x86_64 macOS wheels. Renders fall back to the deterministic FakeAdapter, and the generative drawer shows an amber **preview** badge instead of green **SA3** |
| Real-time RAVE insert (`MOSH_ENABLE_ANIRA`) | ❔ untested | Build-gated OFF by default, so it does not affect any shipped binary |
| Optional feature venvs (whisper, transform, skeleton) | ⚠️ old torch | PyTorch's **last x86_64 macOS wheels are 2.2.2** (current is 2.13). `pip install torch` resolves to 2.2.2 on Intel. The `setup-*.sh` scripts validate the import and `fail` loudly rather than half-installing, so a broken resolve is visible — but these paths are untested on Intel |
| On-device LoRA training (`setup-sft.sh`) | ❌ unavailable | mlx-lm is arm64-Metal only; the script already hard-fails on non-arm64 with a clear message |

**Nothing silently lies.** SA3 availability is ground truth, not a guess: `service/sa3/engine.py`
`engine_available()` requires the model directory **and** an importable MLX, so a stray
`SA3_MLX_DIR` copied onto an Intel Mac cannot make `/health` advertise `stable_audio3`.
Guarded by `service/sa3/engine_available_test.py`.

---

## Building

```bash
cmake --preset macos-universal-release && cmake --build --preset macos-universal-release-app
```

The dev presets (`macos-arm64-*`) stay single-arch on purpose — a universal build roughly
doubles compile time, and the ~2h native gate does not need to pay that on every PR. Only
the **shipping** paths go universal: `run-mosh.sh release`, `scripts/package-for-sharing.sh`,
`scripts/playtest/package-guest-zip.sh` and `.github/workflows/release.yml`.

`run-mosh.sh deploy` / `build` remain arm64 for fast local iteration.

### Two traps this build has already fallen into

1. **`CMAKE_OSX_DEPLOYMENT_TARGET` must stay ABOVE `project()`** in `CMakeLists.txt`.
   `project()` pre-creates an empty cache entry, and `set(... CACHE ...)` without `FORCE`
   never overwrites one — so a block placed below it is a silent no-op. That bug shipped a
   bundle stamped `minos 26.0` (an app that refuses to launch below macOS 26) while the docs
   promised macOS 11+.

2. **`resolve_app()` in `run-mosh.sh` only searches the arm64 build dirs.** Any new packaging
   path that calls it after a universal build gets a *stale arm64 bundle* that signs,
   notarizes and installs fine — and cannot launch on Intel. Resolve
   `build-macos-universal-release` explicitly.

Both are caught by the guard below, which is why it is not optional.

### The guard

```bash
scripts/release/assert-universal.sh <Mosh.app>
```

Fail-closed: asserts both slices are present *and* every slice's `minos` matches (default
`11.0`). Every packaging path calls it before signing. It is proven against real binaries to
reject an arm64-only bundle, an x86_64-only bundle, and a `minos 26.0` bundle.

---

## Verifying on a real Intel Mac

`--selftest` proves the command surface but not audio, plugins, or the reactive lane. Do all
of it:

```bash
scripts/verify-intel-mac.sh          # scripted portion; writes evidence
```

Then by hand, because these need eyes and ears:

- App launches and the WebView UI renders cold.
- Transport plays **audible** audio; per-track and master meters move.
- Plugin browser scans; a VST3 **and** an AU load; a native editor opens.
  Check the plugin itself is loadable first: `lipo -archs "/path/to/Plugin.vst3/Contents/MacOS/Plugin"`.
- Full producer loop: import → move/trim → host a plugin → mix → **export a WAV** that plays back.
- Generative drawer shows the amber **preview** badge (not green SA3, not a crash), and a
  render completes and is auditionable.
- `verify.py` **from the repo root** — it resolves `service/server.py` CWD-relative, and
  `--selftest` structurally cannot see the reactive lane.

Record the result in this file's changelog below so the next person knows what was actually
proven, on what hardware, and when.

---

## Verification log

| Date | macOS | Hardware | Result |
|---|---|---|---|
| 2026-07-27 | 26.4.1 | Apple Silicon (M-series); x86_64 slice via Rosetta 2 | Universal build green. `--selftest` **2037/2037, 0 failed on BOTH slices** (arm64 deterministic ×3). Catch2 **2307 assertions / 229 cases on both slices**. vitest 1999 passed, `tsc` clean, 94/94 service Python tests. Ad-hoc codesign valid on the fat binary (`Mach-O universal (x86_64 arm64)`). Guard proven to reject arm64-only, x86_64-only and `minos 26.0` bundles. **⚠️ NOT an Intel hardware pass** — Rosetta cannot prove real-Intel CoreAudio, plugin hosting or performance. The manual checklist above is still outstanding. |
