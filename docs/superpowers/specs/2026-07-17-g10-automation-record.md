# G10 — parameter automation RECORDING (v0)

**Status:** feasible, native, additive. Size **M**. Builds on the existing Wave-7
automation surface (`add_automation_point` / `remove_automation_point` /
`set_automation_point` / `clear_automation`, `src/moshops/MoshOps.cpp:5589-5659`),
which already lets a caller hand-author automation curves but has no notion of
*recording* one from live parameter changes.

---

## 1. The core decision: synchronous capture, not native triggers

Real DAWs record automation off the **live transport**: a track is armed
`write`/`touch`/`latch`, playback starts, and every parameter tweak during
playback lands a curve point at the playhead. Tracktion Engine ships exactly
this machinery — `te::Edit::getAutomationRecordManager()` /
`AutomationRecordManager::isWritingAutomation()` — and
`AutomatableParameter::setParameterValue` already has a branch that posts to it
when `epc->isPlaying() && arm.isWritingAutomation()` (verified against the
pinned clone,
`modules/tracktion_engine/model/automation/tracktion_AutomatableParameter.cpp:1404-1421`).

**That branch is gated on `ed.getTransport().getCurrentPlaybackContext()` being
non-null and playing.** `MoshEngine` never opens an audio device in
`--selftest` (`src/engine/MoshEngine.cpp:39-42` — headless by design, no CI
audio hardware), so `getCurrentPlaybackContext()` is always `nullptr` there and
the native record-manager path is **structurally unreachable** in the test
harness. Building v0 on top of it would mean automation recording ships with
*zero* deterministic coverage — exactly the class of feature this repo's
"VERIFY before relying" discipline exists to prevent.

**Decision:** v0 captures automation points **synchronously inside
`cmdSetPluginParam`**, gated *only* on the owning track's
`automationMode == write` — deliberately **not** on `transport.isPlaying()`.
Whenever a `set_plugin_param` command lands while the track is armed write, the
same transaction that applies the value also drops a curve point at the
*current transport position* (`eng.edit().getTransport().getPosition()`,
whether or not the transport is actually rolling). This is a deliberate,
documented divergence from real-DAW behavior:

- **Pro:** every code path that can move a plugin parameter (agent commands,
  the UI, `--run-script`, a future controller-surface mapping) becomes a
  recordable automation source for free, and the whole thing is exercised
  headlessly in `--selftest` — no live audio device, no timing race, no flake.
- **Con:** in the *shipped app*, a `write`-armed track will capture a point
  from a stopped-transport parameter tweak (e.g. a producer adjusting a knob
  before hitting play), which a real DAW would not. This is judged acceptable
  for v0 — the alternative (wiring the native `AutomationRecordManager`) is a
  bigger, audio-thread-adjacent change with no headless test story; see
  Phase 2 below.

`te::Track::automationMode` (`tracktion_Track.h:391`) is a
`CachedValue<AutomationMode>` already `referTo()`'d against the real Edit
`UndoManager` (`tracktion_Track.cpp:28`), so a plain `track->automationMode =
mode;` write is undo-correct out of the box — no custom `UndoableAction`
needed for the mode flag itself (contrast with the value-write bug below).

## 2. The bundled bug fix: `cmdSetPluginParam`'s undo was already broken

While wiring the write-mode capture into `cmdSetPluginParam`, tracing the
undo path turned up a pre-existing bug in the **same G14 family** as the
2026-06-27 fader-undo fix (`src/moshops/MoshOps.cpp:80-125`,
`SetFaderValueAction`).

`cmdSetPluginParam` called `param->setParameter(value, sendNotification)`
directly. `AutomatableParameter::setParameter` →
`setParameterValue(value, /*isFollowingCurve=*/false, /*useUndoManager=*/true)`
sets the atomic `currentValue` member **unconditionally** at the top of the
function, then — separately — writes the backing `CachedValue<float>` through
a real `UndoManager` via `attachedValue->setValue(value)`
(`tracktion_AutomatableParameter.cpp:1384-1421`).

When that ValueTree-backed write is undone, `AutomatableParameter`'s own
`valueTreePropertyChanged` handler explicitly does **not** resync
`currentValue` from the reverted property — the engine's own comment says so
verbatim: *"we shouldn't call attachedValue->updateParameterFromValue here as
this will set the base value of the parameter"*
(`tracktion_AutomatableParameter.cpp:1218-1235`). `getCurrentValue()` /
`getCurrentNormalisedValue()` (which is exactly what the snapshot's
`params[].value` field reads, `MoshOps.cpp:9731`) read that atomic — so after
`undo`, the snapshot kept reporting the **post-set** value even though the
persisted ValueTree property had correctly reverted. Same failure shape as
G14's fader bug, same fix: generalize `SetFaderValueAction`'s pattern into
`SetPluginParamValueAction` (any `te::AutomatableParameter`, not just
vol/pan), replaying via `setParameterWithoutUndo` on both `perform()` and
`undo()` so the atomic mirror and the persisted property stay in lockstep in
both directions, with the *custom* `UndoableAction` — not JUCE's built-in
property-undo — owning the transaction. `cmdSetPluginParam` now does
`undoManager().perform (new SetPluginParamValueAction (*param, raw))` instead
of calling `setParameter` directly. This is commit-isolated from the G10
feature work (it stands alone and is regression-tested independently).

## 3. v0 scope — what's write-behavioral vs merely stored

- **`set_track_automation_mode {trackId, mode}`** — new command. All four
  `AutomationMode` values (`read` / `touch` / `latch` / `write`) are validated,
  stored on the real `te::Track::automationMode` CachedValue, and surfaced on
  the track's snapshot entry. **Only `write` has behavior in v0.** `touch` and
  `latch` are accepted and round-trip losslessly, but do not arm any capture —
  a `--selftest` check pins this explicitly (`AUTO-MODE-INERT`) so a future
  patch can't silently claim `touch`/`latch` support without a real
  gesture-boundary implementation (Phase 2).
- **`cmdSetPluginParam` augmentation** — when the owning track is `write`
  armed, the same transaction that sets the value also
  `curve.addPoint(transport.getPosition(), value, 0.0f, &undoManager())`s a
  point. One `undo()` reverts both (they share one `beginTxn`).
- **`write_automation_curve {trackId, pluginIndex, paramIndex, points, apply}`**
  — new composite bulk-authoring command (modelled on `add_drum_pattern`,
  DRM-002): lay a whole automation curve in one undoable step instead of N
  `add_automation_point` calls. `points` is `[{t, v, curve?}]`, `t` **strictly
  ascending**, `v` in `0..1`, optional `curve` in `-1..1` (bezier amount,
  matching `AutomationCurve::AutomationPoint`'s own assert range). Validated
  **before** any mutation (atomic-safe — a rejected call touches nothing).
  `apply:"replace"` (default) clears the exact `[minT, maxT]` window the new
  points span (`AutomationCurve::removePointsInRegion`, padded by a
  sub-millisecond epsilon past the last point so a pre-existing point exactly
  at the new curve's end isn't left as a stray duplicate) then lays the new
  points; `apply:"merge"` only adds — it does **not** deduplicate points that
  land on an existing point's exact time (documented limitation, see Open
  questions). Points cross the seam normalized `0..1` like every other
  automation command; the point-array validator lives in a pure,
  `tracktion`-free header (`src/moshops/AutomationCurveWrite.h`) so it's
  Catch2-testable without linking the engine, mirroring the
  `src/moshops/DrumPattern.h` precedent. Because `ArgType` (the agent catalog)
  has no array/object type, the agent-catalog form accepts `points` as either
  a native array (UI/tests) or a JSON-encoded string (the LLM-callable form) —
  same "flat string OR object" duality `add_drum_pattern`'s `pattern` arg
  already established.
- **Track-scoped MP lock:** both new commands join the existing `track`-scoped
  automation group in `multiplayer/LockManager.cpp` (alongside
  `add_automation_point` et al.) — a peer holding a track's lock blocks a
  collaborator from arming write mode or bulk-writing that track's curves.
- **Promoted (not new):** the four pre-existing Wave-7 commands
  (`add_automation_point` / `remove_automation_point` / `set_automation_point`
  / `clear_automation`) were fully implemented and `--selftest`-covered but
  absent from the agent catalog (`ui/src/agent/commands.ts`) and from
  `docs/02_MOSHOPS_CONTRACT.md`. Both gaps are backfilled — pure wiring/docs,
  zero engine risk. Doing so required a small mechanical refactor: `findParam`
  took the whole `args` var and read `trackId`/`pluginIndex`/`paramIndex`
  *inside itself*, which is invisible to `commands.contract.test.ts`'s
  handler-body regex scan (it slices each `cmdXxx` handler's own source span
  and looks for `args.getProperty("key"` literally inside it). `findParam` is
  now `findParam(trackId, pluginIndex, paramIndex)` and every caller reads
  those three keys inline first — the same calling convention `findPlugin`
  already uses everywhere else in `MoshOps.cpp` (e.g. `cmdBypassPlugin`,
  `cmdSetPluginParam`). Behavior is unchanged (same argument names, same `-1`/
  empty-string defaults); this just makes the existing contract test able to
  see what the handlers actually read.

## 4. Deferred — Phase 2 (native trigger fidelity)

Not built now, explicitly parked:

- **Real `touch`/`latch` semantics** — `touch` should punch in on the first
  gesture and punch out when the gesture ends (mouse/controller release);
  `latch` should punch in on first gesture and punch out only on transport
  stop. Both need a notion of "gesture start/end" that v0's one-shot
  `set_plugin_param` command doesn't carry (it's a single discrete value
  change, not a drag gesture with distinguishable begin/move/end phases). A
  real implementation likely needs either (a) a new
  `begin_plugin_param_gesture` / `end_plugin_param_gesture` command pair the
  UI's drag handlers call, or (b) wiring the native
  `AutomationRecordManager` end-to-end, which requires a live
  `PlaybackContext` and is therefore only testable with a real audio device —
  a `--live-audio-smoke`-class gate, not `--selftest`.
- **Native `AutomationRecordManager` / real `PlaybackContext`-gated capture**
  — the "correct" DAW behavior (capture only while actually playing) instead
  of v0's always-armed-while-write synchronous capture. Swapping to this
  later is compatible with v0's command surface (`set_track_automation_mode`,
  `write_automation_curve` don't change); only `cmdSetPluginParam`'s capture
  *condition* would gain a `transport.isPlaying()` check, gated behind
  whatever real-audio-device test harness proves it (mirrors how the Route-C
  RAVE insert's real-time path was proven with `--live-audio-smoke` /
  `verify.py`, not `--selftest`).
- **Punch boundaries / gesture-scoped undo grouping** — a real recording pass
  ordinarily groups the *whole* punch-in..punch-out span as one undo step, not
  one step per discrete value change. v0's per-`set_plugin_param` transaction
  granularity is coarser-grained than that but simpler and matches how every
  other MoshOps command already scopes its undo step.

## 5. Open questions for the owner

1. **The transport-gate divergence (§1)** — is "capture regardless of
   play/stop, gated only on write-armed" an acceptable v0 behavior for the
   shipped app, or should `cmdSetPluginParam`'s capture *also* require
   `transport.isPlaying()`even though that makes the write-mode capture path
   untestable in `--selftest` (headless has no playback context, so the check
   would need `--run-script`/manual QA only)? Current implementation takes the
   headless-testable path.
2. **`touch`/`latch` being accepted-but-inert** — should `set_track_automation_mode`
   reject `touch`/`latch` outright until Phase 2 ships (forcing callers to only
   ever request `read`/`write`), or is "store it, no-op it, tell you so in this
   doc" the right posture? Current implementation stores+no-ops (round-trips
   losslessly across save/reload) rather than rejects, on the theory that a
   future Phase 2 patch shouldn't need a migration to *unlock* a value that
   was already accepted.
3. **`write_automation_curve`'s `merge` mode and duplicate timestamps** — `merge`
   doesn't dedupe points landing on an existing point's exact time (two points
   end up adjacent in the curve). Worth fixing before shipping to end users
   (e.g. treat an exact-time match as an implicit single-point replace), or
   fine as a documented v0 limitation since `replace` (the default) doesn't
   have this problem?
4. **Track-wide arm only, no per-parameter arm** — `automationMode` is a single
   flag on the *track*, so arming write captures **every** automatable
   parameter change on that track (any plugin, any param), not just one the
   producer is currently focused on. This matches Ableton/Logic/Pro Tools'
   track-wide arm model, but is worth confirming against the actual v0 UI
   flow once the mode selector ships (§7 of the build plan).
