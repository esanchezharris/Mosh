# Linux build spike (FIT-011)

*Date: 2026-07-07 · Status: **config landed, headless path CI-tracked, full GUI app unverified***

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

1. **WebKitGTK 4.0 vs 4.1.** Ubuntu 24.04 ships `libwebkit2gtk-4.1-dev` (4.0 was
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

1. Land this, watch the **first `linux-ci` run** — that is the real bring-up verdict.
2. Triage the informational full-app stage: resolve the WebKitGTK version probe, any
   JUCE Linux link snags, and ALSA/X11 headers, until `Mosh` links.
3. Once the app links, reach `Mosh --selftest` on Linux (headless via `xvfb-run` for the
   WebView) and make it a required CI gate.
4. Consider aarch64-linux and a JACK-enabled variant.

> Prime-directive note: this flips "No Linux build path is exercised yet" to
> "Linux is an exploratory spike — headless + service build; full GUI app is CI-tracked,
> not yet supported." Update `CLAUDE.md` / `ARCHITECTURE.md` platform matrices when the
> full app is green.
