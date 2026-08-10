# Spot Sync Point contract

Status: design approved; native, mock, and UI implementation deferred from the 2026-08-09 session-critical path.

This document defines the additive MoshOps contract needed to add Pro Tools-style Sync Point placement without changing the existing Start-only Spot dialog. It is a design contract, not evidence that the command ships today.

## 1. Snapshot contract

`Clip` gains one optional field:

```ts
syncPointOffsetSec?: number
```

- The field is emitted only for a wave clip with a persisted sync marker.
- It is a finite signed number in timeline seconds measured from the current clip start to the referenced source event.
- `0` means the marker is at the current clip start; `clip.length` means it is at the visible end.
- A negative value or a value greater than `clip.length` means a head/tail edit moved the marker outside the visible clip. The marker remains persisted, but is ineligible for Spot placement.
- Absence means no marker. Existing snapshots and consumers remain valid without the field.

The native clip state stores the marker in original-source coordinates, proposed as `moshSyncPointSourceSec`. The snapshot must derive the signed timeline offset through the same source-to-timeline mapping the engine uses for playback. It must not persist `syncPointOffsetSec` directly: a head trim changes the visible start, not the referenced audio event.

The implementation must provide one exact mapping helper for normal, speed-adjusted, looped, warped, and reversed wave clips before enabling the command for those states. If a state cannot be mapped exactly, setting a marker in that state fails with a clear error; it must never store an approximate source position.

## 2. Command contract

```json
{
  "command": "set_clip_sync_point",
  "args": {
    "clipId": "clip-id",
    "offsetSec": 0.375
  }
}
```

`offsetSec` is `number | null`:

- A number sets the marker. It must be finite and inside the current visible wave clip: `0 <= offsetSec <= clip.length`. Values outside that closed interval fail before any transaction or mutation. A tiny engine epsilon may canonicalize a boundary value to exactly `0` or `clip.length`; it must not clamp a materially invalid value.
- `null` clears the persisted marker. Clearing an already-clear marker is a successful no-op and must not add an undo step.
- MIDI, drum, hidden render, missing, or otherwise non-wave targets fail before mutation.

Successful set/clear returns the engine truth:

```json
{
  "ok": true,
  "command": "set_clip_sync_point",
  "data": {
    "clipId": "clip-id",
    "syncPointOffsetSec": 0.375
  }
}
```

The result uses `syncPointOffsetSec: null` after a clear. A set is one undoable Tracktion transaction, emits one snapshot invalidation, records one JSONL command line, and participates in normal replay.

## 3. Edit and persistence semantics

- Move: preserves the source marker and therefore preserves its local offset.
- Head trim: preserves the source marker; the exposed signed offset changes relative to the new clip start. A trim past the marker makes it negative rather than deleting it.
- Tail trim: preserves the source marker. A trim before the marker makes it greater than `clip.length` rather than deleting it.
- Duplicate: copies the source marker. The duplicate exposes the corresponding local offset for its own source mapping.
- Split: both derived clips inherit the source marker; normally one is eligible and the other exposes an out-of-bounds signed offset. This preserves provenance without guessing which derivative the producer intends to Spot later.
- Warp, stretch, reverse, loop, and relink: preserve the source marker and recompute the exposed offset through the exact mapping helper.
- Save/reload and autosave recovery: preserve the source-relative state property byte-for-byte through the normal clip ValueTree serialization.
- Undo/redo: restores both marker value and absence. The snapshot and command result must reflect the restored engine value, not a UI cache.

## 4. Multiplayer and command policy

`set_clip_sync_point` is classified as `LockManager::Scope::Clip`. The existing clip resolver maps `clipId` to the owning track's stable `logicalId`, so a peer holding that track lock blocks the command before mutation. The property rides the normal serialized track blob and commit fencing; no parallel sync channel is introduced.

The command is initially UI-only and is not added to the agent command catalog. It still uses the one MoshOps path and the existing JSONL/session-command capture seam. A future agent exposure requires its own command-catalog and destructive-screen review.

## 5. Future Spot placement targets

The Spot dialog will eventually offer Start, Sync Point, and End. Let `requestedTimelineTime` be the parsed ruler value from the dialog:

| Target | New clip start |
|---|---|
| Start | `requestedTimelineTime` |
| Sync Point | `requestedTimelineTime - syncPointOffsetSec` |
| End | `requestedTimelineTime - clip.length` |

Sync Point is enabled only when the marker exists and `0 <= syncPointOffsetSec <= clip.length`. Start and End remain available without a marker. Every target rejects a negative computed start before `move_clip`; no target silently clamps to zero. Confirmation reads the current snapshot and remains protected by `projectEpoch`, matching the existing Start-only Spot dialog.

## 6. Required implementation tests

No implementation is complete until all rows are present and green:

| Layer | Required proof |
|---|---|
| Native command | Set at start/middle/end; clear; finite/range validation; non-wave rejection; no mutation or undo entry on failure/no-op. |
| Native undo/redo | Set, replace, clear, undo, and redo restore exact marker presence/source value and snapshot offset. |
| Native edit behavior | Move, head trim across marker, tail trim across marker, split, duplicate, loop, stretch/warp, reverse, and relink preserve the referenced source event and recompute eligibility. |
| Native persistence | Save/reload, autosave recovery, and project replay preserve the source marker and signed snapshot offset. |
| Mock bridge | Mirrors validation, set/clear, snapshot shape, undo/redo, trim, duplicate, and replay semantics; invalid input leaves the mock snapshot unchanged. |
| Multiplayer | Lock-scope golden is `Clip`; remote lock denial is side-effect free; serialized track commit carries the property; stale commit fencing cannot overwrite a newer marker. |
| UI unit | Marker command commits only through `store.exec`; invalid/stale-project input is rejected; target formulas and out-of-bounds eligibility are pure-tested. |
| Pro Tools Chromium | Set marker, trim it out/in, choose Sync Point target, reject a negative placement, place successfully, save/reload, and verify the marker/clip position. |

## 7. Rollout boundary

Tonight's product remains the existing Start-only Spot dialog. Implement this contract later as one additive native/mock/UI lane, with focused RED-to-GREEN evidence and an atomic commit. Do not partially expose a Sync Point target before source mapping, persistence, undo, and multiplayer tests are all green.
