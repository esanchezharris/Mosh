# 02 (reconstructed) — MoshOps & the State Feed

*Spec `02` is absent from the repo. This is the contract as designed from `00 §2/§6/§7` and `01` and as implemented in `src/moshops/`. It is the single coupling between the React UI and the C++ backend (the swappable seam). Keep this in sync with `src/moshops/MoshOps.*`.*

---

## The seam (three calls + one feed)

The UI (`ui/src/bridge.ts`) talks to the backend ONLY through:

| Native fn | Direction | Shape |
|---|---|---|
| `execute_command(cmd)` | UI → C++ | `cmd → result` (the single mutation path) |
| `get_snapshot()` | UI → C++ | `→ snapshot` (full state, cold) |
| `"mosh_event"` channel | C++ → UI | typed events (snapshot+events feed) |

Pure view state (zoom, scroll, selection, drawers) is **UI-local** and never crosses this seam — keeps the JSONL a clean semantic/taste trail.

## Command envelope

```jsonc
// request
{ "command": "create_track", "args": { "name": "Drums" } }
// result
{ "ok": true,  "command": "create_track", "data": { "trackId": "1023" } }
{ "ok": false, "command": "create_track", "error": "insert failed" }
```

Every command: **validate → begin a Tracktion undo transaction (if undoable) → mutate via engine APIs → emit events → append a JSONL line → return the envelope.** One command = one undo step. The UI never mutates the engine directly.

## Command catalog (Stage 1)

| Command | args | undoable | result.data | events |
|---|---|---|---|---|
| `create_track` | `{name?}` | ✓ | `{trackId}` | `snapshot_invalidated` |
| `rename_track` | `{trackId, name}` | ✓ | — | `snapshot_invalidated` |
| `remove_track` | `{trackId}` | ✓ | — | `snapshot_invalidated` |
| `import_clip` | `{file, trackId?, startSeconds?, name?}` | ✓ | `{clipId, trackId}` | `snapshot_invalidated` |
| `add_test_tone_clip` | `{seconds?, freq?, trackId?, name?}` | ✓ | `{clipId, trackId}` | `snapshot_invalidated` |
| `set_transport` | `{action?: play\|stop\|toggle\|record, position?, loop?, loopStart?, loopEnd?}` | ✗ | `transport` | `transport` |
| `undo` / `redo` | `{}` | ✗ (drives the manager) | `bool` | `snapshot_invalidated` |
| `save` / `reload` | `{}` | ✗ | — | `reload`→`snapshot_invalidated` |
| `add_render_layer` | `{clipId, adapter?}` | ✓ | `{layerId}` | `snapshot_invalidated` |

Stage 2 adds `move_clip` / `trim_clip` / `split_clip`; Stage 3 the plugin commands; Stage 4 `add_neural_insert` / `set_neural_param` / `set_neural_lab_mode`; Stage 5 the generative commands. Stage 6 adds `export_audio` with `{file?, renderMode?}` where `renderMode` is `"auto" | "fast" | "realtime"`; `"auto"` keeps fast render unless a known realtime-only hosted plugin such as Xfer Serum 2 is enabled, then selects realtime render. Its result includes `{file, bytes, seconds, renderModeRequested, renderMode, renderModeReason, realTimeRender}`. All follow the same envelope.

Hosted plugin snapshots/results include external-plugin diagnostics when Tracktion has the instance: `{manufacturer, file, identifier, numInputs, numOutputs, isNonRealtime}`. `open_plugin_editor` warms the playback context before opening native editors when audio is available and returns `{audioEnabled, playbackContextActiveBefore, playbackContextActive, plugin}`.

## Snapshot

```jsonc
{
  "schemaVersion": 1,
  "session":   { "sampleRate": 44100, "tempo": 120.0, "editFile": "…/session.tracktionedit" },
  "tracks": [
    { "id": "1023", "index": 0, "name": "Track 1", "type": "audio",
      "clips": [
        { "id": "1041", "name": "tone-220", "type": "wave",
          "start": 0.0, "length": 2.0, "offset": 0.0,
          "sourceFile": "…/audio/tone-220.wav", "hasRenderLayer": false }
      ] }
  ],
  "transport": { "playing": false, "recording": false, "position": 0.0,
                 "looping": false, "loopStart": 0.0, "loopEnd": 0.0 }
}
```

## Events (channel `"mosh_event"`, payload `{type, payload?}`)

- `snapshot_invalidated` — structural change; the UI refetches the snapshot. This is the documented "resync" choice (`02 // VERIFY`: snapshot_invalidated vs precise inverse-deltas). Undo/redo and reload use it. Stage 2 may refine hot paths to precise deltas.
- `transport` — `{playing, recording, position, looping, loopStart, loopEnd}`. Pushed on every `set_transport` AND **decimated to 30 Hz** by a backend timer while playing (telemetry never per-block). Drives the animated playhead without polling.

## Undo / threading invariants

- **One undo system:** `edit.getUndoManager()` (a `juce::UndoManager`) is the implementation. `beginNewTransaction("<command>")` groups each undoable command. No shadow model.
- **Threading:** `execute()`, `snapshot()`, and event emission run on the **message thread** (WebView native callbacks land there). Audio stays on the RT graph. The 30 Hz transport timer is the only periodic emit.

## JSONL log (`<session>/mosh-log.jsonl`)

One line per executed command — the semantic audit trail / taste-signal flywheel:
```jsonc
{ "ts": 1719…, "seq": 7, "command": "import_clip", "args": {…}, "ok": true, "undoable": true }
```
Stage 5 adds `accept_render` / `reject_render` lines as explicit **taste labels**.
