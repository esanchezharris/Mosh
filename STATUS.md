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
- [ ] `mosh_tests` **builds + passes** on Windows  ← currently building.
- [x] Stage 0 app target authored (JUCE GUI app + WebView host serving the staged UI; no
      Tracktion yet — that's Stage 1). Window/placeholder gate is a macOS pass.
- **GATE (macOS):** window + placeholder on macOS arm64; service health ok. *(authored;
  needs a Mac to run. Service health verified here.)*

### Stages 1–6 — NOT STARTED
Stage 1 next: Tracktion bootstrap (Engine/Edit/transport/device), swap the standalone
`UndoManager` for `edit.getUndoManager()`, register Tracktion-bound handlers
(`create_track`/`import_clip`/`set_transport`), a snapshot source walking the Edit, and the
`MOSH_RENDERLAYER` save/load round-trip. The UI/spine do not change.

## // VERIFY ledger (resolve against the pinned tracktion_engine v3.2.0 clone)

Not yet resolved (Stage 1+ work; require reading the clone / a macOS build):
- `createEmptyEdit` / `Edit` ctor / `insertNewAudioTrack` signatures (strong time types) — **01**
- Edit save call (`EditFileOperations` vs `edit.save()`) — **01**
- `MOSH_RENDERLAYER` parent (clip default vs track) — **01** (modelled clip-parented)
- JUCE 8 WebView native-fn registration + `window.__JUCE__.backend` emit API — **03**
  (C++ side authored with `withNativeFunction`/`emitEventIfBrowserIsVisible`; JS side flagged
  in `ui/src/bridge.ts`) — reconcile at Stage 2 run.
- `ExternalPlugin` editor accessor; `LatencyPlugin` source; anira `process`/`prepare`;
  bypassed-plugin PDC — **04**
- Takes/comp add+promote API; `Renderer::Parameters` fields; render-to-file overload — **05**

## Next concrete step
Finish the Stage 0 spine build + green test run on Windows, commit Stage 0, then begin Stage 1
(Tracktion engine bootstrap + the first real command handlers).
