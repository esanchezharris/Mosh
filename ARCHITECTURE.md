# Mosh — Architecture On-Ramp

*The 2-minute map of the codebase. Read this first. For the short current status handoff see [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md); for build/gate status see [CLAUDE.md](CLAUDE.md); for the detailed design of any subsystem see the numbered specs `00`–`07`. This file is verified against the code — if it drifts, fix it here.*

---

## 1. What Mosh is

**Mosh is a native macOS app** (Apple Silicon / arm64). `Mosh.app` is a native C++ binary built with JUCE 8 + Tracktion Engine. The audio engine, plugin hosting, neural DSP, file I/O, window and menus are all native.

The one nuance that trips everyone up: the **visual UI is not drawn with native Cocoa controls** — it's a React app rendered inside an embedded JUCE `WebBrowserComponent` (a "WebView"), shipped *inside* the app bundle at `Mosh.app/Contents/Resources/ui`. It talks to the C++ core through an **in-process bridge**, never over a network.

> **It is a native app with a web-tech UI layer. Not Electron, not a website, no server.** When docs say "the UI" or "the WebView UI," they mean this React layer. The audio/engine/plugins are pure native C++.

There are five layers, and exactly two things connect the UI to the engine:

```
                       Mosh.app  (one native macOS process)
 ┌───────────────────────────────────────────────────────────────────────┐
 │                                                                         │
 │   WebView UI layer  ──────────►  THE SEAM  ──────────►  Native engine   │
 │   (ui/  React in a              (src/webview +          (src/engine +    │
 │    JUCE WebView)                 src/moshops)            Tracktion)      │
 │                                                                         │
 │   • Arrange / mix / Moshi   execute_command(cmd) ─►  MoshOps validates, │
 │   • never touches Tracktion ◄─ snapshot() + events   runs 1 undo txn,   │
 │     or audio directly          (30 Hz, "mosh_event")  mutates the Edit  │
 │                                                                         │
 └───────────────────────────────────────────────┬───────────────────────┘
                                                  │ spawns + HTTP (localhost:8770)
                                                  ▼
                                     Generative service  (service/  Python)
                                     Tier-B render jobs: SA3 / FakeAdapter
```

- **WebView UI layer** — `ui/` (React + Vite + Zustand). Pure view; all mutations go through the seam.
- **The seam** — `src/webview` (WebBridge) + `src/moshops` (MoshOps). The *only* coupling between UI and backend.
- **Native engine** — `src/engine` (MoshEngine) owns one Tracktion `Engine` + `Edit` for the app's life.
- **In-process plugins/DSP** — `src/plugins/*` (VST3/AU hosting, Tier-A neural insert, spectral tap).
- **Out-of-process generative service** — `service/` (Python), driven by `src/generative` over local HTTP. This is the "tier wall": heavy generative models never run on the audio thread.

---

## 2. Module map — where everything lives

Every row verified against the source (2026-06-17). "Start here" is the file to open first.

| Path | What it does | Start here | Status |
|---|---|---|---|
| `src/app` | App lifecycle, the window, and the CLI harness (`--selftest`, `--demo3‑6`, `--scan-plugins-deep`, `--brain-smoke`). Hosts the WebView. | `src/Main.cpp` | current |
| `src/engine` | Owns the **single** Tracktion `Engine` + `Edit`. Device init, playback context, new/open/save project, session persistence. | `src/engine/MoshEngine.cpp` | current |
| `src/moshops` | **The one mutation path.** `execute(command)` → validate → undo txn → mutate → JSONL log → emit events → result. Also builds `snapshot()`. 130+ commands. | `src/moshops/MoshOps.h` | current |
| `src/state` | ValueTree schema ids + the `RenderLayer` cache fingerprint (SHA-256 over route/seed/params/service-build). | `src/state/RenderLayer.h` | current |
| `src/plugins/hosting` | VST3/AU discovery + catalog + native editor pop-out. Child-process-isolated scan (survives hostile Waves installs). | `src/plugins/hosting/PluginHost.h` | current |
| `src/plugins/neural` | Tier-A real-time neural insert: self-contained 2-layer MLP waveshaper, RT-safe, ASTD-clamped, PDC-correct latency. | `src/plugins/neural/NeuralInsertPlugin.h` | current |
| `src/plugins/spectral` | Lock-free master-output tap; drains the live spectrum to the UI at 30 Hz to animate the Moshi character. | `src/plugins/spectral/MasterSpectralTapPlugin.h` | current |
| `src/generative` | HTTP client for the Tier-B service: spawn/health/submit/poll/cancel over `localhost:8770`. | `src/generative/GenerativeJobManager.h` | current |
| `src/webview` | The bridge: registers WebView native fns (`execute_command`, `get_snapshot`, `pick_files`/`pick_save_file`, `brain_chat`, `voice_*`, `remote_*`), serves `ui/`, emits events. | `src/webview/WebBridge.cpp` | current |
| `src/brain` | Native OpenAI-compatible LLM proxy for the Moshi brain in the packaged app (deepseek/openai/xai via env). | `src/brain/BrainProxy.cpp` | current |
| `src/voice` | macOS `SFSpeechRecognizer` hold-to-talk STT → `voice_event` to the UI composer. | `src/voice/NativeSpeech.mm` | current |
| `src/remote` | HTTP server for the iPhone companion: pairing, phone-take recording, command/event forwarding. | `src/remote/RemoteCompanionServer.h` | current |
| `ui/` | React arrangement UI in the WebView. Arrange (drag/trim/split), mix, plugins, neural, generative drawer, Moshi agent + voice. | `ui/src/App.tsx`, `ui/src/bridge.ts` | current |
| `service/` | Python generative job broker: FakeAdapter stub + Stable Audio 3 (MLX), colour-steering DSL, quality readout. | `service/server.py` | current |

---

## 3. The two contracts that matter

Understand these two and you understand how the whole app holds together. They are the prime directives from `00_MOSH_MASTER_SPEC.md`, here in one paragraph each.

**1. One mutation path (MoshOps).** Every user-visible change — make a track, move a clip, load a plugin, render a layer — is a **MoshOps command**. Each command: validates args → opens exactly one Tracktion undo transaction → mutates the `Edit` → writes a JSONL line (`mosh-log.jsonl`) → emits events → returns a structured result. The UI and the agent **never** mutate Tracktion directly. Undo is Tracktion's `UndoManager`, one transaction per command — there is no second undo system. *(`src/moshops/MoshOps.cpp:307` dispatch; `:272` log; `:278` undo.)*

**2. The swappable seam (snapshot + events).** The frontend couples to the backend **only** through `execute_command(...)` plus a **snapshot + event feed**. `snapshot()` returns the full state; a decimated 30 Hz feed (`"mosh_event"` channel: `snapshot_invalidated`, `transport`, `levels`, `spectrum`) pushes updates. No Tracktion or audio concepts cross into the UI. Pure view state (zoom, scroll, selection, tool, drawers) stays UI-local and is **not** a command. This is why the React bundle can be rebuilt with the C++ binary byte-identical (proven in Stage 2). *(`src/webview/WebBridge.cpp:115` native fns; `src/moshops/MoshOps.cpp:4239` snapshot.)*

---

## 4. Capability index — can the app do X?

What Mosh can actually do today, grouped for a producer. Status is honest: `works` / `partial` (backend exists, no UI) / `known-gap` / `gated` (deferred). "Agent" = exposed to the Moshi LLM agent; backend-only commands are deliberately walled off for safety.

| Capability | Status | Commands | Notes |
|---|---|---|---|
| Track management | ✅ works | `create_track` · `rename_track` · `remove_track` | Undoable CRUD on audio tracks. |
| Arrange clips | ✅ works | `move_clip` · `trim_clip` · `split_clip` · `duplicate_clip` · `remove_clip` | Drag/trim/split; waveforms via `get_clip_peaks`. |
| Clip gain & mute | ✅ works | `set_clip_gain` · `set_clip_mute` | Per-clip dB + mute. |
| MIDI & notes | ✅ works | `add_midi_clip` · `add_note` · `remove_note` · `set_note` · `quantize_notes` | Pitch/velocity/timing; quantize by division+strength. |
| Transport & timing | ✅ works | `set_transport` · `set_tempo` · `set_time_signature` · `set_metronome` · `set_key` | 30 Hz decimated playhead. |
| Recording & takes | ✅ works | `arm_track` · `stop_recording` · `set_input_monitor` · `list_takes` · `set_current_take` · `keep_take` | Record-arm, monitoring, take lanes. |
| Mixing | ✅ works | `set_track_volume`/`pan`/`mute`/`solo` · `set_master_volume`/`pan` | Faders + 30 Hz level meters. |
| VST3/AU hosting | ✅ works | `load_plugin` · `load_builtin` · `remove_plugin` · `bypass_plugin` · `set_plugin_param` · `reorder_plugin` · `open_plugin_editor` | Scanned VST3+AU, native editor pop-out, 10 built-ins. Hosting is in-process: a few misbehaving plugins (a cracked VST3, some stock AUs) can abort on teardown — harness-surfaced only, loss bounded by autosave, `block_plugin` is the manual lever; OOP hosting deferred. See `docs/FEATURE_AUDIT.md` 2026-06-18. |
| Tier-A neural insert | ✅ works | `add_neural_insert` · `set_neural_param` · `set_neural_lab_mode` · `reset_neural` | RT-safe MLP waveshaper; ASTD 0–100 (Lab unlocks); PDC verified. |
| Generative re-imagine (Tier-B) | ✅ works | `create_render_layer` · `set_render_param` · `render_layer` · `accept_render` · `reject_render` · `bypass_layer` · `freeze_layer` · `bounce_layer_to_clip` | SA3 + FakeAdapter fallback; async; cache by fingerprint; lands on a "Neural Renders" lane. |
| Export | ✅ works | `export_audio` | WAV/AIFF/FLAC of the full signal chain. |
| Undo / redo | ✅ works | `undo` · `redo` | Tracktion UndoManager, one txn/command. |
| **Project save / open / new** | ⚠️ **known-gap** | `save` · `new_project` · `open_project` · `save_as` | Commands work + multiple projects coexist, **but:** (a) **no auto-save / no save-on-quit / no unsaved-changes prompt** → quit without ⌘S loses work; (b) relaunch always loads the fixed `~/Library/Mosh/session/session.tracktionedit`, never your last project (no Recent list); (c) projects **not portable** — absolute audio paths in one shared session pool; Save As doesn't consolidate audio. *Fix-session scoped separately.* |
| Automation / buses / sends / tempo-map | 🟡 partial | `add_automation_point` · `create_bus` · `add_send` · `insert_tempo_change` … | Backend routing exists; **no UI yet**; some agent-exposed on production rungs only. |
| Plugin discovery, device/IO, file browse | ✅ works (backend) | `list_plugins` · `rescan_plugins` · `set_audio_device` · `set_buffer_size` · `list_directory` … | Backend queries; **not agent-callable** (safety). |
| Pooled RAVE/DDSP neural models | ⛔ gated | `load_neural_model` | Deferred (anira + LibTorch). v0 ships the inline MLP only. |

---

## 5. Run, build, test

- **Run the app / iterate the UI:** `./run-mosh.sh` (see the script header for flags). For live UI dev, set `MOSH_UI_DEV_SERVER` to the Vite dev URL so the WebView loads from Vite instead of the staged bundle.
- **Verify the backend:** `Mosh --selftest` — the command-surface harness (**744 checks** on a machine where the optional local Serum-VST3 gate is present; a few fewer without it, and the heavy real-model path adds more behind `MOSH_SELFTEST_SA3=1`). Run 3× for determinism (see memory `mosh-verification-conventions`). Visual demos: `Mosh --demo3`…`--demo6`.
- **Build:** CMake (JUCE 8 + Tracktion via submodule, pinned in `cmake/Dependencies.cmake`). Neural/SA3 deps are fetch-gated behind `-DMOSH_ENABLE_RTNEURAL=ON` / `-DMOSH_ENABLE_ANIRA=ON`; the generative service runs under its MLX venv when `MOSH_ENABLE_SA3=1`.
- **UI tests:** `npm test` in `ui/` (vitest + jsdom). `commands.contract.test.ts` parses `MoshOps.cpp` so the agent command catalog can't drift from the backend.
- **UI e2e:** `npm run test:e2e` in `ui/` (Playwright + headless Chromium). Specs in `ui/e2e/` drive the real React WebView against the Vite dev server, where `bridge.ts` wires in the in-memory mock backend (`bridge.mock.ts`) — the same `execute_command`+snapshot+events contract the C++ MoshOps exposes — so the whole frontend (store, gestures, keymap, templates, optimistic previews) is exercised deterministically with no native build / audio / Python service. Coverage: the full producer loop, per-template regression (Mosh/Ableton/FL), keyboard-a11y / empty-state / narrow-window polish, and a per-skin screenshot walkthrough (`e2e-artifacts/`). The packaged WKWebView app can't be Playwright-driven (and its command surface is identical), so its smoke path stays `Mosh --selftest`.

---

## 6. Where the rest of the truth lives

- **`CLAUDE.md`** — the run manifest: prime directives + per-stage gate ledger (what's done / next). Auto-loads every session.
- **Specs `00`–`07`** (repo root) — the detailed design, "source of truth for *how*." Each carries a status banner. *(Numbering: `02` is `docs/02_MOSHOPS_CONTRACT.md`; there is no `03` — the WebView UI is covered here + by `02`.)*
- **`docs/`** — live reference: `INDEX.md` (the doc map — start here), `02_MOSHOPS_CONTRACT.md`, `ENGINE_API_NOTES.md`, `PROGRESS.md`, `FEATURE_AUDIT.md`, `IPHONE_COMPANION.md`, and the `plans/` wave roadmap.
- **`docs/archive/`** — dated point-in-time reports, frozen by design; kept for history: `consolidation/`, `hardening/`, `superpowers/` (design-sprint specs), `test-iterate-loop/`, `ponytail-audit-report.md`.
- **`design-lab/`** — the Moshi-character design taste reference (`HOUSE_STYLE.md`, `LOOKBOOK.md`).
- **Agent memory** (`~/.claude/.../memory/`) — cross-session facts; e.g. `project-file-management-state.md` records the verified save/open behavior summarized in §4.
