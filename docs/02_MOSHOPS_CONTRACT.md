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
| `add_drum_pattern` | `{pattern, trackId?, clipId?, stepsPerBar?, bars?, velocity?, start?, name?}` | ✓ | `{clipId, trackId, noteCount, steps, bars}` | `snapshot_invalidated` |
| `set_clip_warp` | `{clipId, autoTempo, mode?, sourceBpm?, detect?}` | ✓ | `{clipId, autoTempo, stretchMode}` | `snapshot_invalidated` |
| `stretch_clip` | `{clipId, length? \| bars?}` | ✓ | `{clipId, sourceBpm, length}` | `snapshot_invalidated` |
| `detect_clip_bpm` | `{clipId}` | ✗ (read-only) | `{clipId, bpm, confidence}` | — |
| `list_loras` | `{}` | ✗ (read-only) | `{loras: [{name, displayName, trigger, hint, notes, rank, sha12, valid, reason?}], dir}` | — |
| `add_automation_point` | `{trackId, pluginIndex, paramIndex, time, value: 0-1}` | ✓ | `{pointIndex}` | `snapshot_invalidated` |
| `remove_automation_point` | `{trackId, pluginIndex, paramIndex, pointIndex}` | ✓ | — | `snapshot_invalidated` |
| `set_automation_point` | `{trackId, pluginIndex, paramIndex, pointIndex, time?, value?: 0-1}` | ✓ | `{pointIndex}` (may change — remove+re-add) | `snapshot_invalidated` |
| `clear_automation` | `{trackId, pluginIndex, paramIndex}` | ✓ | — | `snapshot_invalidated` |
| `set_track_automation_mode` | `{trackId, mode: read\|touch\|latch\|write}` | ✓ | — | `snapshot_invalidated` (scoped track patch) |
| `write_automation_curve` | `{trackId, pluginIndex, paramIndex, points: [{t,v:0-1,curve?}] \| JSON string, apply?: replace\|merge}` | ✓ | `{pointCount, numPoints}` | `snapshot_invalidated` |

*Audio warp — "easy" Ableton-style (post-Stage-6): `set_clip_warp` toggles auto-tempo on a wave clip (Tracktion `TimeStretcher`/SoundTouch); with `detect:true` (and no explicit `sourceBpm`) it estimates the loop's own BPM offline and locks it to the grid. `stretch_clip` time-stretches a wave clip to a target warped `length` (seconds) OR a `bars` count by deriving `sourceBpm` (`warpedLen = sourceLen × sourceBpm / projectBpm`) and enabling auto-tempo — it powers the ⌘-drag-edge stretch gesture and the Inspector "Fit N bars / ½× / 2×" helpers. `detect_clip_bpm` is a read-only offline estimate (onset-envelope autocorrelation, pure C++ so it runs in `--selftest`) → `{bpm, confidence}`. Per-transient warp MARKERS remain a deferred subsystem.*

*LoRA rack (post-Stage-6, 2026-07-16): stacked taste adapters on the SA3 render layer. The library is the watched folder's sa3 family subdir `$MOSH_LORA_DIR/sa3` (default `~/Library/Mosh/loras/sa3`; drop a `.safetensors` + optional `<stem>.json` sidecar `{displayName, trigger, hint, notes}` in; other subdirs like `ace/` are archival). `set_render_param` gains `loras: [{name, value}]` — **ordered** (chained composition is order-dependent) and **unbounded** (no count cap, no strength clamp; `value` is the 0–100 fader, >100 = deliberate overdrive, 0 = removed). Trigger tokens auto-inject into the prompt server-side (surfaced only in the UI tooltip). The cache fingerprint keys `name=value@sha12:trigger` per row, resolved at RENDER time — a retrained same-name file or a sidecar trigger edit is a MISS. Deliberately NOT in the agent catalog (same posture as `colors`/`list_transform_targets` — the agent styles renders via `compile_render`); `list_loras` is distinct from the training scaffold's `list_lora_adapters`. Merge math + design: [superpowers/specs/2026-07-16-lora-rack-design.md](superpowers/specs/2026-07-16-lora-rack-design.md).*

*Streaming — Live render-ahead (post-Stage-6, 2026-07-16, hybrid): `render_ahead_arm {clipId}` arms a WAVE clip's render layer as "Live"; while it plays, a transport-clock scheduler renders 8s windows from the playhead forward, incrementally stitches them (service `/stitch_windows`, 1ms equal-power crossfade) into a growing file whose already-played prefix is byte-stable, and repoints the clip's source. Any generation-param change while armed re-lays from the current window forward — the old→new seam crossfades right where the knob turned (the shipping default; a bar-quantize option is a named follow-up). `render_ahead_tick {playheadSec, wait}` drives a simulated clock headlessly. A stitch/repoint failure now fails CLOSED (tick errors + disarm; async surfaces a layer error). Live files bypass the render cache by design. Separately, P5 boundary-quantized swap applies to ORDINARY (non-Live) renders: one finishing while the playhead is inside the clip lands at the loop wrap / next bar (30 Hz poll, epoch-guarded, `MOSH_SWAP_QUANTIZE=0` escape hatch); headless and sing land instantly.*

*`add_drum_pattern` (DRM-002, post-Stage-6): lays a whole drum grid in ONE undoable command from per-lane step strings (`x` hit, `X` accent, `.`/`-` rest, `|` cosmetic; short lanes tile when they divide the total steps evenly). `pattern` is an object `{lane: steps}` or a flat `"lane: steps; lane: steps"` string (the flat form is what the agent catalog declares). `clipId` targets an existing MIDI clip and replaces ONLY the lanes named; otherwise a new clip lands on `trackId` (omitted → a new "Drums" drum track). Track policy: instrument-less target → `trackType:"drum"` + kit in the same transaction; instrument present → untouched; wave-audio target → error. Design: [superpowers/specs/2026-07-10-add-drum-pattern-design.md](superpowers/specs/2026-07-10-add-drum-pattern-design.md).*

Stage 2 adds `move_clip` / `trim_clip` / `split_clip`; Stage 3 the plugin commands; Stage 4 the Tier-A neural-insert commands (`add_neural_insert` / `set_neural_param` / `set_neural_lab_mode`) — **removed 2026-06-21** with the synthetic insert (the real-time path is now the gated RAVE insert: `add_rave_insert` / `set_rave_param` / `load_rave_model`, `MOSH_ENABLE_ANIRA`; see [CLAUDE.md](../CLAUDE.md)); Stage 5 the generative commands. Stage 6 adds `export_audio` with `{file?, renderMode?}` where `renderMode` is `"auto" | "fast" | "realtime"`; `"auto"` keeps fast render unless a known realtime-only hosted plugin such as Xfer Serum 2 is enabled, then selects realtime render. Its result includes `{file, bytes, seconds, renderModeRequested, renderMode, renderModeReason, realTimeRender}`. All follow the same envelope.

**G10 (2026-07-17): parameter automation RECORDING (v0).** `add_automation_point` / `remove_automation_point` / `set_automation_point` / `clear_automation` (Wave 7) address a parameter by `(trackId, pluginIndex, paramIndex)`; values cross the seam normalized `0..1`, times in seconds. New this pass: `set_track_automation_mode` arms/disarms a TRACK's record mode — all 4 `AutomationMode` values are validated + stored + round-trip, but **only `write` is behavioral in v0** (`touch`/`latch` are accepted, no-op, Phase 2). While a track is `write`-armed, `set_plugin_param` captures a curve point at the *current transport position* in the SAME transaction as the value change — one `undo` reverts both. This is a deliberate divergence from real-DAW behavior: capture is gated on `automationMode==write` alone, **not** `transport.isPlaying()`, because `--selftest` never opens an audio device (no live `PlaybackContext` to gate on) — see [superpowers/specs/2026-07-17-g10-automation-record.md](superpowers/specs/2026-07-17-g10-automation-record.md) for the full rationale + the deferred native-`AutomationRecordManager` Phase 2. `write_automation_curve` bulk-authors a whole curve in one undoable step (modelled on `add_drum_pattern`): `points` validated (`t` strictly ascending, `v` 0–1, optional bezier `curve` -1–1) BEFORE any mutation; `apply:"replace"` (default) clears the `[minT,maxT]` window the new points span then lays them, `apply:"merge"` only adds. `points` accepts a native array OR a JSON-encoded string (the agent-catalog form, since `ArgType` has no array type — the same duality `add_drum_pattern`'s `pattern` arg uses). Bundled bug fix: `set_plugin_param` previously called `param->setParameter()` directly, which left the live parameter value STALE after `undo` (a G14-class bug — the snapshot's `params[].value` read the wrong value post-undo even though the persisted property had correctly reverted); it now routes through a generalized `SetPluginParamValueAction` (the same replay-via-`setParameterWithoutUndo` pattern G14 established for track vol/pan).

**clip-ops wave (2026-07-17): reverse / auto-crossfade / normalize.** Three more audio-clip-only commands, mirroring `set_clip_gain`/`set_clip_mute`/`set_clip_fade`'s shape exactly (Clip-scoped MP lock, `AudioClipBase`-cast, one `CachedValue`-backed flip, undoable, free persistence — no `src/state` schema change). `set_clip_reverse {clipId, reversed}` → `te::AudioClipBase::setIsReversed`. `set_clip_crossfade {clipId, enabled}` → `te::AudioClipBase::setAutoCrossfade`; **auto-crossfade only has an audible effect when the clip overlaps a neighbor on the same track** (Tracktion auto-computes a triangular fade via `getOverlappingClip`) — Mosh otherwise leaves it off, so overlapping clips still sum at full volume by default (see the `set_clip_fade` comment above). `normalize_clip {clipId, targetDb?: number}` (default `0.0`) is wave-clip-only and **non-destructive**: it reads the source's true peak sample via the same reader path `get_clip_peaks` uses (no re-render, no source-file mutation), then sets the clip's own gain — `newGainDb = targetDb - peakDb`, clamped to the same `[-48, 24]` ceiling as `set_clip_gain` — so the peak lands at the target; a silent clip (peak 0) errors instead of dividing by zero. Snapshot adds `reversed`/`autoCrossfade` (unconditional booleans on wave clips, default `false`, alongside `gainDb`/`fadeInSec`).

**G1 (2026-07-17): export range/section + delay-tail policy.** Four more optional, additive args — absent behaves byte-identically to the pre-G1 call: `range` (`"full" | "loop" | "custom"`, default `"full"`; presence of `start`+`end` alone also implies `"custom"`), `start`/`end` (seconds, required for `range:"custom"`, clamped into `[0, editLength]`), `tail` (`"cut" | "include"`, default `"cut"`), `tailSeconds` (seconds, default `2.0`, clamped to `[0.05, 30]`, used only when `tail:"include"`). `range:"loop"` renders the transport's current loop region (errors if none is set); `tail:"include"` sets Tracktion's `Renderer::Parameters::endAllowance` so a decaying reverb/delay tail rings out past the requested end instead of being cut. Result gains `{range, rangeStart, rangeEnd, tail, endAllowance}`; `seconds` is redefined to the rendered span's length (`rangeEnd - rangeStart`, which equals the full edit length for the default range, so existing `seconds`-blind assertions are unaffected). Pure resolution/validation math lives in `src/moshops/ExportRange.h` (`resolveExportRange`, engine-free, unit-tested by `tests/test_export_range.cpp`). `export_audio` is UI-only (not agent-callable), unchanged by G1.

Hosted plugin snapshots/results include external-plugin diagnostics when Tracktion has the instance: `{manufacturer, file, identifier, numInputs, numOutputs, isNonRealtime}`. `open_plugin_editor` warms the playback context before opening native editors when audio is available and returns `{audioEnabled, playbackContextActiveBefore, playbackContextActive, plugin}`.

**Master-bus plugins (post-Stage-6): host plugins (limiter, bus EQ, …) on the master output.** `load_master_plugin {pluginId, index?}` / `load_master_builtin {type, index?}` / `remove_master_plugin {index}` / `reorder_master_plugin {index, toIndex}` / `bypass_master_plugin {index, bypassed}` / `set_master_plugin_param {index, paramIndex, value: 0-1}` / `open_master_plugin_editor {index}` — the SAME seven-command shape as `load_plugin` / `load_builtin` / `remove_plugin` / `reorder_plugin` / `bypass_plugin` / `set_plugin_param` / `open_plugin_editor`, one level up: they address `eng.edit().getMasterPluginList()` instead of a track's `pluginList`, so there is no `trackId` arg. All undoable except `open_master_plugin_editor` (a native pop-out, same as its per-track counterpart). Snapshot gains `master.plugins` (an array of the same plugin shape as `tracks[].plugins`, via `pluginToVar`). **Internal-plugin invariant:** the master plugin list also carries Mosh's own internal utility plugins (currently only `MasterSpectralTapPlugin`, the Moshi-reactivity tap `ensureMasterSpectralTap()` appends lazily during live playback) — these are never user-visible or user-addressable. `isInternalMasterPlugin()` filters them out of `master.plugins`, and `masterVisibleBoundary()` (the physical index of the first internal plugin, or the list's true size if none exists yet) is the one invariant every master-plugin command clamps inserts/reorders inside — so a tap created later still taps the fully-processed master signal, and a user-facing index never means "some internal plugin." Classified `SessionGlobal` (fail-closed default, same posture as `set_master_volume`/`set_master_pan` — the master bus is the session's one shared resource, not a track) except `open_master_plugin_editor`, which is `Unguarded` like `open_plugin_editor` (a viewer-local pop-out, nothing to sync). MP sync for the six mutating commands rides the same LWW `broadcastStructuralIfActive` replay as `set_master_volume`/`set_master_pan` — a peer without the same VST3 installed will fail to replay `load_master_plugin` locally, the same inherent limitation any VST3-identity-dependent sync has.

*The MP-001 multiplayer commands (`mp_create_session`, `mp_commit_track`, `mp_apply_bootstrap`, etc.) are backend-only — not in this Stage-1 catalog, not in the agent catalog — see [docs/MULTIPLAYER.md](MULTIPLAYER.md) for the collaboration model. One addition of note: **`mp_fetch_missing_stems`** `{wait?}` → `✗` (non-undoable, Unguarded) → `{fetched, failed, stillMissing}` — self-heals a wave clip whose audio is `sourceMissing` by re-deriving the missing hash/ext from its own by-hash source ref (`audio/by-hash/<64-hex>.<ext>`) and retrying the download; `wait:true` runs synchronously (harness/agents), otherwise it's async (mirrors `transcribe_clip`'s dual-mode shape). Fires automatically at the end of `mp_apply_bootstrap` so a late-joiner's audio self-heals without a manual retry. Closes the "one transient upload/download failure strands a clip forever" gap (previously the only recovery was the host re-committing that track).*

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
