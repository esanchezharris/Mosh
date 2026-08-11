# QuickPunch and arbitrary pre/post-roll contract

Status: design contract only. This document does not authorize a shell-only
QuickPunch simulation or a parity claim before the native acceptance matrix is
green.

Research date: 2026-08-11

## Evidence and terminology

- Avid's [QuickPunch documentation](https://apps.avid.com/proToolsFirstHelp/version12.3/enu/Pro%20Tools%20First%20Help/rec2.audio.20.41.html)
  defines an operator-controlled punch during playback. Pro Tools writes one
  continuous source file while exposing clips at the punch boundaries.
- Avid's [Setting Pre- and Post-Roll](https://apps.avid.com/proToolsFirstHelp/version12.3/enu/Pro%20Tools%20First%20Help/rec2.audio.20.45.html)
  and [Transport-window procedure](https://apps.avid.com/proToolsFirstHelp/version12.3/enu/Pro%20Tools%20First%20Help/rec2.audio.20.46.html)
  define separately enabled pre- and post-roll values in the session timebase.
- The official [Fast Start vocal tutorial](https://www.youtube.com/watch?v=lAyDlRVwIwo)
  shows pre-roll starting playback before a specified punch so the performer
  hears context before capture begins (8:15-9:38).
- The official [Pre-Roll Quick Tip](https://www.youtube.com/watch?v=pfkpfIZcffs)
  shows independent value entry and enabled feedback (0:00-0:38).

Mosh's current Punch path is **specified punch**: an existing Timeline range is
sent to the engine before recording starts. It is not QuickPunch. QuickPunch is
the later, instantaneous manual transition into and out of record while the
transport is already rolling.

## Additive project and command contract

The eventual snapshot gains an optional recording-options object. Absence keeps
the current behavior and wire shape.

```ts
type PunchRollOptions = {
  punchMode?: "off" | "specified" | "quick";
  preRoll?: { enabled: boolean; seconds: number };
  postRoll?: { enabled: boolean; seconds: number };
};
```

The native model stores canonical finite seconds. The shell may display and
accept Bars+Beats, Timecode, Minutes:Seconds, or Samples using the session's
current tempo/sample-rate context, but conversion happens before mutation.
Changing the display timebase must not change the stored duration.

New commands are additive and pass through the normal MoshOps validation,
transaction, event, JSONL, result-envelope, replay, and multiplayer seam:

- `set_punch_mode { mode: "off" | "specified" | "quick" }`
- `set_pre_roll { enabled?: boolean, seconds?: number }`
- `set_post_roll { enabled?: boolean, seconds?: number }`
- `quick_punch_in {}` and `quick_punch_out {}`

Roll values must be finite and between 0 and 3,600 seconds. A command can change
enabled state, value, or both atomically; an empty payload is rejected. Recording
preferences are project state and undoable while stopped. Punch transitions are
transport operations and `undoable:false`, matching record/stop rather than
pretending an Undo transaction can reverse captured input.

`quick_punch_in` is accepted only while transport playback is active, QuickPunch
is selected, at least one eligible audio track is armed, and every armed track's
input/monitoring result envelope is applied. `quick_punch_out` is accepted only
while a QuickPunch capture is active. Duplicate or out-of-order transitions fail
without changing transport or clips. Commands lock the armed-track set and are
rejected if that set changes during the transition.

## Native capture semantics

QuickPunch must be implemented below the WebView. Starting playback in QuickPunch
mode opens continuous, recoverable source recording for each eligible armed audio
track. Punch-in and punch-out place arrangement clip boundaries over that same
source; they do not start a second writer, splice unrelated files, or merely
toggle a red shell button.

- Pre-roll starts audible playback `preRoll.seconds` before the requested
  playback/record position, clamped at session start. Capture begins only at the
  specified punch boundary unless QuickPunch is used.
- Post-roll keeps playback running for `postRoll.seconds` after specified capture
  stops. A user Stop always wins immediately.
- QuickPunch preserves the source-relative offsets before and after visible punch
  boundaries so later boundary extension can recover the continuously recorded
  material.
- Dropout, device loss, disk-write failure, project replacement, or process
  recovery must close writers deterministically, return an error envelope, and
  leave either a readable recoverable take or no visible take—never a successful
  zero-byte clip.
- Saved/reloaded projects retain punch mode, roll values, source identity, clip
  offsets, and takes. JSONL contains control commands and stable identifiers, not
  audio samples, device secrets, or private paths beyond existing project policy.

## UI and accessibility contract

The Transport exposes separate Pre and Post value fields plus pressed-state
toggles. QuickPunch and specified Punch are mutually exclusive labelled modes.
All fields support keyboard entry, Enter commit, Escape cancel, clear error text,
and focus restoration. Drafts remain local until one command succeeds and are
discarded on `projectEpoch` replacement.

During specified punch, the Timeline renders pre-roll start, punch-in, punch-out,
and post-roll end. During QuickPunch, the record control and armed headers expose
the pending versus actively capturing distinction without relying on color alone.
Space remains transport start/stop; the eventual QuickPunch shortcut must be
scoped away from editable fields and documented rather than shadowing an existing
global binding.

## Required tests before implementation can be called usable

### Native and model

- Command validation: finite ranges, atomic value/toggle changes, wrong-state
  punch transitions, no armed input, and applied-false monitoring envelopes.
- Undo/redo and save/reload for mode and roll settings.
- Specified pre/post boundary timing at session start and across tempo-map display
  conversions.
- One continuous source identity across QuickPunch playback, in, out, re-punch,
  clip-boundary extension, undo, save/reload, and crash recovery.
- Duplicate/replayed transitions and multiplayer armed-track lock contention.
- Device removal and disk failure never return success or leave a zero-byte take.

### Browser contract

- Keyboard-accessible fields, focus containment where a dialog is used, Escape
  cancellation, result-envelope errors, stale-project cancellation, and compact
  reachability.
- Exact command ordering and state feedback for specified Punch and QuickPunch;
  browser tests make no audible or continuous-file claim.

### Guarded physical-device acceptance

Run serially in an isolated scratch project only. Immediately before every build
or test command run:

```sh
MOSH_MAX_SWAP_USED_MIB=0 scripts/auto-loop/memory-preflight.sh
```

Stop on guard failure, less than 25% free memory, any swap/compressor growth from
the zero baseline, or rising process fan-out. Do not use summed RSS alone.

1. Select one known physical input and output; prove the input-monitor result is
   `ok:true, applied:true` before arming.
2. Record a specified punch with a non-round pre-roll and post-roll value. Verify
   audible cue, capture boundaries, post-roll continuation, and immediate Stop.
3. Start QuickPunch playback, punch in and out twice, and verify no monitor pop,
   stalled UI, missing sample region, or extra source writer.
4. Extend each visible punch boundary and verify recoverable audio exists outside
   it from the same continuous source file.
5. Save, reload, undo/redo, and replay the JSONL into a clean scratch project;
   compare take identity, offsets, settings, and visible boundaries.
6. Repeat at two buffer sizes and after a bounded physical-device disconnect.
   Failure must be surfaced and the recovered file must be readable and nonzero.
7. Inspect exported audio for the expected cue/capture timing and confirm the
   command log contains no secrets.

Any missing continuous-file proof, audible boundary error, zero-byte recovery,
monitoring failure, persistence drift, memory-guard failure, or device-loss hang
blocks the QuickPunch parity claim.
