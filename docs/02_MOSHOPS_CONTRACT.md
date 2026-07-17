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
| `list_loras` | `{}` | ✗ (read-only) | `{loras: [{name, displayName, trigger, hint, notes, rank, sha12, valid, reason?}], dir}` | — |

*LoRA rack (post-Stage-6, 2026-07-16): stacked taste adapters on the SA3 render layer. The library is the watched folder's sa3 family subdir `$MOSH_LORA_DIR/sa3` (default `~/Library/Mosh/loras/sa3`; drop a `.safetensors` + optional `<stem>.json` sidecar `{displayName, trigger, hint, notes}` in; other subdirs like `ace/` are archival). `set_render_param` gains `loras: [{name, value}]` — **ordered** (chained composition is order-dependent) and **unbounded** (no count cap, no strength clamp; `value` is the 0–100 fader, >100 = deliberate overdrive, 0 = removed). Trigger tokens auto-inject into the prompt server-side (surfaced only in the UI tooltip). The cache fingerprint keys `name=value@sha12:trigger` per row, resolved at RENDER time — a retrained same-name file or a sidecar trigger edit is a MISS. Deliberately NOT in the agent catalog (same posture as `colors`/`list_transform_targets` — the agent styles renders via `compile_render`); `list_loras` is distinct from the training scaffold's `list_lora_adapters`. Merge math + design: [superpowers/specs/2026-07-16-lora-rack-design.md](superpowers/specs/2026-07-16-lora-rack-design.md).*

*Streaming — Live render-ahead (post-Stage-6, 2026-07-16, hybrid): `render_ahead_arm {clipId}` arms a WAVE clip's render layer as "Live"; while it plays, a transport-clock scheduler renders 8s windows from the playhead forward, incrementally stitches them (service `/stitch_windows`, 1ms equal-power crossfade) into a growing file whose already-played prefix is byte-stable, and repoints the clip's source. Any generation-param change while armed re-lays from the current window forward — the old→new seam crossfades right where the knob turned (the shipping default; a bar-quantize option is a named follow-up). `render_ahead_tick {playheadSec, wait}` drives a simulated clock headlessly. A stitch/repoint failure now fails CLOSED (tick errors + disarm; async surfaces a layer error). Live files bypass the render cache by design. Separately, P5 boundary-quantized swap applies to ORDINARY (non-Live) renders: one finishing while the playhead is inside the clip lands at the loop wrap / next bar (30 Hz poll, epoch-guarded, `MOSH_SWAP_QUANTIZE=0` escape hatch); headless and sing land instantly.*

*`add_drum_pattern` (DRM-002, post-Stage-6): lays a whole drum grid in ONE undoable command from per-lane step strings (`x` hit, `X` accent, `.`/`-` rest, `|` cosmetic; short lanes tile when they divide the total steps evenly). `pattern` is an object `{lane: steps}` or a flat `"lane: steps; lane: steps"` string (the flat form is what the agent catalog declares). `clipId` targets an existing MIDI clip and replaces ONLY the lanes named; otherwise a new clip lands on `trackId` (omitted → a new "Drums" drum track). Track policy: instrument-less target → `trackType:"drum"` + kit in the same transaction; instrument present → untouched; wave-audio target → error. Design: [superpowers/specs/2026-07-10-add-drum-pattern-design.md](superpowers/specs/2026-07-10-add-drum-pattern-design.md).*

Stage 2 adds `move_clip` / `trim_clip` / `split_clip`; Stage 3 the plugin commands; Stage 4 the Tier-A neural-insert commands (`add_neural_insert` / `set_neural_param` / `set_neural_lab_mode`) — **removed 2026-06-21** with the synthetic insert (the real-time path is now the gated RAVE insert: `add_rave_insert` / `set_rave_param` / `load_rave_model`, `MOSH_ENABLE_ANIRA`; see [CLAUDE.md](../CLAUDE.md)); Stage 5 the generative commands. Stage 6 adds `export_audio` with `{file?, renderMode?}` where `renderMode` is `"auto" | "fast" | "realtime"`; `"auto"` keeps fast render unless a known realtime-only hosted plugin such as Xfer Serum 2 is enabled, then selects realtime render. Its result includes `{file, bytes, seconds, renderModeRequested, renderMode, renderModeReason, realTimeRender}`. All follow the same envelope.

Hosted plugin snapshots/results include external-plugin diagnostics when Tracktion has the instance: `{manufacturer, file, identifier, numInputs, numOutputs, isNonRealtime}`. `open_plugin_editor` warms the playback context before opening native editors when audio is available and returns `{audioEnabled, playbackContextActiveBefore, playbackContextActive, plugin}`.

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
