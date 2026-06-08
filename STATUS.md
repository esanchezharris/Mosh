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
| `Mosh` app (JUCE WebView + Tracktion) | ⚠️ partial | ⏳ | JUCE WebView uses WebView2 on Win; Tracktion builds cross-platform but the **window/audio gate is macOS-primary** |
| Tier-A neural (anira/RTNeural), SA3 service (MLX) | ❌ macOS | ⏳ | MLX is Apple-Silicon only; FakeAdapter is OS-agnostic |

Gates that assert "window opens on macOS arm64" / audio / PDC null / MLX cannot be *run* on
this Windows box; they are authored cross-platform-clean and flagged for a macOS pass.

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

Still open (resolve when reached):
- `MOSH_RENDERLAYER` parent (clip default vs track) — **01** (modelled clip-parented; revisit for track-wide transforms)
- JUCE 8 WebView native-fn registration + `window.__JUCE__.backend` emit API — **03**
  (C++ authored with `withNativeFunction`/`emitEventIfBrowserIsVisible`; JS flagged in `ui/src/bridge.ts`) — reconcile at first WebView run.
- `ExternalPlugin` editor accessor; `LatencyPlugin` source; anira `process`/`prepare`; bypassed-plugin PDC — **04**

## Next concrete step
Finish the Stage 0 spine build + green test run on Windows, commit Stage 0, then begin Stage 1
(Tracktion engine bootstrap + the first real command handlers).
