# 02 — MoshOps: the Command Surface & State Feed (the spine)

*Scope: the single mutation API for all of Mosh. Every user-visible state change is a typed command with a structured result; commands run Tracktion undo transactions, emit typed events, and append to a JSONL semantic log. The UI receives state via a snapshot + typed-events feed. This module is the backbone the UI, self-tests, and (later) Monster/MCP/multiplayer all share.*

**Depends on:** `01` (the engine store it mutates). **Consumed by:** `03` (the UI calls it), `04`/`05` (plugin & generative actions are commands), `06` (tests target it).
**Effort:** **core new design.** Not large in code, but it's load-bearing — get the contract right and the frontend becomes disposable; get it wrong and the UI welds to the backend.
**Why it exists (from the architecture review):** letting UI/agent layers mutate raw Tracktion ValueTrees loses validation, atomicity, undo coupling, and guardrails. A constrained typed-command facade with structured results + a log fixes that and *is* the future agent/multiplayer substrate — without building a CRDT yet. Tracktion's UndoManager stays the undo implementation underneath.

---

## 1. Shape

`DslExecutor` (C++, in `src/moshops/`) exposes one entry point:

```cpp
MoshResult execute(const MoshCommand& cmd);     // cmd = { name, args (typed/JSON) }
```

It also exposes the read side:

```cpp
juce::var getSnapshot();                          // full session state (§4)
void addEventListener(MoshEventListener*);        // typed deltas (§4)
```

Every `execute` call: **validate → begin a Tracktion undo transaction → perform the mutation via the engine APIs (`01`) → emit typed event(s) → append a JSONL log line → return a structured result.** Pure-view-state changes are **not** commands (§3).

---

## 2. The result envelope

Every command returns exactly this shape (serialized to the WebView as JSON):

```json
{
  "ok": true,
  "message": "human-readable summary",
  "changed_entities": ["track:vocal", "clip:hook_a"],
  "error_code": null,
  "data": {}
}
```

- `ok` / `error_code`: success + a stable machine code on failure (e.g. `"NO_SUCH_TRACK"`, `"INVALID_RANGE"`, `"MODEL_BUSY"`).
- `changed_entities`: stable entity refs (`<type>:<id>`) the caller may use to refetch or to scope UI updates; the event stream (§4) is the primary live-update path, this is a coarse hint.
- `data`: command-specific payload (e.g. the new track id, a job id for a render).

---

## 3. The command catalog (v0)

Grouped; each is a verb with typed args, returning the envelope. (Implementations call the `01`/`04`/`05` engine APIs inside a transaction.)

**Session / tracks / clips**
`create_track` · `delete_track` · `rename_track` · `reorder_track` · `set_track_gain` · `set_track_mute` · `set_track_solo` · `arm_track` ·
`import_clip` · `move_clip` · `trim_clip` · `split_clip` · `duplicate_clip` · `delete_clip`

**Transport / tempo**
`set_transport` (play/stop/record/loop/position) · `set_tempo` · `set_time_signature`

**Plugins (VST3 + built-ins) — `04`**
`load_plugin` · `remove_plugin` · `reorder_plugin` · `set_plugin_param` · `bypass_plugin` · `open_plugin_editor`

**Real-time neural (Tier A) — `04`**
`add_neural_insert` (model id) · `set_neural_model` · `set_neural_param` (ASTD-mapped) · `set_neural_lab_mode` · `bypass_neural_insert`

**Generative (Tier B) — `05`**
`create_render_layer` · `set_render_param` · `render_layer` (→ returns a job id) · `cancel_render` · `accept_render` (optional `landing` = `"take"` | `"new_clip"`; defaults to the per-project setting `neural_render_landing`, default `"take"` = alternate take on the source clip) · `reject_render` · `bypass_layer` · `freeze_layer` · `bounce_layer_to_clip`

**Triggers (not state mutations, but actions worth logging)**
`open_plugin_editor` (creates a native window) is here rather than view-state because it touches native resources.

> **What is NOT a command (UI-local view state):** drawer open/close, panel layout, zoom level, scroll position, current selection, theme choice. These live in the React app (and optionally a small persisted UI-prefs blob), are **never** in the mutation log or undo stack, and keep the JSONL a clean **semantic/taste** trail. (Selection *may* be mirrored to the backend if a command needs a default target, but the source of truth for view state is the UI.)

Adding a command is the standard extension point — for new features, for self-tests, and later for Monster (same surface) and MCP (expose the same commands as tools).

---

## 4. The state feed: snapshot + typed events (decision "c")

The UI is fed two ways, fully decoupled:

### 4.1 Snapshot (load / resync / cold-render)

`getSnapshot()` returns the **entire** current session as plain data — tracks, clips (positions/refs/take info), plugin chains + params, RenderLayer states, transport, tempo. Any client can render this cold with zero prior assumptions. Used on app load, on project open, and as a resync when the UI suspects drift.

```json
{
  "tracks": [ { "id":"track:vocal", "name":"Vocal", "gain":0.8, "mute":false,
                "clips":[ {"id":"clip:hook_a","range":[12.0,16.0],"takeCount":2,"activeTake":1} ],
                "plugins":[ {"id":"plg:1","type":"vst3","name":"Serum","bypassed":false} ],
                "renderLayers":[ {"id":"rl:3","status":"ready","mode":"reimagine"} ] } ],
  "transport": {"position":4.0,"playing":false,"loop":[0.0,32.0]},
  "tempo": {"bpm":140,"sig":"4/4"}
}
```

### 4.2 Typed events (live deltas during a session)

A push stream of small typed deltas the UI applies incrementally. Examples:

```
track_added {id,...}        track_removed {id}      track_changed {id, fields}
clip_added {...}            clip_moved {id,range}   clip_split {...}   clip_removed {id}
plugin_added {...}          plugin_param_changed {pluginId,param,value}   plugin_bypassed {...}
layer_status {id,status}    layer_render_progress {id, pct, etaSec}      layer_rendered {id, takeId}
transport_position {pos}    // DECIMATED 30–60 Hz
meter_update {trackId, rms, peak}   // DECIMATED 30–60 Hz, never per-block
```

- **Decimation is mandatory** for `transport_position` and `meter_update` (30–60 Hz). Audio/telemetry never streams per-block to JS, and **nothing audio-rate runs on the web thread**.
- Events originate from MoshOps (for command-driven changes) and from a decimating telemetry tap on the audio graph (for playhead/meters), marshaled to the message thread before crossing the WebView bridge (`03`).
- The combination is what makes the frontend disposable: snapshot = render-from-nothing; events = cheap live updates; neither leaks Tracktion internals.

---

## 5. The JSONL semantic log (the taste flywheel)

Every command appends one line:

```json
{"ts":"2026-06-08T18:22:10.512Z","cmd":"accept_render","args":{"layer":"rl:3"},
 "ok":true,"changed_entities":["clip:hook_a"],"data":{"takeId":"take:9"}}
```

This is a **semantic audit trail**, not (yet) a CRDT op-log. Its v0 jobs: deterministic self-tests (replay a command sequence), debugging, and — crucially — **acceptance signals**: every `accept_render`/`reject_render` is a taste label (which transform, which colors, which seed, kept or not), captured for free. Post-v0 the same stream is the substrate the agent and multiplayer build on. Keep entries semantic and stable; do not log view-state churn into it.

---

## 6. Implementation notes

- **Validation first:** reject bad commands with a stable `error_code` before touching the tree (no partial mutations). Where Tracktion can fail mid-op, wrap so the transaction is abandoned cleanly.
- **One transaction per command** (`beginNewTransaction("<cmd>")`) so undo/redo is one user-meaningful step. `undo`/`redo` are themselves invokable (as commands or a dedicated call) and emit a resync-friendly event or a snapshot bump.
- **Threading:** `execute` runs on the message thread (it mutates the model). The WebView bridge (`03`) marshals incoming calls to the message thread and posts results/events back.
- **Stable ids:** assign stable string ids (`track:…`, `clip:…`, `plg:…`, `rl:…`) and use them everywhere (snapshot, events, results, log). The UI keys off ids, never off array indices.

---

## 7. Verification gate (Stage 1 portion)

`execute(create_track)` then `execute(import_clip)` mutate via Tracktion transactions; `getSnapshot()` reflects them; the event stream emits `track_added`/`clip_added`; the WebView renders the snapshot and applies the events; `undo` reverts and emits the inverse; the JSONL log contains the two semantic lines; save/reload + a fresh `getSnapshot()` matches.

## 8. Honest gaps / decisions to confirm

- Event-vs-snapshot granularity per surface — start with the event set in §4.2; add events as new commands appear. When in doubt for a complex change, emit a coarse `changed_entities` and let the UI refetch a sub-snapshot.
- The undo/redo event: simplest is a `snapshot_invalidated` signal that prompts a `getSnapshot()`; optimize to precise inverse-deltas only if the resync feels heavy.
- Whether selection is mirrored to the backend (only if a command needs an implicit target) — prefer explicit target args in commands and keep selection UI-local.
