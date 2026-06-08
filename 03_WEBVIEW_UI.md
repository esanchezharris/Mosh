# 03 — The WebView Frontend (deliberately swappable)

*Scope: the v0 UI. A React/Vite app in a JUCE 8 WebView, in a conventional traditional-DAW layout, coupled to C++ only through MoshOps `execute_command(...)` and the snapshot+events feed. Built fresh and kept thin on purpose — it's meant to surface every control plainly now and be consolidated into something beautiful later.*

**Depends on:** `02` (the command surface + state feed it talks to). **Consumed by:** the human.
**Effort:** frontend; intentionally disposable. The durable contract is in `02`, not here. Do not over-invest in pixels.
**Primary references:** JUCE 8 WebView (`WebBrowserComponent` + `window.__JUCE__.backend` native integration), the JUCE WebView tutorials/examples; Vite.

> **The seam is the product, not the pixels.** Because the UI couples to the backend only via `02`'s contract, you can throw this React layer away and rebuild it as many times as you want without the backend noticing. Treat that as the design constraint: no Tracktion knowledge in the frontend, no audio on the web thread, all mutation through commands, all state from snapshot+events.

---

## 1. The shell

A native window hosts a JUCE 8 `WebBrowserComponent` configured for native integration, loading the **bundled, local** React build (owned content — JUCE docs warn to enable native integration only for content you control; ours qualifies).

- The audio engine, Tracktion, MoshOps, the audio graph, and plugin processing all run **native/C++**. The WebView is purely a UI client.
- Bundle the Vite output and load it from disk (or an embedded resource), not a dev server, in release. A dev mode may point at the Vite dev server for iteration.

---

## 2. The bridge (`src/webview/`)

The only coupling between frontend and backend. Two directions:

**UI → C++ (commands).** Register a native function the JS calls, e.g. `executeCommand(name, argsJson)`, exposed via `window.__JUCE__.backend`. It marshals to the message thread, calls `DslExecutor::execute`, and returns the result envelope (`02 §2`) as a resolved promise.

```ts
// frontend
const res = await backend.executeCommand("move_clip", { id: "clip:hook_a", range: [13.0, 17.0] });
if (!res.ok) showError(res.error_code, res.message);
```

**C++ → UI (state).** Two channels:
- `getSnapshot()` exposed as a native function the UI calls on load / project-open / resync.
- An **event push**: the bridge subscribes to MoshOps events (`02 §4.2`) and the decimating telemetry tap, and pushes typed deltas to JS (via JUCE's WebView event/emit mechanism). The UI applies them to its store.

**Rules:** marshal all native-function bodies to the message thread; never block the WebView thread on audio; decimate telemetry to 30–60 Hz before it crosses (`02 §4.2`); serialize with stable ids (`02 §6`).

---

## 3. The React app (`ui/`) — conventional layout

A standard DAW arrangement, no novel interaction in v0. Components (all driven by the store fed from snapshot+events; all edits emit commands):

```
App
 ├─ TransportBar         // play/stop/record/loop, tempo, position readout  → set_transport, set_tempo
 ├─ TrackList (left)     // headers: name, gain, mute/solo, arm, plugin slots → create_track, set_track_*, load_plugin
 ├─ Timeline (center)
 │    ├─ Ruler           // bars/beats/seconds (from tempo in snapshot)
 │    ├─ Lanes           // one per track
 │    │    └─ ClipView[] // position from snapshot; drag/trim/split emit move_clip/trim_clip/split_clip
 │    │         • waveform: render from a thumbnail image/peaks the backend provides (see §5)
 │    │         • RenderLayer badge: status from layer_status/layer_render_progress events
 │    └─ Playhead        // from decimated transport_position events
 ├─ Mixer (bottom/side)  // strips: fader/pan/meters(decimated)/sends → set_track_gain, etc.
 ├─ Drawers              // context panels (UI-LOCAL view state — NOT commands): plugin params, Color Rack (05)
 └─ B5Slot               // reserved, empty in v0
```

State management: a single client store (e.g. Zustand/Redux/signals — implementer's choice) holds the last snapshot and applies events. Keep it dumb: it mirrors backend state, it does not own domain logic. Selection, zoom, scroll, drawer open/close live here as **view state** and never become commands (`02 §3`).

---

## 4. Plugin editors are native pop-outs

VST3/AU editors are **not** rendered in the WebView. `open_plugin_editor` (`02`/`04`) creates a native JUCE window hosting the plugin's own `AudioProcessorEditor`. The WebView shows a "open editor" affordance and the plugin's Mosh-side params (for automation/quick control) but delegates the real editor to native. (Built-in/neural faceplates may be WebView-rendered since they're just MoshOps params; see `04`.)

---

## 5. Waveforms & meters without audio on the web thread

- **Waveforms:** the backend computes peaks/thumbnails (Tracktion `SmartThumbnail`/`AudioThumbnail`) and hands the UI either a pre-rendered image or a downsampled peak array per clip (via a command/result or a sub-snapshot). The UI does not process audio to draw waveforms.
- **Meters/playhead:** driven only by decimated `meter_update`/`transport_position` events (30–60 Hz). No per-sample data crosses the bridge.

---

## 6. Swappability discipline (the point of v0)

- No `tracktion`/audio concepts in the frontend vocabulary — only the snapshot schema and the command catalog.
- Every interaction resolves to a command; every visual reflects snapshot/events.
- The frontend can be deleted and rebuilt (different framework, different layout) against the same `02` contract with no backend change. The Stage-2 gate explicitly tests this (reload/rebuild the bundle, zero backend change).
- Because it's disposable, **do not gold-plate**: conventional controls, clear labels, all functions reachable. Beauty/consolidation is a later pass.

---

## 7. Verification gates

- **Stage 1 portion:** the app loads, calls `getSnapshot()`, renders an empty session, and `create_track`/`import_clip` from the UI round-trip (command → event → store → view).
- **Stage 2:** arrange a session entirely in the WebView (move/trim/split clips, transport, loop), responsive feel; meters/playhead update via decimated events; rebuild the React bundle and it still works against the unchanged backend.

## 8. Honest gaps / `// VERIFY`

- JUCE 8 WebView native-function / event-emit API specifics on your JUCE version (`window.__JUCE__.backend` registration, the C++→JS emit call). Confirm against the JUCE WebView example.
- The waveform delivery mechanism (pre-rendered image vs peak array) — start with a peak array per clip in a sub-snapshot; switch to server-rendered images only if draw cost matters.
- Whether built-in/neural faceplates are WebView or native — default WebView (they're just params); go native only if a control needs it.
- Arrange-view interaction polish (snap/zoom/marquee) is incremental; gate it within Stage 2/6, not up front.
