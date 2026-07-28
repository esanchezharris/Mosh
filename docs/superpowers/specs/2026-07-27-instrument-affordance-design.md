# Instrument affordance for the v2 shell — design

**Date:** 2026-07-27
**Status:** approved, ready for planning
**Scope:** frontend only (`ui/src/`). No C++, no native rebuild.

---

## Problem

A producer who adds an instrument track in the v2 shell cannot tell how to put a synth on
it. Three separate things cause that, and they compound:

1. **The rack is flat.** There is no instrument slot — a synth is just another card in the
   same list as effects, distinguished only by a small `inst` badge
   (`ui/src/ui/Dock.tsx:68`). The tab that holds it is labelled **FX**
   (`ui/src/v2/inspector/Inspector.tsx:45`), so the UI tells the user their synth is an
   effect.
2. **The obvious gesture is dead.** Double-clicking empty lane space does nothing:
   `.v2-lane` has no pointer handler at all (`ui/src/v2/lanes/TrackLaneList.tsx:196`).
   Double-click only works *on an existing clip*, to open the piano roll
   (`ui/src/v2/lanes/ClipView.tsx:188`).
3. **The instrument arrives without being chosen.** `Add track → Instrument` runs
   `create_track` then `add_midi_clip` (`ui/src/v2/lanes/TrackLaneList.tsx:252-254`), and
   `add_midi_clip` auto-loads 4OSC. The user never picked it and has no visible prompt
   suggesting they could.

There is also no way to add a **second** MIDI clip to an existing track by mouse in v2.

Two adjacent facts that make it worse: instrument and audio tracks render an identical
header icon (`TrackTypeIcon`, `ui/src/v2/lanes/TrackLaneList.tsx:459`, branches only on
`track.type`), and there is no native `midi` track *type* — an instrument track is
`type: "audio"` carrying a synth, flagged by `isInstrument` (`ui/src/types.ts:359`).

## Non-goals

- **Marquee / range-select on empty lane space.** v2 never wired the `empty` region's
  `drag` rules; that is real debt but separate, and leaving `empty × drag` unbound is
  precisely what makes this change safe to add today.
- **Removing the DRM-001 default-instrument policy.** See "Constraint" below.
- **Click-to-swap the instrument name in the track header.** The header is already tight
  on width and it would compete with the rename gesture.
- **Any change to the classic shell's behaviour.**

## Constraint: DRM-001 stays

`MoshOps::cmdAddMidiClip` auto-loads a default instrument (drum track → sampler+kit, else
4OSC) in the same transaction (`src/moshops/MoshOps.cpp:6648-6662`). It skips when the
track already carries wave clips, and no-ops when an instrument is present.

This is deliberate: a MIDI clip on an instrument-less track is **silent**. Removing it
would resurrect that bug for every caller — the agent, drum patterns, `--selftest`.

The surprise the user actually hit is not DRM-001; it is the UI calling `add_midi_clip`
*immediately on track creation*. Dropping that one call makes the track land bare, and the
new instrument slot prompts a real choice. DRM-001 is untouched, and never fires on the UI
path because by the time a clip is added an instrument already exists.

## Behaviour

`add_midi_clip` already accepts `start` and `length` (`src/moshops/MoshOps.cpp:6664-6665`),
so clip placement needs no native change.

| Context | Gesture | Result |
|---|---|---|
| Lane, track has an instrument | double-click | `add_midi_clip` at the snapped bar, one bar long |
| Lane, bare track | double-click | Lane menu: **Add instrument…** / **Import audio…** |
| Lane, any track | right-click | Lane menu + **Add MIDI clip** |

**Add MIDI clip is always enabled**, including on a bare track. It will trip DRM-001 and
auto-load 4OSC, which is correct there: it is an explicit request, and the documented
alternative is a silent clip.

The instrument item is labelled by track state: **Add instrument…** when the track is
bare, **Swap instrument…** when it already hosts one. Both open the same picker.

`isInstrument` is safe to branch on: the snapshot computes it as `trackHasInstrument(t)`
(`src/moshops/MoshOps.cpp:11226`), so it is derived per-snapshot and true iff the track
genuinely hosts a synth — it cannot go stale.

Both menu destinations are the existing left drawer — **Add instrument…** opens the
plugins tab pre-filtered to the `inst` collection, **Import audio…** opens the sounds tab,
whose `SampleBrowser` already runs `import_clip` against the selected track
(`ui/src/ui/SampleBrowser.tsx:68`).

## Design

### 1 · Gesture routing (table-driven)

Add `EditorAction.LANE_NEW = "lane_new"` to `ui/src/interaction/actions.ts`. The string
value is persisted in templates/localStorage, so it is permanent once shipped.

Two rules, **added to the `MOSH` table only** (`ui/src/interaction/gestureTables.ts:39`):

```ts
{ region: "empty", gesture: "dblclick",    action: A.LANE_NEW }
{ region: "empty", gesture: "contextmenu", action: A.CONTEXT_MENU }
```

Both are **inert for the classic shell**: `Arrange.tsx` resolves only `empty × drag`
(`ui/src/ui/Arrange.tsx:191`) and never empty dblclick/contextmenu. Classic behaviour is
therefore unchanged even for a user on the `mosh` table. Existing `empty` rules keep
resolving as they do now — different gesture, so specificity never competes
(`ui/src/interaction/gestures.ts:69`).

The other four tables (ableton/fl/protools/logic) are untouched: v2 pins to `mosh`
(`ui/src/v2/lanes/ClipView.tsx:8`).

`.v2-lane` (`ui/src/v2/lanes/TrackLaneList.tsx:196`) gains `onDoubleClick` and
`onContextMenu`:

1. Guard `e.target === e.currentTarget`, so a hit on a child `ClipView` never counts as
   empty.
2. **Select the track.** Load-bearing: `usePluginPicker.load` writes to `selectedTrackId`
   (`ui/src/v2/PluginBrowser.tsx:64`), so without this, double-clicking lane 7 would load
   the synth onto whichever lane was previously selected.
3. Resolve via `resolveGesture(TABLE(), { region: "empty", gesture, mods, tool })` and
   dispatch.

Native `onDoubleClick` is correct here. `ClipView` needs its manual `isDoubleClick` timer
only because it also owns drag; the lane owns no drag.

### 2 · `resolveLaneNew(track)`

A pure function, so the branch is unit-testable with no DOM:

- `track.isInstrument` → `add_midi_clip { trackId, start, length }`.
  `start` comes from `snappedSecAt(map, pxPerSec, clientX, rectLeft)`
  (`ui/src/v2/timeline/BarRuler.tsx:36`) — already exported and already correct under a
  variable tempo map. `length` = one bar.
- otherwise → open the lane menu at the pointer.

### 3 · Picker pre-filtering

`buildCollections` already emits an `inst` collection id
(`ui/src/v2/pluginPicker.ts:41`), but the selected collection lives in `useState` inside
`usePluginPicker` (`ui/src/v2/PluginBrowser.tsx:42`) and cannot be set from outside.

`openBrowserTab` (`ui/src/v2/shellState.ts:47,77`) gains an optional second argument. The
shell store carries a **one-shot** `pendingCollection` that `PluginDock` consumes and
clears on mount — one-shot so it does not fight the user's own chip clicks afterwards.

### 4 · Inspector instrument slot

A new `InstrumentSlot` renders above `<Rack>` in the FX tab
(`ui/src/v2/inspector/Inspector.tsx:66`), reading
`track.plugins.find(p => p.isInstrument)`.

- **Empty** — "No instrument — click to choose", opening the picker on `inst`.
- **Filled** — name, **Edit** (`open_plugin_editor`), **Swap** (picker on `inst`),
  **Remove** (`remove_plugin`).

`Rack` (`ui/src/ui/Dock.tsx:30`) gains a `hideInstrument` prop so the synth does not render
twice. Classic passes nothing and is untouched.

The **FX tab keeps its label.** The slot sitting visibly above the effects list carries the
distinction on its own, and renaming the tab would churn tests and docs that assert it.

### 5 · Header icon

`TrackTypeIcon` (`ui/src/v2/lanes/TrackLaneList.tsx:459`) checks `track.isInstrument`
before the `type` switch and renders a new `IconKeys`. `ui/src/ui/icons.tsx` has 36 icons
and no keyboard glyph, so `IconKeys` is added in the existing 16px stroke style.

`TrackTypeIcon` currently takes only `type: string`; its signature widens to take the
track (or an added `isInstrument` prop).

### 6 · Bare instrument tracks

`addTrackOfKind("midi")` drops its `add_midi_clip` call
(`ui/src/v2/lanes/TrackLaneList.tsx:254`). The track lands bare and the instrument slot
asks for a real choice.

The comment block above it (`:244-251`) explains the auto-load rationale and **must be
rewritten, not left behind** — a stale written reason reads as fact and is a documented
recurring trap in this repo.

## Risks

**`add_midi_clip` reachability.** `TrackLaneList.tsx:254` is its only v2 call site.
Deleting it without a replacement pushes `UI_REACH_GAPS` above zero and reds the build.
The lane menu's **Add MIDI clip** restores it — but `uiReachability.test.ts` probes by
**string search over the module graph from `AppV2.tsx`**, so the new call site must live in
a module v2 actually *renders*, not merely imports. A module imported only for helpers must
be declared in `CLASSIC_ONLY_MODULES` or it makes its whole subtree look reachable.

**`LANE_NEW` is a permanent string.** Persisted in templates/localStorage; renaming it
later breaks saved configs.

**Right-click on the lane** may collide with a platform/browser context menu; the handler
must `preventDefault()`.

## Testing

RED-prove every guard before landing — vacuous tests are this repo's documented recurring
failure mode, and a guard that *suppresses* something needs a fixture that genuinely
carries the thing. `grep SABOTAGE` before landing.

- `ui/src/interaction/gestures.test.ts` — the new rules resolve; `empty × drag` still
  `MARQUEE`; `empty × click` still `DESELECT`.
- `ui/src/interaction/gestureTables.test.ts` — update shape/count assertions if present.
- New `resolveLaneNew` unit tests: instrument → `add_midi_clip` at the snapped bar; bare →
  menu. Sabotage each branch to prove it can fail.
- `ui/src/agent/uiReachability.test.ts` — stays at **exactly 0** gaps with `add_midi_clip`
  reachable through the new menu.
- Inspector tests: slot empty and filled; instrument absent from the rack list when the
  slot displays it.
- Classic-shell regression: `Arrange.tsx` empty-space behaviour unchanged.
- e2e on the isolated config (`ui/playwright.isolated.config.ts`, port 5191) — never
  `:5173`, which another session's dev server may own.

Because the change is entirely frontend, **`--selftest` cannot prove any of it**. The
vitest and e2e layers are the real verdict.

## Files touched

| File | Change |
|---|---|
| `ui/src/interaction/actions.ts` | add `LANE_NEW` |
| `ui/src/interaction/gestureTables.ts` | two rules on `MOSH` |
| `ui/src/v2/lanes/TrackLaneList.tsx` | lane handlers, lane menu, `TrackTypeIcon`, `addTrackOfKind` |
| `ui/src/v2/inspector/Inspector.tsx` | render `InstrumentSlot` |
| `ui/src/ui/Dock.tsx` | `hideInstrument` prop on `Rack` |
| `ui/src/v2/shellState.ts` | `openBrowserTab` collection arg + one-shot `pendingCollection` |
| `ui/src/v2/PluginBrowser.tsx` | consume `pendingCollection` |
| `ui/src/ui/icons.tsx` | add `IconKeys` |
| `ui/src/v2/shell.css` | slot + lane-menu styling |
| tests | as listed above |
