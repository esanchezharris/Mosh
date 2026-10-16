# Linux build spike (FIT-011)

*Date: 2026-07-07 · Status: **config landed, headless path CI-tracked, full GUI app unverified***
*Updated 2026-10-15 · Status: **full GUI app builds on Linux and its `--selftest` ×3 + `--selftest-undo` run under Xvfb as a required linux-ci stage** — see [Full app status](#full-app-status-2026-10-15).*

Exploratory spike to open a **Linux (x86_64)** build path for Mosh alongside the
canonical macOS/arm64 target and the additive Windows/CUDA port. Per the prime
directives, Linux was previously "not exercised yet." This spike adds the smallest
real build that proves the path — it does **not** aim for macOS parity.

## TL;DR

- **Headless target (`MoshTests`) + the Python service** are the proven-portable milestone.
  `MoshTests` is a `juce_add_console_app` with `JUCE_WEB_BROWSER=0` linking only
  `juce_core/data_structures/events/cryptography` — no WebView, no audio device, no
  plugin hosting — so it needs only `build-essential`/`cmake`/`ninja`. The generative
  service is stdlib-clean Python (verified importable with a bare `python3`, no venv).
- **The full GUI app** (`Mosh`, and therefore `Mosh --selftest`, which runs *inside*
  that binary) needs WebKitGTK + ALSA + node and is the **follow-up**. It is compiled
  in CI as an *informational, continue-on-error* stage so we learn how far it gets on
  real Linux without blocking the spike.
- **This Mac can't build for Linux** (arm64 macOS host, no Docker/VM). So everything
  except the CI job is **config that is only statically sanity-checked here**. The CI
  job on `ubuntu-latest` is the actual proof — **its first run is the real verdict.**

## Full app status (2026-10-15)

Measured in an Ubuntu container (x86_64, 4 vCPU, GCC, WebKitGTK 4.1) at this branch's
head, with `MOSH_ENABLE_SA3=0 MOSH_ENABLE_TRANSFORM=0`, no `DISPLAY` (so `xvfb-run -a`),
and a bare `python3` (no numpy/pydantic) like the CI runner's.

| Item | Result |
|---|---|
| `./run-linux.sh app` (linux-x64-debug) | **Builds and links `Mosh`.** ~9 min from scratch at `-j4` (tracktion/JUCE already fetched). |
| `--selftest`, Debug | **5004 checks, 0 failed**, identical count every run (5 consecutive runs after the fixes below). |
| `--selftest-undo`, Debug | **92 focused undo checks, 0 failed.** |
| JUCE assertions, Debug | 17 per `--selftest` run, 1 per `--selftest-undo` run, the same set every run (below). Reported, not fatal. |
| linux-x64-release | Not usable in CI: GCC `-O3` on `src/app/SelfTest.cpp` (~22k lines) alone ran >80 min on 4 vCPU without finishing. |

**Linux floors** (`run-linux.sh`, overridable): `MOSH_LINUX_SELFTEST_FLOOR=5004`,
`MOSH_LINUX_SELFTEST_UNDO_FLOOR=92`. These are not the mac gate's `MOSH_SELFTEST_BASELINE`
(set in the owner machine's environment, not in the repo; quoted as 1656). That is a floor
for another platform and build, not a count to match. No
selftest section was found to be macOS-only on Linux. Every check that runs here passes, so
the Linux count is the honest Linux number.

**Debug vs the native gate's Release.** `scripts/auto-loop/gate.sh` self-tests a
`macos-arm64-release` build, where `jassert` compiles out, so the gate never sees JUCE
assertions. linux-ci runs Debug (Release cannot fit the job, above), so assertions are live.
`./run-linux.sh selftest` prints them and fails on them only for a Release build. The recorded
Debug set (not investigated in this lane; all but the MIDI one are Tracktion/JUCE internals
reached by platform-neutral code):

| Count/run | Assertion | Note |
|---|---|---|
| 9 | `tracktion_AutomationCurve.h:50` | |
| 3 | `juce_UndoManager.cpp:128` | |
| 2 | `tracktion_ValueTreeUtilities.h:163` | |
| 2 | `tracktion_LoopInfo.cpp:79` | |
| 1 (+1 in undo) | `juce_Midi_linux.cpp:539` | Environmental: no ALSA sequencer (`/dev/snd/seq`) in a container/CI runner. |

**What it took** (the smallest fixes; nothing stubbed):

1. `CMakeLists.txt`: `NEEDS_WEB_BROWSER TRUE` on the app. JUCE only links WebKitGTK/GTK, and
   only adds their include dirs, when this is set (`juce_gui_extra` failed on `gtk/gtk.h`).
   JUCE reads it only on Linux/BSD. Risk 1 below is resolved: the pinned JUCE finds 4.1.
2. `src/moshops/MoshOps.ProjectIo.cpp`: an explicit `jmax<juce::int64>` made overload
   resolution instantiate juce_dsp's `SIMDRegister<long long>`, which has no `SIMDNativeOps`
   on Linux (`int64_t` is `long` there). Deducing the type gives the same value.
3. `CMakeLists.txt`: stage `resources/presets` next to the executable off macOS, like
   drumkits. `MoshOps::presetsBundledRoot` already fell back to `<exe dir>/presets`, but
   nothing put the bank there: 31 checks failed (4OSC and track-chain presets missing). This
   also applies to the Windows build.
4. `src/app/selftest/PluginPanelsSelfTest.cpp`: the 4OSC voice-mode check failed on 1 of 3
   runs (`G 0.00116` vs ~0.035). Root cause: each 4OSC oscillator starts at a random phase
   (Tracktion `MultiVoiceOscillator::start`), and `mosh-lead` stacks two saws at one pitch.
   A relative phase near π cancels their fundamental to ~3%, and the ±1.4 Hz unison detune is
   inside a 0.4 s window's resolution. The check now measures fundamental + 2nd harmonic,
   which a single phase offset cannot cancel together. The test is platform-neutral, so the
   same race can hit macOS too. That is not verified here.

**What this does not prove:** the macOS native gate, audibility, an audio device (headless
selftests run with no device), real VST3 plug-in hosting/editors, the iPhone companion,
Ableton Live 11, the installed app, or real SA3 renders.

## What changed

| File | Change |
|------|--------|
| `CMakePresets.json` | `linux-x64-debug` / `linux-x64-release` configure presets (Ninja) + build presets `linux-x64-tests` / `-app` (+ release variants). Full parity with mac/win (`APP+UI+TESTS+FIXTURES=ON`). |
| `CMakeLists.txt` | Explicit `elseif (UNIX AND NOT APPLE)` in the capability-flags block (WebKitGTK webview, no AU/WebView2); `MOSH_ENABLE_JACK` option; Linux-guarded `JUCE_ALSA=1` / `JUCE_JACK=<bool>` on the app target. macOS/Windows byte-unaffected (all new logic is Linux-guarded). |
| `run-linux.sh` | New portable launcher: `tests` (headless build+run via ctest), `app` (full app), `service` (FakeAdapter), `deps` (prints the apt line). `run-mosh.sh` stays macOS-only. |
| `.github/workflows/linux-ci.yml` | `ubuntu-latest` job: required headless `MoshTests` build+run + service /health smoke; informational full-app build. |
| `docs/2026-07-07-linux-build-spike.md` | This doc. |

`cmake/Dependencies.cmake` needed **no change** — `tracktion_engine`/Catch2/anira are
already cross-platform, and `anira` (the only heavy/torch dep) stays `OFF` by default.

## Platform-backend decisions

- **WebView → WebKitGTK.** JUCE's Linux `JUCE_WEB_BROWSER=1` path is backed by
  `webkit2gtk` + `gtk+-3.0`. Required to build/link the full `Mosh` app; the headless
  `MoshTests` sidesteps it entirely (`JUCE_WEB_BROWSER=0`). WebView2 (Windows) and the
  macOS WKWebView paths are untouched.
- **Audio → ALSA (default), JACK (opt-in).** `JUCE_ALSA=1` is JUCE's Linux default and
  present on every distro. `MOSH_ENABLE_JACK=ON` (needs `libjack-dev`) additively turns
  on `JUCE_JACK=1`. `MoshTests` uses no audio device, so this only matters for the app.
- **VST3 hosting → JUCE's Linux VST3.** `JUCE_PLUGINHOST_VST3=1` is already set
  unconditionally and is portable; plugin *editor windows* need X11 at runtime, but
  headless scanning/hosting does not. AU hosting stays macOS-only (`MOSH_PLUGINHOST_AU=0`
  on Linux).
- **Skipped subsystems.** The macOS `NSApp`/`NSMenu` menu bar is excluded on non-Apple;
  runtime resources are staged next to the executable instead of into a `.app`.

## How to use it

```bash
# On a Linux (x86_64) box:
./run-linux.sh deps        # prints the apt-get install line for the full app
./run-linux.sh tests       # headless: build + run MoshTests (only build-essential/cmake/ninja)
./run-linux.sh service     # start the generative service (FakeAdapter, stdlib)
./run-linux.sh app         # exploratory full GUI app (needs the WebKitGTK/ALSA/node deps)

# Or directly via presets:
cmake --preset linux-x64-debug -DMOSH_BUILD_APP=OFF -DMOSH_BUILD_UI=OFF   # headless configure
cmake --build build-linux-x64 --target MoshTests
ctest --test-dir build-linux-x64 -R MoshTests --output-on-failure
```

CI runs automatically on push/PR touching build-relevant paths, and via
**Actions → linux-ci → Run workflow** (`workflow_dispatch`).

## Known risks / open questions (for the follow-up)

1. **WebKitGTK 4.0 vs 4.1.** *(Resolved 2026-10-15: the pinned JUCE finds 4.1; the app
   just has to set `NEEDS_WEB_BROWSER`.)* Ubuntu 24.04 ships `libwebkit2gtk-4.1-dev` (4.0 was
   removed); older JUCE pkg-checks `webkit2gtk-4.0`. If the pinned JUCE
   (`7c89e11f`) only probes 4.0, the full-app *configure* fails on 24.04. CI installs
   `-4.1-dev`; the first run tells us whether JUCE finds it. Mitigation if not: install
   a 4.0 compat package, or pin the runner to 22.04.
2. **Console `juce_events` X11 dependency.** `MoshTests` links no GUI module, so its
   message loop should not need X11 — but if the Linux linker asks for it, add
   `libx11-dev` (already in the CI dep set). The doc's "only build-essential" claim for
   the headless path is what CI verifies.
3. **arm64 Linux.** Presets are named/targeted `x64` and CI is x86_64. Apple-silicon
   Linux (aarch64) is untested; the config is arch-agnostic but unproven there.
4. **node for the app.** The Vite bundle (`MoshStageUI`) needs `npm`; absent, JUCE's
   `BuildUI.cmake` warns and the app can still link (webview falls back to the dev
   server). CI relies on the runner's preinstalled node.

## Next steps

1. ~~Watch the first `linux-ci` run.~~ Done.
2. ~~Get the informational full-app stage to link `Mosh`.~~ Done 2026-10-15.
3. ~~Reach `Mosh --selftest` on Linux under `xvfb-run` and make it a required CI gate.~~
   Done 2026-10-15 (`./run-linux.sh selftest`, linux-ci stage 2).
4. Triage the recorded Debug JUCE assertions (above).
5. A Release Linux build needs `SelfTest.cpp` to compile in reasonable time under GCC -O3
   (for example, per-file optimisation or splitting the TU) before it can gate.
6. Consider aarch64-linux and a JACK-enabled variant.

> Prime-directive note: this flips "No Linux build path is exercised yet" to
> "Linux is an exploratory spike — headless + service build; full GUI app is CI-tracked,
> not yet supported." Update `CLAUDE.md` / `ARCHITECTURE.md` platform matrices when the
> full app is green.
