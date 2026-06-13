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

The engine backend is also kept behind this seam. The UI may read additive
`snapshot.session.backend` / `snapshot.session.backendCapabilities` fields and
call the additive diagnostics commands below, but it must not import Tracktion,
JUCE, Maolan, or IPC details directly.

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
| `get_engine_diagnostics` | `{}` | ✗ | backend diagnostics | — |
| `run_engine_contract_slice` | `{outputDir?, timeoutSeconds?}` | ✗ | backend result envelope | — |

Stage 2 adds `move_clip` / `trim_clip` / `split_clip` / `duplicate_clip` / `paste_clip` / `delete_time_range` plus read-only `get_clip_peaks`; Stage 3 the plugin commands; Stage 4 `add_neural_insert` / `set_neural_param` / `set_neural_lab_mode`; Stage 5 the generative commands. Stage 6 adds `export_audio` with `{file?, renderMode?}` where `renderMode` is `"auto" | "fast" | "realtime"`; `"auto"` keeps fast render unless a known realtime-only hosted plugin such as Xfer Serum 2 is enabled, then selects realtime render. Its result includes `{file, bytes, seconds, renderModeRequested, renderMode, renderModeReason, realTimeRender}`. All follow the same envelope.

Hosted plugin snapshots/results include external-plugin diagnostics when Tracktion has the instance: `{manufacturer, file, identifier, numInputs, numOutputs, isNonRealtime}`. `open_plugin_editor` warms the playback context before opening native editors when audio is available and returns `{audioEnabled, playbackContextActiveBefore, playbackContextActive, plugin}`.

## Snapshot

```jsonc
{
  "schemaVersion": 1,
  "session":   {
    "sampleRate": 44100,
    "tempo": 120.0,
    "editFile": "…/session.tracktionedit",
    "backend": "tracktion",
    "backendCapabilities": [
      { "operation": "renderExport", "status": "reference", "supported": true }
    ]
  },
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

## Engine contract slice

See `docs/engine/MOSH_ENGINE_CONTRACT.md` for the backend-agnostic operation set
and result envelope. The default backend is Maolan. `MOSH_ENGINE_BACKEND=tracktion`
selects the Tracktion/JUCE reference adapter; `MOSH_ENGINE_BACKEND=maolan`
keeps the production backend explicit. In Maolan mode, the supported first-slice
MoshOps names route through the engine contract instead of falling through to
Tracktion: `new_project`, `open_project`, `list_audio_devices`,
`set_audio_device`, `rescan_plugins`, `list_plugins`, `list_builtins`, `create_track`,
`get_plugin_blocklist`, `clear_plugin_blocklist`, `block_plugin`,
`rename_track`, `remove_track`, `add_test_tone_clip`, `import_clip`,
`import_clip_data`,
`move_clip`, `trim_clip`, `split_clip`, `duplicate_clip`, `paste_clip`, `delete_time_range`, `rename_clip`, `remove_clip`, `set_clip_mute`,
`set_clip_gain`, `set_clip_warp`, `add_midi_clip`, `add_note`, `remove_note`, `set_note`,
`quantize_notes`, `get_clip_peaks`, `set_track_volume`, `set_track_pan`, `set_track_mute`,
`set_track_solo`, `enable_track_meter`, `disable_track_meter`, `enable_all_meters`,
`set_master_volume`, `set_master_pan`, `create_bus`,
`rename_bus`, `remove_bus`, `add_send`, `set_send_level`, `remove_send`,
`create_group_track`, `ungroup_track`,
`list_midi_inputs`, `list_wave_inputs`, `list_track_outputs`, `set_track_input`,
`set_track_output`, `arm_track`, `set_input_monitor`, `stop_recording`,
`set_tempo`, `insert_tempo_change`, `remove_tempo_change`, `set_tempo_curve`,
`set_time_signature`, `insert_time_sig_change`, `remove_time_sig_change`, `set_metronome`,
`set_project_settings`, `load_plugin`, `remove_plugin`, `set_plugin_param`,
`reorder_plugin`, `bypass_plugin`, `add_automation_point`, `remove_automation_point`,
`set_automation_point`, `clear_automation`, bounded play/stop/seek `set_transport`, `export_audio`,
`save`, `save_as`, and `reload`. Record transport remains unsupported.
Unsupported commands return structured `unsupported_by_backend` errors and must
not mutate the Tracktion edit.
Backend-neutral read-only commands that do not touch engine state may remain
local in Maolan mode. The current allowed local reads are `list_directory`,
`get_command_log`, and `list_colors`; they must not write MoshOps JSONL lines,
emit snapshot invalidations, or write Maolan backend command/timing records.
In Maolan mode `list_colors` is a local UI helper and returns an empty color
rack until a real process-backed color service exists.
`get_plugin_blocklist` is routed to `MaolanProcessBackend` but is read-only at
the MoshOps layer, so it writes backend evidence and does not write a MoshOps
JSONL line. `block_plugin` and `clear_plugin_blocklist` are non-undoable catalog
mutations that must filter `list_plugins` and reject blocked `load_plugin`
requests with structured `blocked_plugin` errors.
`list_midi_inputs` is a routed synthetic read in Maolan mode: it returns a
well-formed empty input list plus `audioEnabled:false` and does not touch
Tracktion's device manager or write a MoshOps JSONL line.
`list_builtins` is a routed synthetic read in Maolan mode: it returns
`plugins:[]` because Tracktion built-ins are not exposed by the Maolan process
backend. `load_builtin` remains structured unsupported until a real Maolan-native
built-in path exists.

Use `scripts/maolan-moshops-routing-gate.sh` for the routed command path and
`scripts/maolan-contract-slice-gate.sh` for the lower-level backend slice. Use
`scripts/maolan-persistence-restart-gate.sh` when changing Maolan open/save/reload
persistence, and `scripts/maolan-contract-ui-gate.py` when changing the first
Engine-panel UI workflow. In Maolan mode, the snapshot's first-slice `tracks`,
track `clips`, `transport`, tempo/time-signature/metronome/project settings,
tempo/time-signature map metadata,
track input/output/arm/monitor posture,
meter posture, master bus state, aux bus metadata, and send routing,
group/submix metadata,
and session graph fields are projected from
`MaolanProcessBackend`; the UI must not use Tracktion edit state as a silent
fallback while that backend is selected. The current Maolan clip slice persists
MOSH-owned clip metadata/source WAV evidence, clip auto-tempo/warp metadata, plugin-chain metadata for
load/remove/reorder/parameter/bypass/automation state, plugin catalog blocklist
state, MIDI clip/note-edit metadata in the MOSH
graph, and native Maolan session-folder `graphs` for loaded VST3 plugins.
Maolan native MIDI playback/render is not part of this phase; render/export
materializes wave clips and plugin graph data. `export_audio` now writes a
Maolan session-folder export
when MOSH-owned wave clips exist; plugin-backed renders use Maolan offline
bounce and must report `render_source=maolan-offline-bounce`,
`plugin_graph_applied=true`, restored VST3 counts, worker readiness, and
bounced-track WAV artifacts. `set_transport` play writes
`playback-smoke/maolan-play-session-smoke-stats.json` and must prove
Maolan session playback start, transport movement, stop confirmation, restored
VST3 instances, and worker readiness. `save`, `save_as`, `open_project`, and
`reload` also materialize the Maolan persistence session
`session-maolan/main.json` and expose that artifact path through result data and
diagnostics.
Track input/output, record-arm, monitor mode, and `stop_recording` currently
persist MOSH-owned posture and return explicit no-live-input `applied:false`
results; live Maolan recording is a later slice.
Group tracks currently preserve the existing `type:"group"`, `isGroup:true`,
and member `parentId` snapshot shape; native Maolan submix summing is a later
slice.
Tempo and time-signature map commands currently preserve MOSH-owned point and
curve metadata; native Maolan tempo-ramp playback/render behavior is a later
slice.
Plugin automation currently preserves MOSH-owned parameter point metadata in the
session graph and snapshot; native Maolan DSP automation playback/render behavior
is a later slice.
Clip warp currently preserves MOSH-owned `autoTempo`, `sourceBpm`,
`stretchMode`, and source-length metadata in the session graph and snapshot;
native Maolan time-stretch playback/render behavior is a later slice.
Meter support currently preserves MOSH-owned `meterEnabled` posture in the
session graph and snapshot; native Maolan level samples are a later slice.
