# Pro Tools Send Automation and Metering Design

**Status:** Approved for implementation on 2026-08-11

**Branch:** `codex/protools-send-automation-meters`

**Base:** `origin/main` at `256f19bf79eae44f193ed4d65f2700b0d7dd6b7b`

## Purpose

Close the highest-value remaining send-mixing gap identified by the Pro Tools
tutorial parity audit. Mosh already supports Aux sends, send level, send mute,
send pan, and true pre/post-fader placement. This slice makes send level, pan,
and mute first-class automation targets and exposes compact stereo meters for
the signal actually delivered to each Aux bus.

This is an additive hardening of the existing Pro Tools Edit and Mix surfaces,
not a redesign. The shipped static send controls remain the direct manipulation
surface. Automation and meters extend that surface without introducing a second
mutation path.

## Authority and Research Boundary

- [Avid Sends documentation](https://apps.avid.com/protoolsfirsthelp/version12.3/enu/Pro%20Tools%20First%20Help/mix1.basic.54.31.html)
  documents pre/post operation, send level meters, and automation of send level,
  mute, and pan.
- [Avid Automation Parameters documentation](https://apps.avid.com/proToolsFirstHelp/version12.0/enu/Pro%20Tools%20First%20Help/mix3.automation.55.03.html)
  lists send level, pan, and mute as independently editable audio-track
  automation parameters.
- The Avid Pro Tools Reference Guides document meters in send assignments,
  individual send views, and send automation. They are used as behavioral and
  information-hierarchy evidence only.
- The local tutorial catalog and audit remain the visual/sequence reference:
  `docs/protools-clone/VIDEO_PARITY.md` and
  `docs/protools-clone/TUTORIAL_PARITY_AUDIT_2026-08-10.md`.

Mosh does not copy Avid artwork, typography, meter graphics, or source media.
No locally installed Pro Tools comparison is available, so the implementation
may claim research-backed behavioral parity and current-Mosh visual QA, not
direct pixel identity or Pro Tools interoperability.

## Goals

1. Make Aux-send Level, Pan, and Mute genuine Tracktion automatable parameters.
2. Address those parameters through Mosh's existing generic automation commands,
   preserving validation, undo, events, JSONL recording, replay, save/reload, and
   multiplayer track locks.
3. Add optional per-send stereo readings to the existing bounded-rate `levels`
   event without changing existing track/master level consumers.
4. Meter the final copied signal delivered to the Aux bus, after send mute, pan,
   and level, and after the pre/post source point has been selected.
5. Let Pro Tools users select `<Bus> · Level`, `<Bus> · Pan`, or `<Bus> · Mute`
   in the existing automation lane and edit it with the existing breakpoint,
   range, Pencil, keyboard, and accessibility behaviors.
6. Show compact, legible stereo send meters in both the Edit inspector and Mix
   Window send rows without causing React to render at meter cadence.

## Non-goals

- Automating the pre/post-fader switch. Avid's documented automatable send
  parameters are Level, Pan, and Mute; pre/post remains a routing switch.
- Multiple simultaneous automation lanes per track.
- Meter history, peak-hold persistence, loudness metering, calibration options,
  or a new meter preferences page.
- Replacing the existing track/master meter event or polling architecture.
- New MoshOps commands for automation. Existing generic automation commands are
  the canonical seam.
- New UI dependencies, animation libraries, or React development tooling.
- Claiming physical-device or audible parity from browser/mock evidence.

## Signal and Data Flow

```text
track source at selected pre/post point
             |
             v
      AuxSend automation
      Mute -> Pan -> Level
             |
             +----> LevelMeasurer ----> Aux bus
                         |
                         v
                bounded 30 Hz levels event
                         |
                         v
              store.sendLevels map
                         |
                imperative RAF bars
```

The meter must wrap the final per-send graph branch, not the source track and not
the Aux return. A muted send therefore reads at the meter floor even while the
source track and other sends remain active. A panned send reports the resulting
left/right balance. Changing pre/post changes the measured source placement
because the graph branch itself moves around the track fader.

## Tracktion Engine Contract

### AuxSendPlugin parameters

Patch the pinned Tracktion source through a new repository patch following the
existing numbered patch series. `AuxSendPlugin` owns:

- existing continuous `Send level` parameter;
- new continuous `Send pan` parameter with normalized display range `-1..1`;
- new discrete, two-state `Send mute` parameter (`Open`, `Muted`);
- one `LevelMeasurer` for the final stereo send branch.

The current-value accessors used by the audio graph must read the automatable
parameter streams, not only `CachedValue` properties. `AuxSendNode` already calls
`updateParameterStreams(editTime)`; level, pan, and mute graph functions must
therefore derive from current parameter values so playback automation is audible
in the same block. Direct `set_send_pan` and `set_send_mute` commands update their
parameters, retaining one state owner.

Existing project values migrate additively: an absent Pan parameter resolves to
the persisted/current send pan, and an absent Mute parameter resolves to the
persisted/current mute state. Old sessions remain loadable.

### Meter placement

Extend the send graph node with a reference to its AuxSendPlugin measurer. Wrap
the final pan/gain/mute branch in Tracktion's `LevelMeasuringNode` immediately
before it reaches the return summing node. A removed send destroys that
measurement source; no detached client may outlive its plugin.

The audio callback performs no allocation, locking, JSON serialization, or UI
work. Existing `LevelMeasurer` atomics and bounded client reads remain the only
cross-thread seam.

## MoshOps and Snapshot Contract

### Snapshot

Extend each existing send object additively:

```ts
type SendAutomationAddress = {
  pluginIndex: number
  levelParamIndex: number
  panParamIndex: number
  muteParamIndex: number
}

type Send = {
  // existing fields unchanged
  automation?: SendAutomationAddress
}
```

`pluginIndex` retains the existing generic automation address space. Parameter
indices point into the already serialized AuxSend `Plugin.params`, so the lane
gets the canonical display value, normalized value, discrete flag, state labels,
and breakpoint list from one source. Absence of `automation` means the loaded
engine/session cannot expose those targets; the static send controls still work.

No existing AuxSend plugin entry is removed or relocated from the snapshot.

### Commands and persistence

Automation edits continue through:

- `set_automation_point`
- `remove_automation_point`
- `write_automation_curve`

with the resolved `{trackId, pluginIndex, paramIndex}`. These commands already
own validation, one Tracktion undo transaction, events, JSONL, replay, recovery,
and multiplayer track locking. The implementation must add no shell-only or
snapshot mutation path.

Static `set_send_level`, `set_send_pan`, and `set_send_mute` commands continue to
set the same underlying parameters. Their result envelopes and snapshot values
must agree with the parameter values after undo and save/reload.

### Meter telemetry

Extend the existing `levels` event payload with an optional list:

```json
{
  "tracks": [],
  "master": { "l": 0, "r": 0 },
  "sends": [
    { "trackId": "track-1", "bus": "A", "l": 0, "r": 0 }
  ]
}
```

- `sends` is optional for backward compatibility.
- Each `(trackId, bus)` pair is unique in one payload.
- `l` and `r` use the same normalized level domain and floor as existing meters.
- Meter telemetry is ephemeral: it is not snapshot state, undoable, persisted,
  replayed, JSONL-recorded, or multiplayer-broadcast as project mutation.
- MoshOps reconciles `LevelMeasurer::Client` instances against the current set of
  sends. Add, remove, undo, reload, and project replacement cannot leave stale
  entries or reuse readings for a different send.
- The existing event cadence remains bounded at 30 Hz; no per-send event stream
  is introduced.

## UI State and Automation Target Selection

Define a shell-local stable target id:

```ts
type ProToolsAutomationTargetId =
  | "volume"
  | `send:${string}:level`
  | `send:${string}:pan`
  | `send:${string}:mute`
```

Each audio track defaults to `volume`. The target selector is visible when the
primary automation view or secondary automation lane is shown. Its ordered list
is Volume followed by each send in bus order:

- `<Bus label> · Level`
- `<Bus label> · Pan`
- `<Bus label> · Mute`

Resolution is snapshot-driven. A target is enabled only when its send and
automation address exist and the referenced serialized parameter is present. If
a send disappears, its parameter cannot resolve, or `projectEpoch` changes, the
track falls back to Volume. The internal legacy `trackView === "volume"` value
remains compatible; when active, the visible lane label reflects the selected
target rather than falsely saying Volume.

The resolved parameter object is passed to the existing
`ProToolsAutomationLane`. Continuous send Level/Pan retain curve interpolation;
discrete Mute uses stepped state values and the lane's existing discrete
accessibility language. Pointer cancellation, Escape, command rejection, and
project replacement retain the existing no-commit guarantees.

One selected target may drive the existing primary or secondary lane for a track.
Multiple independently stacked target lanes remain a named follow-up.

## UI Meter Contract

Add a shared compact send-meter primitive using the existing meter geometry and
ballistics. It reads `store.sendLevels` by `(trackId, bus)` and updates SVG/CSS
bar geometry and meter ARIA values imperatively on `requestAnimationFrame`.
Incoming 30 Hz readings must not set component-local React state or cause the
Pro Tools track/sends tree to render at 30 Hz.

Placement:

- Edit inspector: a two-channel vertical or compact horizontal meter in each
  expanded send row, adjacent to level/pan/mute.
- Mix Window: a compact stereo meter in each visible A-E send row without
  changing the channel strip's semantic order or forcing horizontal overflow.

At absent/stale data, the meter displays the floor. Mute automation and static
mute converge on the same floor behavior. Meter color uses existing Pro Tools
tokens; no Avid meter graphic is copied.

### Accessibility

- The meter exposes `role="meter"`, an accessible name containing track and bus,
  and bounded `aria-valuemin`, `aria-valuemax`, and current value.
- It is not focusable and not `aria-live`; screen readers must not announce 30 Hz
  updates.
- Stereo channel identity is available in the accessible description or value
  text.
- Automation target selection uses a native labelled select.
- Mute target states use human labels rather than raw normalized numbers.
- Compact 720x720 reduced-motion layout must keep the selector and send controls
  keyboard reachable.

## Mock and Browser Contract

The hermetic mock must expose the same additive snapshot addresses, parameter
metadata, commands, undo behavior, and optional send-level payload as native.
Synthetic readings may be deterministic and input-independent; they prove
consumer wiring and meter motion only, not audio correctness.

Chromium coverage must prove:

1. selecting Level/Pan/Mute changes the active lane label and parameter semantics;
2. breakpoint edits issue the generic automation command with the resolved send
   plugin and parameter indices;
3. Edit and Mix rows respond to the same `(trackId, bus)` meter reading;
4. removing a send removes its target and falls back safely;
5. compact keyboard reachability and reduced-motion behavior;
6. Live shell boot and existing track/master meters remain unchanged.

## Failure and Lifecycle Rules

- Rejected automation commands surface through the existing Pro Tools error bar.
- Unsupported/legacy sessions keep static send controls but omit unavailable
  automation targets.
- A stale `projectEpoch` prevents any draft or gesture from committing into a
  replacement project.
- Undo/remove/reload reconcile both snapshot addresses and meter clients before
  the next externally visible state.
- Missing telemetry never invents a nonzero reading.
- Meter-client reconciliation must be bounded and idempotent; it cannot grow one
  client per snapshot/event.

## Test Strategy

Implementation follows focused RED-to-GREEN slices, each with the memory
preflight immediately before its serial test/build command.

### Tracktion and native

- parameter creation, defaults, static setter convergence, and migration;
- pan and mute automation read from current parameter streams;
- final-branch meter sees level changes, mute floor, and left/right pan;
- pre/post routing produces different measured/audible render when the track
  fader differs;
- generic automation command targets send Level/Pan/Mute;
- undo/redo, JSONL/replay, save/reload, send remove/undo, and project replacement;
- multiplayer lock scope remains the source track;
- bounded client reconciliation does not leak or duplicate clients.

Offline render/self-test evidence may prove signal effects without launching a
native GUI or physical audio device. Physical-device/audible acceptance remains
owner-gated and must be reported separately.

### TypeScript and component

- additive event parsing preserves existing `levels` behavior;
- target list/address resolution and fallback;
- discrete Mute versus continuous Pan/Level lane semantics;
- Edit and Mix meter lookup, floor, labels, and non-live-region accessibility;
- project epoch invalidation and send removal fallback;
- no 30 Hz React render loop;
- compact/reduced-motion layout.

### Focused integration

- Pro Tools Chromium automation-and-meter flow;
- narrow Live meter/boot regression;
- typecheck, focused Vitest, focused Catch2/self-test tags, and focused Playwright;
- final `git diff --check`, secret/generated-artifact audit, and current-tree
  source review.

## Performance and Memory Safety

Work remains serial. Immediately before every build, typecheck, test, Playwright,
or self-test command, run:

```sh
MOSH_MAX_SWAP_USED_MIB=0 scripts/auto-loop/memory-preflight.sh
```

Stop on guard failure, less than 25% free memory, any swap/compressor growth from
the zero baseline, or rising process fan-out. Do not launch Mosh, Ableton, Pro
Tools, or another native GUI, and do not create RAM disks. Use single-job native
builds. No new frontend dependency is justified by this slice.

## Acceptance and PR Gate

The feature is ready for a PR when focused native, TypeScript, and Chromium
evidence is green; the patch series is reproducible; the tutorial audit and
design contract name the closed gap and remaining physical-audio limitation; and
the branch contains only authored source/tests/docs.

Merge is authorized only after required hosted checks complete successfully.
Local or browser success must not override a failing required check. A merge
commit proves the Git action, not post-merge physical-device validation.
