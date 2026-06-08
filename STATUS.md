# Mosh — Build Status & Handoff

*Living status of the autonomous build. Honest gate accounting: what is verified, on which
hardware, and the next concrete step. Pairs with the checklist in `CLAUDE.md`.*

**Build machine:** Windows 11, RTX 4070 (no Mac available). **Primary target:** macOS arm64.

## Verifiability map (important)

The repo is split so the load-bearing logic is provable here, and the macOS-only parts are
clearly isolated:

| Component | Builds on Windows? | Verified here? | Notes |
|---|---|---|---|
| `mosh_spine` + `mosh_tests` (MoshOps, RenderLayer, ASTD, fingerprint, feed) | ✅ | see below | Tracktion-free; the real spine verification |
| `ui/` React/Vite bundle | ✅ | ✅ green | `npm run build` → `dist/` |
| `service/` Python health stub | ✅ | ✅ green | stdlib only; `/health` 200 |
| `Mosh` app (Tracktion + MoshOps + HTTP transport) | ✅ | ✅ green | **UI drives the real backend over HTTP in a browser** (Stage-2/6 loop minus audio) — see BREAKTHROUGH |
| `Mosh` in-app WebView render (WebView2) | ⚠️ Win dead-end | ⏳ macOS | WebView2 resource-provider bug; macOS WKWebView is the path. **Sidestepped by the HTTP transport.** |
| Tier-A neural (anira/RTNeural), SA3 service (MLX) | ❌ macOS | ⏳ | MLX is Apple-Silicon only; FakeAdapter is OS-agnostic |

Gates that assert "window opens on macOS arm64" / audio / PDC null / MLX cannot be *run* on
this Windows box; they are authored cross-platform-clean and flagged for a macOS pass.

## Capstone: the Stage-6 producer loop is verified end-to-end on Windows

`test_producer_loop` (`[producer]`, 25 assertions, green) drives the WHOLE producer loop over **real
Tracktion + the real Python service**, via the exact MoshOps commands the (browser-verified) UI emits:
import → arrange (`move_clip`) → host plugin → Tier-A neural insert + ASTD param → generative transform
(`render_layer` via the service) → **accept (non-destructive landing, source untouched)** → mix →
**undo/redo correct throughout** (undo mix, undo accept reverts, redo restores; full unwind→initial,
full rebuild) → **export/persist** (saveAs → fresh reload → restored) → JSONL taste label. Only the
literal "from the UI" WebView render + audio export need macOS. **Totals: 326 assertions / 44 cases**
across `mosh_tests` (205/36) + `mosh_engine_tests` (105/7) + `mosh_service_tests` (16/1).

## BREAKTHROUGH (2026-06-08): the UI drives the REAL backend over HTTP — Windows-verified

The WebView2 render is a JUCE-8/Windows dead-end (below), but the user's instinct — *"try just
opening it in a browser?"* — unblocked everything. **`src/app/HttpBridge`** is a second transport
for the SAME MoshOps seam: a tiny `juce::StreamingSocket` server serving the staged React bundle +
`/api/snapshot`, `/api/command`, `/api/events` on `MOSH_HTTP_PORT` (default 8080). A plain Chromium
(Playwright) loads `http://localhost:8080`, and `ui/src/bridge.ts` selects the HTTP transport
(`makeHttpBridge`, injected `window.__MOSH_BACKEND__="http"` marker) — **same `executeCommand` +
snapshot/events contract, zero frontend changes** to the seam. No prime directive bent: every
mutation is still a MoshOps command marshalled to the message thread; Tracktion mutates only there.

**This makes the Stage-2 swappability gate and the Stage-6 "full producer loop FROM THE UI" provable
on Windows** (only literal audio output / VST3 editors / anira / MLX still need macOS). Verified in a
real browser against real Tracktion:

| From the UI (browser) | Command | Result |
|---|---|---|
| `+ Track` button | `create_track` | real `te::AudioTrack` (IDs `track:1003…`, real Volume&Pan + Level-Meter built-ins) |
| click lane | `import_clip` | real tone-WAV clip (fallback synthesizes audio when no file → arrangeable) |
| drag clip body | `move_clip` | `[3.475,7.475] → [4.475,8.475]` (length preserved) |
| drag clip edge | `trim_clip` | end-only `→ 8.975` |
| double-click clip | `split_clip` | one clip → two, net +1 |
| transport ▶ / ■ | `set_transport` | `playing` true → false |
| ↶ / ↷ buttons + Ctrl+Z/Ctrl+Shift+Z | `undo`/`redo` | **one command per step, UI↔backend in perfect sync, full unwind + rebuild** |

**UI/backend stayed byte-for-byte in sync across the whole sequence** (snapshot clip/track counts ==
rendered `.clip`/`.lane` counts at every step). Screenshot: `mosh-producer-loop-from-ui.png`.

Three correctness fixes landed to make this solid (all genuine bugs, not test scaffolding):
1. **Reliable event feed** — `/api/events` was drain-on-read: if a poll's response was dropped
   (the single-threaded server refuses connections under load → `ERR_CONNECTION_REFUSED`), the
   drained events were lost forever. Reworked to a **non-destructive sequence-cursor**: each event
   gets a monotonic `seq`; the client sends `?since=N` and only advances its cursor on a delivered
   response, so a dropped response just re-fetches (at-least-once; `applyEvent` handlers are
   idempotent). A bounded ring + `resync` flag covers a client falling behind.
2. **Load-time race** — `connectFeed` fetched the snapshot and subscribed concurrently, so an event
   arriving before the snapshot resolved hit `applyEvent`'s `!snapshot` guard and was dropped. Now
   it subscribes first, **buffers** events until the snapshot loads, then replays them (idempotent).
3. **Arrangeable clips without a file** — the real `import_clip` requires an audio file, but the
   UI's click-to-add sends none. Added a **tone-WAV generator fallback** (`generateToneFile`) so the
   click-to-add affordance yields a real, movable/trimmable/splittable clip (a real file picker
   would supply `{path}`). UI seam unchanged → swappability preserved.
4. **Undo/redo in the UI** — added Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z (+ Ctrl+Y) and ↶/↷ topbar buttons
   (`App.tsx`) calling `executeCommand("undo"/"redo")`. The backend already had them; the UI didn't
   expose them. Each emits `snapshot_invalidated` → store resync.

Net: the **swappability gate (Stage 2) is satisfied over HTTP** (rebuilt the React bundle ~6× during
this work with zero backend change, and it kept driving the real backend), and the **Stage-6 producer
loop minus audio/neural/export is exercised live from the browser** with correct undo/redo. WKWebView
on macOS remains the path for the *in-app* WebView render, but "from the UI against the real backend"
is no longer macOS-gated.

## Dependency pins (resolved 2026-06-08 via `git ls-remote`)

JUCE `8.0.8` · tracktion_engine `v3.2.0` · anira `v2.0.3` · RTNeural `1fb1f075` ·
chowdsp_utils `e97b826e` · Catch2 `v3.9.1` · CPM `v0.42.3`.

## Stage status

### Stage 0 — Skeleton — IN PROGRESS
- [x] Repo scaffold matching `00 §5`; git initialized; `.gitignore`.
- [x] Top-level CMake with pinned CPM deps; **spine/tests/app split** so the spine is
      OS-agnostic and testable.
- [x] `ui/` Vite+React+TS+zustand placeholder — **builds green**, `dist/index.html` with
      relative asset paths; `bridge.ts` implements the exact result/snapshot/event contract
      with a `window.__JUCE__` detection + mock fallback.
- [x] `service/` Python stdlib health stub — **verified** (`/health` 200, `/capabilities`, 404).
- [x] `mosh_spine` authored: MoshResult envelope, MoshCommand, typed MoshEvent + Decimator,
      JsonlLog, DslExecutor (validate → undo txn → handler → emit → log → envelope),
      SnapshotSource, RenderLayer schema + full fingerprint, ASTD mapping.
- [x] `tests/` Catch2 suite incl. the **command-surface harness** (results/events/JSONL/
      snapshot/undo-redo/transaction-abandon over a fake model — no Tracktion).
- [x] CMake **configures clean** on Windows (MSVC 19.44, JUCE 8.0.8 + Catch2 fetched).
- [x] `mosh_tests` **builds + passes** on Windows — 158 assertions / 30 cases (incl. ClipMath).
- [x] Stage 0 app **builds + links + launches** on Windows (MSVC + WebView2 SDK wired);
      native window titled "Mosh" opens, process stable. (No Tracktion yet — Stage 1.)
- [~] **WebView placeholder render:** the WebView2 backend currently shows its
      "Navigation to the webpage was canceled" page instead of the React placeholder. The
      resource provider, path mapping, staged bundle, user-data folder, and dark bg are all
      wired and the `https://juce.backend` request filter is registered — but the top-level
      document isn't served/painted on the **Windows WebView2** backend. This is the JUCE-8
      WebView `// VERIFY` (module 03) and is Windows-WebView2-specific (macOS uses WKWebView,
      no SDK). **Deferred to Stage 2**, where the bridge native-fn/event API is reconciled and
      the swappability gate runs. Repro: launch `Mosh.exe`; window opens, WebView shows the
      cancel page. Next probes: try a `data:`/inline-HTML navigation to isolate
      WebView2-runtime vs resource-provider; verify `pageAboutToLoad`/navigation-starting isn't
      cancelling; confirm Evergreen WebView2 Runtime present.
- **GATE (macOS):** window + placeholder on macOS arm64; service health ok. *(Windows proxy:
  build+window ✅, service health ✅; placeholder render pending Stage-2 WebView reconciliation /
  a macOS WKWebView run.)*

### Stage 1 — Engine + MoshOps + feed — IN PROGRESS (engine layer authored)
- [x] `src/engine/MoshEngine` — one `Engine` for the app lifetime (device auto-inits),
      `createEmptyEdit`, load via `loadEditFromFile`, save via `EditFileOperations::save`,
      transport accessor, `getUndoManager()` → the edit's `juce::UndoManager`.
- [x] `src/engine/EngineSnapshot` — walks the Edit into the snapshot schema (tracks → gain
      from the volume plugin, clips → range; transport; tempo/sig). Shared `trackToVar`/
      `clipToVar` reused by handlers so snapshot and events agree.
- [x] `src/engine/EngineHandlers` — Tracktion-bound handlers registered into the executor:
      `create_track`, `import_clip`, `set_transport`, `set_tempo`, `rename_track`,
      `set_track_gain/mute/solo`, `delete_track`, + Stage-2 `move_clip`/`trim_clip`/`split_clip`.
      All signatures verified against the clone.
- [x] `Main.cpp` wired: `MoshEngine` → `DslExecutor(engine.getUndoManager(), log)` →
      register handlers → `EngineSnapshotSource`. JSONL log written next to the edit file.
- [x] CMake: Tracktion integrated per the resolved approach (JUCE 8.0.8 first → CPM
      `DOWNLOAD_ONLY` tracktion → `add_subdirectory(modules)` → link `tracktion::*`).
- [x] **Builds with Tracktion** — `mosh_engine` compiles + links against tracktion_engine v3.2.0
      on Windows (MSVC). The JUCE-first → `add_subdirectory(modules)` → `tracktion::*` integration works.
- [x] **Stage-1 command path verified** — `mosh_engine_tests` (Tracktion-linked, 23 assertions, 2 cases,
      **green**): `create_track`, `import_clip` (real generated WAV), snapshot reflects both, events fire,
      **undo reverts clip→track, redo restores** (one undo system through `edit.getUndoManager()`),
      `save()` writes a `.tracktionedit`, `set_tempo`/`set_transport` reflected. Engine uses the 1-arg
      `Engine("Mosh")` ctor (default UI/Engine behaviour — correct for a headless/WebView app;
      `ExtendedUIBehaviour` is an examples-only helper, not in the engine module). `namespace te =
      tracktion` (NOT `::engine`) — strong time types live in `tracktion::core`, surfaced via `tracktion::`.
- [x] `MOSH_RENDERLAYER` save/load round-trip covered by `mosh_tests` (spine).
- [~] Remaining Stage-1 gate aspects: **WebView cold-render** (blocked on the Stage-2 WebView resource
      fix) and **audio loop/scrub** (needs an interactive run; the transport *commands* execute + reflect).

### Stages 2–6 — NOT STARTED

## // VERIFY ledger (resolve against the pinned tracktion_engine v3.2.0 clone)

**RESOLVED** against the pinned clone (cited in `docs/TRACKTION_API_NOTES.md`):
- ✅ Engine ctor `Engine("Mosh", make_unique<ExtendedUIBehaviour>(), nullptr)` (device auto-inits) — **01/06**
- ✅ `createEmptyEdit(engine, file)` → `unique_ptr<Edit>`; `Edit::Options`/`Edit::createEdit` — **01**
- ✅ Save = `EditFileOperations(edit).save(warn, force, discard)` — there is **no** `edit.save()` — **01**
- ✅ `edit.getUndoManager()` returns **`juce::UndoManager&`** — confirms the spine's undo design — **01/02**
- ✅ `insertNewAudioTrack(TrackInsertPoint::getEndOfTracks(edit), nullptr)`; `getAudioTracks(edit)` — **01**
- ✅ `track->insertWaveClip(name, file, {{start,dur},offset}, false)`; `splitClip(clip, TimePosition)`; strong time types — **01**
- ✅ Transport `getTransport()` + `play/stop/setPosition/setLoopRange` + `transport.looping`; render-exclusivity → wrap in `Edit::ScopedRenderStatus` — **01/05**
- ✅ CMake: add JUCE 8.0.8 **first**, then `add_subdirectory(.../tracktion_engine/modules)`, link `tracktion::tracktion_core/engine/graph`; guard tracktion's `develop` JUCE — **06**
- ✅ `Renderer::Parameters{edit}` + `renderToFile` (file-based; no buffer API) — **05**
- ✅ Takes: `addTake(File)`/`setCurrentTake`/`unpackTakes`; new-clip/new-track fallback for A/B + freeze — **05**

- ✅ JUCE-8 WebView native-fn protocol — **03**: NOT `backend.getNativeFunction`; a native function is
  invoked via `backend.emitEvent("__juce__invoke", {name, params, resultId})` + a `"__juce__complete"`
  `{promiseId, result}` event (`juce_gui_extra/native/javascript/index.js`). `ui/src/bridge.ts` fixed to
  this; C++ `withNativeFunction`/`emitEventIfBrowserIsVisible` was already correct. Events on the
  `mosh_event` channel via `backend.addEventListener`. (Required for macOS WKWebView to connect.)

Still open (resolve when reached):
- `MOSH_RENDERLAYER` parent (clip default vs track) — **01** (modelled clip-parented; revisit for track-wide transforms)
- `ExternalPlugin` editor accessor; `LatencyPlugin` source; anira `process`/`prepare`; bypassed-plugin PDC — **04** (macOS, with real plugins/anira)

## Build & test quickstart (verified commands)

```powershell
$cm = "C:\Program Files\CMake\bin\cmake.exe"   # CMake 4.x; Ninja not on PATH → VS generator

# Spine + tests only (fast, any OS) — 158 assertions green:
& $cm -S . -B build -G "Visual Studio 17 2022" -A x64 -DMOSH_BUILD_APP=OFF -DMOSH_BUILD_UI=OFF
& $cm --build build --config Debug --target mosh_tests --parallel
& (gci -r build -Filter mosh_tests.exe)[0].FullName --reporter compact

# Full app + engine (heavy; fetches Tracktion). Engine smoke test = 23 assertions green:
& $cm -S . -B build -DMOSH_BUILD_APP=ON -DMOSH_BUILD_UI=ON
& $cm --build build --config Debug --target Mosh mosh_engine_tests --parallel
& (gci -r build -Filter mosh_engine_tests.exe)[0].FullName --reporter compact
```
Windows-only: WebView2 SDK is fetched to `.refclone/webview2` (one-time, see `src/app/CMakeLists.txt`);
macOS needs none of that (WKWebView). `.refclone/tracktion_engine` holds the read-only v3.2.0 clone.

## Key learnings / decisions (don't relitigate)

- **`namespace te = tracktion`** (NOT `tracktion::engine`): engine symbols are in the inline
  `engine` namespace and the strong time types (`TimePosition`/`TimeDuration`/`TimeRange`) live in
  `tracktion::core` — both surface as `tracktion::*`.
- **`te::Engine("Mosh")`** 1-arg ctor (default UI/Engine behaviour) — `ExtendedUIBehaviour` is an
  examples-only helper, not in the engine module. Headless/WebView app wants no native dialogs anyway.
- **One undo system works**: the executor calls `undo.beginNewTransaction(cmd)`; Tracktion model ops
  (`insertNewAudioTrack`/`insertWaveClip`/etc.) record into `edit.getUndoManager()` within that txn;
  `undo`/`redo` revert/restore correctly (proven by `mosh_engine_tests`). On failure the executor calls
  `undoCurrentTransactionOnly()` to abandon partial mutations.
- **Save** = `EditFileOperations(edit).save(false,true,false)` (no `edit.save()`).
- **Spine/app split**: `mosh_spine` is Tracktion-free (unit-testable anywhere); `mosh_engine` is the
  Tracktion-bound layer. JUCE config defs on the spine are PRIVATE (so `JUCE_WEB_BROWSER=0` can't leak
  into the app, which needs the WebView). Cache key uses FNV-1a (juce_core has no MD5/SHA — those are
  juce_cryptography).
- **Tracktion CMake**: add JUCE 8.0.8 first, then CPM `DOWNLOAD_ONLY` tracktion + `add_subdirectory(
  ${src}/modules)` (that file is just `juce_add_modules(...)`) — never the repo root (it pulls JUCE
  `develop`). Link `tracktion::tracktion_engine/core/graph`. Each consuming target recompiles the
  Tracktion module units (≈15 min for the app) — a known JUCE cost; consider a pimpl in `mosh_engine`
  to stop the app recompiling Tracktion if iteration speed matters.

## ~~OPEN ISSUE~~ → SIDESTEPPED — in-app WebView render (Windows WebView2)

> **Update (2026-06-08):** this no longer blocks "UI drives the real backend." The **HttpBridge**
> (see BREAKTHROUGH above) serves the same seam over HTTP to a plain browser, and the full arrange +
> undo/redo loop is verified there on Windows. The note below remains the record of the WebView2
> investigation; the *in-app* render still wants macOS WKWebView, but it's no longer on the critical path.

Windows WebView2 shows "Navigation to the webpage was canceled" instead of the React bundle. Verified:
the `https://juce.backend/*` request filter is registered; `getResourceProviderRoot()` =
`https://juce.backend/`; the provider receives `/`→ maps to a staged `index.html` that exists; base
`pageAboutToLoad` returns true; user-data folder + dark bg + allowed-origin + a not-found inline-HTML
fallback are all wired. WebView2 itself works (it renders its own error page). The top-level document
just isn't served/painted on **WebView2 specifically**. This is the JUCE-8 WebView `// VERIFY` and is
Windows-WebView2-specific — **macOS uses WKWebView (a different backend) and is the primary target**.
**FULLY INVESTIGATED (2026-06-08) — confirmed a JUCE-8.0.8 + Windows-WebView2 limitation in JUCE's
internals; NOT a Mosh bug.** Set `MOSH_WV_DEBUG=1` to log resource/native-fn activity to
`%TEMP%\mosh_wv_log.txt`. Ground truth: WebView2 Runtime **148.0.3967.96** present; WebView2 inits (it
renders its own error pages); the `AddWebResourceRequestedFilter(L"*", ALL)` is registered (read in
`juce_WebBrowserComponent_windows.cpp:841`); yet `provideResource` is **NEVER called** — the log shows
only the HOST-ctor + re-nav lines, never a `REQ`. WebView2 shows **"Can't reach this page —
https://juce.backend"**: the top-level navigation to the synthetic resource origin is **not intercepted
by the WebResourceRequested filter**, so it escapes to the network and DNS-fails.
Tried (all → no `REQ`, page not served): default config; user-data folder; allowed-origin arg;
not-found inline-HTML fallback; **re-navigate after a 1.5 s timer** (so peer/env are surely ready —
rules out a timing race); **explicit `.withBackend(Options::Backend::webview2)`** (the one config
difference vs JUCE's working `WebViewPluginDemo`). Also tried the **dev-server bypass** (serve `ui/dist`
over `http://localhost` via `vite preview`, point the WebView there with `MOSH_DEV_SERVER`): WebView2
**loads** the http page (no cancel) but the React app stays blank and **`window.__JUCE__` is not
injected for the external origin** (the bridge falls back to its mock — no `NATIVE getSnapshot` logged),
so it's not connected to the C++ backend. Net: on this JUCE/WebView2/Windows combo, neither path yields
"UI rendered against the real backend." This requires patching JUCE's WebView2 resource handling — out
of scope for a non-target platform.
**RESOLUTION PATH:** run on **macOS arm64 (the primary target)**. There `getResourceProviderRoot()` is
`juce://juce.backend/` served by a **WKURLSchemeHandler** (custom URL scheme) — a fundamentally
different, robust mechanism that does NOT depend on WebView2's `WebResourceRequested` interception. The
`WebViewHost` (native fns + event channel + resource provider) is already coded to JUCE's canonical
pattern, so it should serve the bundle on WKWebView, immediately connecting the already-verified
frontend to the already-verified backend. Secondary option on Windows: upgrade/patch JUCE's WebView2
backend, or vendor a `SetVirtualHostNameToFolderMapping`-based loader.

## Continuation roadmap (Stage 2 → 6)

- **Stage 2 (WebView arrangement + swappability)** — **React arrangement BUILT + browser-verified**
  (`ui/src/components/` TransportBar/TrackList/Timeline/Mixer over the bridge contract; headless
  Playwright drove create-track/add-clip/move/trim/split/transport/loop/meters/plugins against an
  enriched contract-faithful mock; `npm run build` green). The C++ `WebViewHost` native-fn/event
  wiring is already coded. **Only remaining:** run the bundle in the **JUCE WebView against the real
  C++ backend** — which needs the WebView render (Windows-WebView2 blocked → macOS WKWebView) and is
  also the live swappability proof. The seam held throughout (every mutation via `executeCommand`,
  every visual from snapshot+events).
- **Stage 3 (VST3 hosting via commands)** — **command surface DONE + verified on Windows with a
  Tracktion built-in** (`src/engine/PluginCommands` + `test_plugin_commands`, `[plugins]`):
  `load_plugin`/`bypass_plugin`/`remove_plugin`/`reorder_plugin` + undo, snapshot surfaces `plugins[]`.
  **Remaining:** `set_plugin_param` (AutomatableParameter API — small, Windows-doable on a built-in) and
  `open_plugin_editor` (native pop-out; the `ExternalPlugin` editor `// VERIFY`), plus real VST3 scan +
  audio = the macOS half of the gate.
- **Stage 4 (Tier-A neural)** — **insert architecture + ASTD command surface DONE + verified on
  Windows**: `NeuralInsertPlugin` (custom `te::Plugin`) registered via `createBuiltInType<>()`,
  RT-safe passthrough `applyToBuffer`, true `getLatencySeconds()`; `add_neural_insert`/`set_neural_param`
  (**ASTD-clamped, shared spine impl**)/`set_neural_lab_mode`/`bypass_neural_insert`
  (`src/engine/NeuralInsertPlugin.h` + `NeuralCommands` + `test_neural_commands`: clamp 0.7, Lab→1.0).
  Survives save/reload (`test_persistence`). **Remaining (macOS):** anira inference (NAM/Proteus ship,
  RAVE gated, DDSP) in `initialise()`/`applyToBuffer()` — the // VERIFY anira `process`/`prepare` — and
  the real **PDC null test** with a latency-introducing model + the bypass inverted-logic check (`04`).
- **Stage 5 (generative)** — **FakeAdapter first** (no external deps → Windows/CI-testable!).
  **DONE + tested (Windows):** the in-process orchestration spine — `GenerativeModelAdapter` seam +
  `FakeAdapter` + `RenderCache` + `renderLayer()` (`src/spine/Generative.h`, 25 assertions): cache
  HIT/MISS by FULL fingerprint, dirty-on-change re-render, deterministic output, accept/reject taste
  labels. The Python **job service** (submit/status/progress/cancel + deterministic placeholder-WAV +
  manifest, stdlib-only) — DONE + verified. The C++ **`GenerativeJobManager`** + `renderLayerViaService()`
  (spawn/`/health`/submit/poll/cancel over HTTP+manifests) — DONE + verified C++↔service e2e
  (`mosh_service_tests`, 16). The **command-surface loop** (`create_render_layer`/`set_render_param`/
  `render_layer`/`accept_render`/`reject_render`/`cancel_render` + `layer_*` events + **JSONL taste
  labels**) — DONE + verified (`src/spine/GenerativeCommands`, `test_generative_commands`, 22). **So the
  whole Stage-5 Fake orchestration is proven on Windows** at FIVE levels — incl. the **engine
  landing on real Tracktion** (`mosh_engine` `GenerativeEngine` + `test_generative_engine`, `[gengine]`):
  RenderLayer under the source clip → render via the service → `accept_render` lands the result
  NON-DESTRUCTIVELY as a new clip on a Neural lane (source untouched) → undo reverts → JSONL taste
  label. **Only remaining for the Fake gate:** the audition/A-B-vs-source **UI** (Stage 2 WebView).
  Then `bypass_layer`/`freeze_layer`/`bounce_layer_to_clip`, the take-based landing variant (per
  `neural_render_landing`; semantics in docs §9), service lifecycle hardening, and the
  `StableAudio3Adapter` (MLX, macOS-only; env-var the two hardcoded paths) swap in last.
- **Stage 6 (consolidation)** — mixer polish, two-theme tokens, reserved B-5 slot; the full producer
  loop end-to-end from the UI with correct undo/redo.

**Highest-value Windows-testable next work (if continuing here, not on macOS):** Stage 5's FakeAdapter
orchestration (job service + RenderLayer flow + cache fingerprint) — it needs no MLX and the cache/
fingerprint/ASTD spine is already green. Otherwise, Stage 2 onward is best done on macOS arm64.
