# MOSH Engine Contract

This is the backend contract under the existing MoshOps/WebBridge seam. The UI
continues to talk only through `execute_command`, `get_snapshot`, and the
`mosh_event` feed. Backend choice is reported additively in the snapshot and
driven through small contract commands.

## Boundary

The contract is product-shaped, not engine-shaped. It exposes the workflows MOSH
needs to prove before new product UI is built on top of a backend:

- `createSession` / `openSession`
- `selectAudioDevice`
- `scanPlugins`
- `getPluginBlocklist`
- `clearPluginBlocklist`
- `blockPlugin`
- `loadPlugin`
- `removePlugin`
- `reorderPlugin`
- `setPluginParam`
- `bypassPlugin`
- `addAutomationPoint`
- `removeAutomationPoint`
- `setAutomationPoint`
- `clearAutomation`
- `createTrack`
- `renameTrack`
- `removeTrack`
- `addClip`
- `moveClip`
- `trimClip`
- `splitClip`
- `duplicateClip`
- `pasteClip`
- `deleteTimeRange`
- `renameClip`
- `removeClip`
- `setClipMute`
- `setClipGain`
- `setClipWarp`
- `addMidiClip`
- `addNote`
- `removeNote`
- `setNote`
- `quantizeNotes`
- `getClipPeaks`
- `setTrackVolume`
- `setTrackPan`
- `setTrackMute`
- `setTrackSolo`
- `enableTrackMeter`
- `disableTrackMeter`
- `enableAllMeters`
- `setMasterVolume`
- `setMasterPan`
- `createBus`
- `renameBus`
- `removeBus`
- `addSend`
- `setSendLevel`
- `removeSend`
- `createGroupTrack`
- `ungroupTrack`
- `setTrackInput`
- `setTrackOutput`
- `armTrack`
- `setInputMonitor`
- `stopRecording`
- `setTempo`
- `insertTempoChange`
- `removeTempoChange`
- `setTempoCurve`
- `setTimeSignature`
- `insertTimeSigChange`
- `removeTimeSigChange`
- `setMetronome`
- `setProjectSettings`
- `setTransport`
- `renderExport`
- `saveSessionGraph` / `restoreSessionGraph`
- `diagnostics`

The UI must not import Tracktion, JUCE, Maolan, plugin-host, or IPC details. It
may read `snapshot.session.backend` and `snapshot.session.backendCapabilities`.
In Maolan mode, the existing MoshOps command names for the supported vertical
slice are routed through this contract instead of falling through to Tracktion.

## Result Shape

Every backend operation returns the same envelope:

```json
{
  "ok": true,
  "backend": "maolan",
  "commandId": "renderExport",
  "data": {},
  "diagnostics": {
    "backend": "maolan",
    "commandId": "renderExport",
    "timingMs": 1234.0,
    "stdoutPath": "/path/to/stdout.log",
    "stderrPath": "/path/to/stderr.log",
    "artifacts": ["/path/to/render.wav"]
  }
}
```

Failures keep the same shape and use a structured error:

```json
{
  "ok": false,
  "backend": "maolan",
  "commandId": "setTransport",
  "error": {
    "code": "unsupported_by_backend",
    "message": "Maolan process backend does not expose record through MoshOps yet."
  },
  "diagnostics": {
    "backend": "maolan",
    "commandId": "setTransport"
  }
}
```

## Backends

### Tracktion/JUCE Reference

Tracktion remains the reference backend. It is the comparison harness for the
existing MOSH app and selftests. The current command handlers still execute the
Tracktion-backed workflow when requested; the `TracktionEngineBackend` adapter
reports capabilities and diagnostics around that live engine.

### Maolan Process Backend

Maolan is the default backend and can also be selected explicitly with:

```sh
MOSH_ENGINE_BACKEND=maolan
```

This phase does not link Maolan as a library. `MaolanProcessBackend` shells out
to the private MaolanMosh harness and Maolan CLI binaries through:

- `/Users/emiliosanchez-harris/Documents/MaolanMosh/config/maolan.private.env`
- `maolan-test --plugin-format vst3 --plugin-path <JamPilotTestGain.vst3> --device coreaudio:default --load-only`
- `maolan-export-session-bounced --session-dir <evidence-dir>/render-smoke/maolan-session --export-base <evidence-dir>/render-smoke/maolan-render-smoke --stats <evidence-dir>/render-smoke/maolan-render-smoke-stats.json --device coreaudio:default`
- `maolan-export-session --session-dir <evidence-dir>/render-smoke/maolan-session --export-base <evidence-dir>/render-smoke/maolan-render-smoke --stats <evidence-dir>/render-smoke/maolan-render-smoke-stats.json`
- `maolan-play-session-smoke --session-dir <evidence-dir>/render-smoke/maolan-session --stats <evidence-dir>/playback-smoke/maolan-play-session-smoke-stats.json --device coreaudio:default`
- `maolan-render-smoke --output-dir <evidence-dir>/render-smoke` only as an empty-graph fallback
- MOSH-owned JSON session graph files plus a materialized Maolan persistence
  session-folder `session-maolan/main.json` for save/open/restore replay

Unsupported Maolan commands must return `unsupported_by_backend`, not crash or
fall through to accidental Tracktion mutation.

## MoshOps Routing

`MOSH_ENGINE_BACKEND=maolan` routes this first supported MoshOps subset through
`MaolanProcessBackend`:

- `new_project` -> `createSession`
- `open_project` -> `openSession`
- `list_audio_devices` / `set_audio_device` -> `selectAudioDevice`
- `rescan_plugins` / `list_plugins` -> `scanPlugins`
- `list_builtins` -> empty Maolan built-in catalog posture
- `get_plugin_blocklist` -> `getPluginBlocklist`
- `clear_plugin_blocklist` -> `clearPluginBlocklist`
- `block_plugin` -> `blockPlugin`
- `create_track` -> `createTrack`
- `rename_track` -> `renameTrack`
- `remove_track` -> `removeTrack`
- `add_test_tone_clip` / `import_clip` / `import_clip_data` -> `addClip`
- `move_clip` -> `moveClip`
- `trim_clip` -> `trimClip`
- `split_clip` -> `splitClip`
- `duplicate_clip` -> `duplicateClip`
- `paste_clip` -> `pasteClip`
- `delete_time_range` -> `deleteTimeRange`
- `rename_clip` -> `renameClip`
- `remove_clip` -> `removeClip`
- `set_clip_mute` -> `setClipMute`
- `set_clip_gain` -> `setClipGain`
- `set_clip_warp` -> `setClipWarp`
- `add_midi_clip` -> `addMidiClip`
- `add_note` -> `addNote`
- `remove_note` -> `removeNote`
- `set_note` -> `setNote`
- `quantize_notes` -> `quantizeNotes`
- `get_clip_peaks` -> `getClipPeaks`
- `set_track_volume` -> `setTrackVolume`
- `set_track_pan` -> `setTrackPan`
- `set_track_mute` -> `setTrackMute`
- `set_track_solo` -> `setTrackSolo`
- `enable_track_meter` -> `enableTrackMeter`
- `disable_track_meter` -> `disableTrackMeter`
- `enable_all_meters` -> `enableAllMeters`
- `set_master_volume` -> `setMasterVolume`
- `set_master_pan` -> `setMasterPan`
- `create_bus` -> `createBus`
- `rename_bus` -> `renameBus`
- `remove_bus` -> `removeBus`
- `add_send` -> `addSend`
- `set_send_level` -> `setSendLevel`
- `remove_send` -> `removeSend`
- `create_group_track` -> `createGroupTrack`
- `ungroup_track` -> `ungroupTrack`
- `list_midi_inputs` / `list_wave_inputs` / `list_track_outputs` -> synthetic Maolan process views
- `set_track_input` -> `setTrackInput`
- `set_track_output` -> `setTrackOutput`
- `arm_track` -> `armTrack`
- `set_input_monitor` -> `setInputMonitor`
- `stop_recording` -> `stopRecording`
- `set_tempo` -> `setTempo`
- `insert_tempo_change` -> `insertTempoChange`
- `remove_tempo_change` -> `removeTempoChange`
- `set_tempo_curve` -> `setTempoCurve`
- `set_time_signature` -> `setTimeSignature`
- `insert_time_sig_change` -> `insertTimeSigChange`
- `remove_time_sig_change` -> `removeTimeSigChange`
- `set_metronome` -> `setMetronome`
- `set_project_settings` -> `setProjectSettings`
- `load_plugin` -> `loadPlugin`
- `remove_plugin` -> `removePlugin`
- `reorder_plugin` -> `reorderPlugin`
- `set_plugin_param` -> `setPluginParam`
- `bypass_plugin` -> `bypassPlugin`
- `add_automation_point` -> `addAutomationPoint`
- `remove_automation_point` -> `removeAutomationPoint`
- `set_automation_point` -> `setAutomationPoint`
- `clear_automation` -> `clearAutomation`
- `set_transport` -> `setTransport` for stop/seek state and bounded playback smoke; record stays unsupported
- `export_audio` -> `renderExport`
- `save` / `save_as` -> `saveSessionGraph`
- `reload` -> `restoreSessionGraph`
- `get_engine_diagnostics` and `run_engine_contract_slice` remain additive
  backend commands.

The routed Maolan path logs normal MoshOps command records and writes Maolan
backend command/timing/artifact evidence. It never uses Tracktion as a fallback
for supported or unsupported commands while Maolan is selected.
Persistence operations must write both the MOSH graph file and the Maolan
session-folder `session-maolan/main.json`, and their result/diagnostics must expose the
Maolan session artifact path.

Backend-neutral read-only commands that do not touch engine state may remain
local MoshOps commands in Maolan mode. The current allowed local reads are
`list_directory`, `get_command_log`, and `list_colors`; they must not write
MoshOps JSONL lines, emit snapshot invalidations, or write backend
command/timing records. In Maolan mode `list_colors` is a local UI helper and
returns an empty color rack until a real process-backed color service exists.
`get_plugin_blocklist` is different: it is a routed Maolan backend read, so it
does write backend command/timing evidence, but it must not write a MoshOps JSONL
line or emit a snapshot invalidation. `block_plugin` and
`clear_plugin_blocklist` are catalog mutations and are logged as non-undoable
MoshOps commands.
`list_midi_inputs` is a routed synthetic read in this phase and returns a
well-formed empty no-live-MIDI view without touching Tracktion's device manager.
`list_builtins` is also a routed synthetic read in Maolan mode; it returns
`plugins:[]` because Tracktion's compiled-in effects/instruments are not Maolan
backend features. `load_builtin` remains unsupported until MOSH has a real
Maolan-native built-in plugin path.

## Vertical Slice Gate

The first accepted slice is headless:

```sh
MOSH_ENGINE_BACKEND=maolan scripts/maolan-contract-slice-gate.sh
```

The shell gate is intentionally a thin wrapper around the app/backend path:
`Mosh --selftest-engine-contract-slice` calls `run_engine_contract_slice`, which
executes the explicit `MaolanProcessBackend` operations in sequence. Keep that
shape: future gate passes should prove the C++ contract adapter, not a duplicate
shell-only workflow.

Acceptance artifacts are written under:

```text
_preserved_artifacts/<date>-maolan-contract/<timestamp>/
```

Required files:

- `summary.json`
- `command-log.jsonl`
- `timing.csv`
- `render-smoke/maolan-render-smoke.wav`
- `render-smoke/maolan-render-smoke-stats.json`
- `playback-smoke/maolan-play-session-smoke-stats.json`
- `render-smoke/maolan-session/main.json`
- `session-graph.json`
- `restored-session-graph.json`

The gate proves `coreaudio:default`, `JamPilotTestGain.vst3`, one materialized
track, session tempo/time-signature/metronome/project defaults,
plugin parameter/bypass/remove/reorder/automation metadata, clip warp metadata, render WAV output, session graph
restore, bounded playback start/stop proof, timing/error diagnostics, and a link back to the Tracktion comparison
evidence kept by MaolanMosh. When a MOSH wave clip exists, `renderExport`
must write a Maolan session folder and the render stats must include
`session_dir`; plugin-backed renders must use Maolan offline bounce with
`render_source=maolan-offline-bounce`, `plugin_graph_applied=true`, restored
VST3 instance counts, worker readiness, and bounced-track WAV artifacts. The
plain session exporter is allowed for clip-only graphs, and the smoke renderer
is allowed only for empty graphs. The Maolan
session folder must also include a native `graphs` entry for loaded VST3 plugins,
including `JamPilotTestGain.vst3`, so plugin DSP stays behind the MOSH engine
contract rather than leaking into the UI seam.

## Selection And Unsupported-Command Gate

Use this lightweight gate when changing backend selection, diagnostics, snapshot
fields, or the Maolan unsupported-command posture:

```sh
scripts/engine-contract-selection-gate.sh
```

It runs `Mosh --selftest-engine-contract` once with the default Tracktion/JUCE
backend and once with `MOSH_ENGINE_BACKEND=maolan`. It does not run the full
Maolan render slice. The Maolan half verifies the routed non-render subset and
structured unsupported-command posture. It preserves a `summary.json`,
per-backend logs, and
per-backend command logs under:

```text
_preserved_artifacts/<date>-engine-contract-selection/<timestamp>/
```

## MoshOps Routing Gate

Use this gate when changing the Maolan MoshOps command router:

```sh
scripts/maolan-moshops-routing-gate.sh
```

It runs `MOSH_ENGINE_BACKEND=maolan Mosh --selftest-maolan-moshops-routing`
through the existing `execute_command` names and validates plugin scan/load,
plugin catalog blocklist hide/reject/clear behavior,
empty Maolan built-in catalog posture,
`coreaudio:default`, multi-track create/rename/remove graph persistence,
MOSH-owned wave clip add/move/trim/split/duplicate/rename/remove/gain/mute/warp graph
persistence, MIDI clip/note add/set/quantize/remove graph persistence, track
volume/pan/mute/solo/meter posture, master, aux bus, send, and group/submix metadata graph persistence,
MOSH-owned plugin parameter/bypass/remove/reorder/automation metadata persistence,
stop/seek transport state, render/export, save/restore,
bounded playback proof, structured unsupported errors, the MoshOps JSONL, the
backend command JSONL, timing CSV, render WAV, render stats, the Maolan
session-folder `main.json`, native Maolan plugin graph data, and session graph
 artifacts. It also verifies backend-neutral local reads `list_directory`,
`get_command_log`, and `list_colors` in Maolan mode without Tracktion fallback
or read-only log pollution; `get_plugin_blocklist` is a backend read and is likewise excluded
from the MoshOps JSONL while still writing Maolan backend evidence. MIDI
input enumeration is currently a no-live-MIDI synthetic read. MIDI clip/note
support is MOSH-owned graph metadata in this phase;
native Maolan MIDI playback/render is a later slice. Group/submix support
persists the existing `type:"group"`, `isGroup:true`, and member `parentId`
snapshot shape; native Maolan submix summing is also a later slice.
Meter support currently preserves MOSH-owned `meterEnabled` posture in the
session graph and snapshot; native Maolan level samples are a later slice.
Tempo/time-signature map support persists MOSH-owned point and curve metadata;
native Maolan tempo-ramp playback/render behavior is a later slice.
Plugin automation currently preserves MOSH-owned parameter point metadata in the
session graph and snapshot; native Maolan DSP automation playback/render behavior
is a later slice.
Clip warp currently preserves MOSH-owned `autoTempo`, `sourceBpm`,
`stretchMode`, and source-length metadata in the session graph and snapshot;
native Maolan time-stretch playback/render behavior is a later slice.

Evidence is written under:

```text
_preserved_artifacts/<date>-maolan-moshops-routing/<timestamp>/
```

## Persistence Restart Gate

Use this gate when changing Maolan session graph persistence or open/save/reload
mapping:

```sh
scripts/maolan-persistence-restart-gate.sh
```

It launches MOSH twice with `MOSH_ENGINE_BACKEND=maolan`. The write phase creates
a Maolan session, selects `coreaudio:default`, scans and loads
`JamPilotTestGain.vst3`, renders a Maolan session-folder WAV export, and saves a
persisted MOSH-owned session graph with tempo/time-signature maps, track/master/bus/send mixer and meter posture, group membership metadata, edited wave clip
metadata/source/warp evidence, MIDI clip/note metadata, and plugin parameter/bypass/reorder/automation metadata.
The read phase starts a fresh app process, opens that graph, verifies the
backend snapshot still exposes the track, plugin, plugin parameter/bypass/reorder/automation state,
track/master/bus/send mixer values, meter posture, group membership, wave clip/warp values, and MIDI note values without Tracktion mutation,
renders again, saves, and restores the graph.

Evidence is written under:

```text
_preserved_artifacts/<date>-maolan-persistence-restart/<timestamp>/
```

Required files include `summary.json`, `persisted-session-graph.json`, per-phase
MoshOps/backend command logs, timing CSVs, both render WAVs/stats, both playback
stats files, both render-session `render-smoke/maolan-session/main.json` files,
both persistence-session `session-maolan/main.json` files, and the read-phase
`session-graph.json` plus `restored-session-graph.json`. Render stats must include `session_dir`
whenever a MOSH-owned wave clip exists, and the write/read Maolan session JSON
files must carry the native VST3 plugin graph. Plugin-backed write/read renders
must also prove Maolan offline bounce through `render_source`,
`plugin_graph_applied`, worker readiness, restored VST3 instance counts, and
bounced-track WAV artifacts.

## UI Workflow Gate

Build thin MOSH UI slices on the same MoshOps contract, not on backend-specific
calls. The first Maolan UI slice is the `Engine` popover workflow:

- select the Maolan backend by launching with `MOSH_ENGINE_BACKEND=maolan`
- select `coreaudio:default`
- scan VST3 plugins and load `JamPilotTestGain.vst3`
- create one backend track
- create one MOSH-owned test-tone clip
- split the clip through `split_clip`
- run a bounded play/stop transport proof
- render/export through a Maolan session-folder export
- save and restore the MOSH-owned session graph
- show diagnostics and artifact paths

Use this focused gate when changing the Engine panel, snapshot mapping, or UI
command flow:

```sh
scripts/maolan-contract-ui-gate.py
```

It launches the app, drives the existing WebBridge/MoshOps seam through the UI,
captures screenshots, validates MoshOps command records, validates backend
command/timing evidence, and checks the render WAV, render stats, session graph,
playback stats, and restored graph. Evidence is written under:

```text
_preserved_artifacts/<date>-maolan-contract-ui/<timestamp>/
```

In Maolan mode, snapshots for the supported vertical slice are projected from
the backend session graph. Tracktion/JUCE stays available as the reference
backend, but Maolan UI state must not be filled from Tracktion edit tracks as a
fallback.
