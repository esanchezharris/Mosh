# Mosh Pro Tools Shell Design System

This contract is scoped to `.protools-shell`. Existing Mosh shells keep their own visual systems.

## 0. Research Log

- Product reference: reviewed the Avid documentation and visual references recorded in `docs/protools-clone/RESEARCH.md`; extracted Edit Window hierarchy, dense control grammar, ruler stacking, list placement, tools, and keyboard behavior without copying any asset.
- Existing-system extraction: mapped `ui/src/live/`, shared `ClipView`, `PianoRoll`, `SettingsPanel`, `MoshMenu`, `MoshTip`, icons, interaction tables, and global store ownership; selected additive reuse instead of a parallel data path.
- Interaction reference: read beui.dev `tabs` and `table` source; kept its accessible segmented-control semantics and direct pointer-resize mechanism, but omitted its spring library because an editing surface needs immediate, low-motion feedback.
- Spot interaction reference: read Avid's “Spotting Clips” procedure and beui.dev `center-morph-modal` source. Kept controlled open state, initial focus, focus containment, Escape/backdrop dismissal, and trigger restoration; omitted the center-unfold animation and motion dependency to preserve the shell's immediate panel contract.
- Tutorial parity reference: reviewed official Avid Edit Window, recording, I/O, Clip Gain, automation, and MIDI Editor videos at the timecodes recorded in `docs/protools-clone/RESEARCH.md`. Extracted structural ratios and before/during/after behavior only; source frames remain private and uncommitted.
- Selection-link reference: reviewed Avid's Timeline/Edit selection documentation, OBEDIA's linked-selection demonstrations, and the beui.dev `switch` source. The Pro Tools control keeps native pressed semantics and immediate state feedback, but omits the spring thumb because a dense editing toolbar benefits from the shell's existing depressed-button grammar.
- Selection-marker reference: Avid's Timeline Selections help identifies the down arrow as Start, the up arrow as End, Time Grabber as the drag tool, and Grid as the movement constraint. The beui.dev `range-slider` source supplies pointer-capture and slider-keyboard semantics; Mosh keeps direct, unsmoothed movement so the marker remains sample/grid legible and reduced-motion safe.
- Selection-indicator reference: Avid's counter help defines Start/End/Length as editable Edit-window fields following the Main Time Scale, with Forward Slash field cycling and Enter acceptance. Sound On Sound corroborates that these fields remain the Edit selection while an unlinked extended Transport owns Timeline. Mosh uses native text inputs and a native scale selector instead of copying Avid counter art.
- Track/Edit-link reference: Avid's Menus Guide defines single- and multi-track association plus independent disabled state; the current Shortcuts Guide assigns Shift+T. OBEDIA footage corroborates depressed blue feedback, vertical range-to-track association, selected-track Track View fan-out, track-name reassignment, and divergence while disabled. Mosh keeps one canonical active/inspector track while representing the complete contiguous Edit-track set in shell-local state, without copying Avid link artwork.
- Automation conflict resolution: Avid's Smart Tool help page explicitly assigns Selector to the bottom 75% and Trim to the top 25% of automation/controller views. That authority preserves the existing classifier despite simplified “half” language in the short automation video.
- Skipped generated imagery and broad style search: the user supplied a concrete Pro Tools reference target and prohibited proprietary art reuse; original CSS geometry and existing Mosh renderers are the fidelity contract.

## 1. Atmosphere & Identity

A dense, quiet editing console that feels mechanical, dependable, and immediately legible under long sessions. Visual variance is low and information density is high. The signature is the locked left control bank meeting a horizontally moving ruler-and-lane field beneath a two-tier dimensional toolbar. It should evoke the operating logic of an Edit Window without reproducing Avid branding or artwork.

## 2. Color

### Palette

| Role | Token | Dark | Classic | Usage |
|---|---|---|---|---|
| Canvas | `--pt-canvas` | `#1E1E1E` | `#C0C0C0` | Shell and timeline bed |
| Surface | `--pt-surface` | `#252525` | `#B5B5B5` | Toolbars and panels |
| Raised | `--pt-raised` | `#2D2D2D` | `#D0D0D0` | Dimensional headers and active groups |
| Inset | `--pt-inset` | `#191919` | `#A8A8A8` | Counters, lane wells, depressed controls |
| Text | `--pt-text` | `#C0C0C0` | `#202020` | Primary labels |
| Muted text | `--pt-text-muted` | `#949494` | `#4D4D4D` | Secondary metadata and 10px ruler labels; 4.54:1 dark / 5.48:1 Classic over `--pt-raised` |
| Selection | `--pt-selected` | `#4A90D9` | `#2F70B2` | Selected tools, clips, focus |
| Selected foreground | `--pt-on-selected` | `#101820` | `#FFFFFF` | Small text/icons on a selected control; 4.9:1 dark / 5.1:1 Classic |
| Grid | `--pt-grid` | `#3A3A3A` | `#909090` | Timeline divisions |
| Border | `--pt-border` | `#111111` | `#777777` | Hard panel and control edges |
| Highlight | `--pt-highlight` | `#454545` | `#E0E0E0` | Top bevel and hover |
| Wave outline | `--pt-wave-outline` | `#E3E3E3` | `#FFFFFF` | Waveform edge/glow |
| Danger | `--pt-danger` | `#D76A64` | `#9A2E2A` | Record and destructive state |
| Danger foreground | `--pt-on-danger` | `#1E1E1E` | `#FFFFFF` | Small text/icons on a danger control; 4.8:1 dark / 7.5:1 Classic |
| Focus ring | `--pt-focus-ring` | `#4A90D9` | `#005A9C` | Keyboard outline; Classic value is 3.9:1 against its canvas |

### Rules

- Track color supplies clip fill; the light waveform token supplies its readable outline.
- Selection blue only communicates active selection, focus, or a chosen mode/tool.
- Classic is a full token swap rooted in the requested `#C0C0C0` gray, never an inverted filter.
- New color values must be added here before CSS uses them.

## 3. Typography

### Scale

| Level | Size | Weight | Line height | Tracking | Usage |
|---|---:|---:|---:|---:|---|
| Counter | 20px | 600 | 1 | 0.04em | Main location display |
| Control | 12px | 600 | 1.2 | 0.01em | Buttons and track names |
| Utility | 11px | 500 | 1.25 | 0.02em | Rulers, list rows, status |
| Micro | 10px | 600 | 1.2 | Meter and I/O labels |

### Font Stack

- Primary: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` to match the host application and remain locally available.
- Data: `ui-monospace, SFMono-Regular, Menlo, monospace` for counters and ruler values.

### Rules

- The shell is a desktop production tool, so compact control labels may use 10–12px; tooltips and accessible names carry meaning that icons alone cannot.
- Use tabular numerals for counters, time rulers, and nudge values.

## 4. Spacing & Layout

### Base Unit

Spacing derives from a 4px unit: `--pt-space-1: 4px`, `--pt-space-2: 8px`, `--pt-space-3: 12px`, `--pt-space-4: 16px`, `--pt-space-6: 24px`. Modal controls use `--pt-control-h: 32px`; the Spot surface is capped by `--pt-dialog-w: 360px` before viewport padding.

### Grid and Ownership

- The shell owns the viewport and never body-scrolls. Toolbar, rulers, dock, and status are fixed rows.
- Track controls are a resizable left column: 160px default, 128px minimum, 280px maximum.
- The timeline is the sole horizontal scroll owner. Track rows and headers share one vertical scroll position.
- Clip List is a right supporting panel; Track List is integrated into the left control bank. Neither is a content browser.
- Wide: toolbar + left headers + lane field + optional Clip List + bottom editor.
- Compact below 760px: Clip List closes and nonessential toolbar labels compress, but Nudge, Tab-to-Transients, Rulers, Settings, and Interface Options remain in the toolbar's horizontal scroll range; the bottom editor remains usable.
- Session operations stay in one labelled toolbar menu. Selected-track routing and mix controls live in the detail dock rather than crowding the fixed-height track headers.

### Wireframe

```text
┌ modes/tools/counter/grid+nudge/ruler/list toggles ┐
├ track-list title ┬ stacked timebase rulers ┬ clips ┤
│ resizable track  │ horizontally scrolling   │ list  │
│ headers          │ audio/MIDI/automation    │       │
├──────────────────┴───────────────────────────┴───────┤
│ bottom MIDI or clip editor                           │
├ status / mode / tool / navigation readout ──────────┤
```

## 5. Components

### Segmented mode and tool groups

- **Structure**: labelled toolbar group containing native buttons; the active item uses `aria-pressed`.
- **Variants**: four Edit Modes, six explicit tools, Smart Tool combination.
- **States**: default, hover, pressed, focus-visible, disabled.
- **Accessibility**: group labels, full keyboard shortcuts, 24px visual minimum and 32px compact hit target.
- **Motion**: color/opacity only, `--pt-motion-micro`; no traveling indicator.
- **Layout**: wrapping cluster; toolbar itself does not scroll vertically.

### Session action menu

- **Structure**: one labelled toolbar trigger backed by the shared File action definitions and Mosh menu chrome.
- **States**: closed, open, keyboard-highlighted action, native picker canceled, command rejected.
- **Accessibility**: native button trigger, menu semantics, visible shortcut hints, Escape dismissal, and focus return supplied by the shared menu primitive.
- **Mutation**: New, Open, Save, Save As, and Export continue through `runAction`; file pickers only select paths and never mutate a project directly.

### Ruler row

- **Structure**: name cell aligned with track headers plus repeated tick labels over the lane scale.
- **Variants**: Bars+Beats, Timecode, Minutes:Seconds, Samples; independently toggleable.
- **States**: visible/hidden, hover, focus, current playhead, linked Timeline/Edit span, independent Timeline playback span.
- **Accessibility**: each toggle exposes `aria-pressed`; row name remains text, not an image.
- **Layout**: fixed name column + horizontally translated tick field; timeline owns horizontal scroll.

### Timeline selection marker

- **Structure**: two original CSS triangle handles on the Main Timebase ruler; down identifies Start and up identifies End without copying Avid art.
- **States**: blue playback range, record-red range, Smart Tool/Time Grabber enabled, dragging, keyboard focus, and linked or independent Timeline ownership.
- **Accessibility**: each handle is a named slider exposing its current seconds value. Arrow keys move one Nudge value; Home and End move to the session bounds. The handles enter the tab order only while Smart Tool or Grabber is active.
- **Behavior**: direct pointer movement adjusts one boundary while the opposite boundary stays fixed. Grid mode snaps unless Option/Alt is held; Slip remains exact. Boundaries stop one visible pixel before crossing so the active handle cannot disappear during capture.
- **Safety**: pointer cancellation restores the prior range; project replacement clears an in-flight range; link changes cannot redirect a gesture after pointer-down.
- **Mutation**: boundary movement changes view state only. Playback, Punch, or another explicit command may consume the resulting Timeline range later.
- **Motion**: direct position updates with no spring or tween; focus and active feedback use existing color/opacity tokens only.

### Edit Selection indicators

- **Structure**: a compact three-row Start, End, and Length input stack beside the Main Counter, plus one Main Time Scale selector shared by the counter cluster.
- **States**: collapsed insertion display, linked Edit/Timeline range, independent Edit range, focused draft, invalid draft, and project replacement.
- **Accessibility**: native labelled text inputs expose their active time scale and validation state. Forward Slash cycles Start → End → Length; Enter accepts; Escape cancels. The shell-level unmodified Slash shortcut focuses and selects Start outside editable controls.
- **Behavior**: Start and End are locations; Length is a duration from Start. A valid accepted value updates the Edit range. When Link T/E is off, the independent Timeline range does not move. Absolute formats reuse the Spot parser; Bars+Beats duration uses zero-based bars, beats, and sixteenths as an explicit shell-resolution adaptation.
- **Safety**: drafts remain local, invalid or out-of-visible-range values do not apply, blur/Escape cancel them, and `projectEpoch` invalidates every pending entry.
- **Mutation**: accepted values update UI-local Edit-selection state only; no snapshot mutation or `store.exec` call occurs.
- **Layout**: the vertical counter stack stays inside one toolbar group; the toolbar remains horizontally scrollable at compact width rather than hiding controls.

### Link Timeline and Edit Selection control

- **Structure**: one labelled native toolbar button beside the Edit Tools, using the same depressed selected state as Smart Tool rather than Avid artwork.
- **States**: linked by default, unlinked with an independent Timeline range, focus-visible, compact toolbar overflow.
- **Accessibility**: `aria-pressed` and the full “Link Timeline and Edit Selection” accessible name; Shift+/ toggles it outside editable fields.
- **Behavior**: unlinking clones the current Edit span into the Timeline span. Later track/clip selections change only the Edit span, while ruler selections and Punch use only the Timeline span. Relinking makes the current Edit span authoritative again.
- **Mutation**: both spans and the link flag are project-scoped view state; no MoshOps command is issued until an explicit action such as Punch consumes the Timeline range.
- **Motion**: immediate tokenized color/depth feedback; no moving thumb or layout animation.

### Link Track and Edit Selection control

- **Structure**: one labelled pressed toolbar button adjacent to Link Timeline/Edit. Track/Edit and Timeline/Edit are independent options and never share state.
- **States**: linked by default, one or multiple contiguous or discontiguous associated tracks, unlinked with retained Edit- and Track-selection sets, focus-visible, project replacement, and compact toolbar overflow.
- **Accessibility**: `aria-pressed`, the full “Link Track and Edit Selection” accessible name, and Shift+T outside editable controls.
- **Behavior**: a linked Selector or Smart Tool drag across primary lanes selects every visible track between the anchor and focus lanes while preserving the same horizontal Edit range. A plain Track Name click replaces the selected set, Shift-click selects the visible contiguous range from the active header, and Command-click on macOS or Control-click elsewhere toggles a discontiguous Track Name. Linked header selection assigns the same Edit span to that exact set; unlinked header selection changes only Track selection. Track View changes fan out to every compatible selected track. Relinking makes the Edit-track set authoritative again.
- **Visual feedback**: every selected Track Name exposes immediate native `aria-pressed` state, following the nearest BeUI checkbox pattern's semantic/immediate-state principle without importing its visual treatment. The Edit overlay renders one band per contiguous associated run so a discontiguous selection never paints intervening lanes. When unlinked, the independently selected header set remains separate visible feedback.
- **Safety**: pointer cancellation restores the prior Edit- and Track-selection sets; project replacement clears them. Missing or deleted track ids are filtered against the current visible-track order before geometry or group operations run.
- **Mutation**: link and both selection sets are UI-local. The focused lane still uses the existing global `setSelectedTrack` path for the active inspector and multiplayer signaling; no snapshot mutation or project command occurs. Track View is shell-local display state.
- **Adaptation**: Mosh's canonical active-track field remains singular, so the last focused associated lane owns the inspector while the shell renders and operates on the complete selected set. If a modifier removes the active Track Name, the last remaining selected Track Name becomes active; removing the final Track Name clears the linked Edit range.

### Edit Keyboard Focus track navigation

- **Behavior**: P moves Edit ownership up one visible track and Semicolon moves it down while the Edit timeline or a clip owns focus. Control+P and Control+Semicolon provide Avid's system-level Mac shortcuts outside editable controls. A multi-track Edit set collapses to the one adjacent track resolved from its focused lane; the horizontal time span is unchanged.
- **Linked state**: Link Track/Edit on moves the pressed Track Name and active inspector with Edit ownership. Link Track/Edit off moves only the Edit band and leaves independently selected Track Names unchanged.
- **Boundary and safety**: navigation at the first or last visible track is a no-op and is not claimed from unrelated buttons by the focus-only shortcut. Track ids are resolved against current visible order, so deleted/group/return tracks cannot become targets. This is project-scoped UI state and issues no command.

### Track control row

- **Structure**: color strip, select/name button, record/solo/mute controls, and snapshot-backed output metadata.
- **States**: default, hover, selected, armed, muted, soloed, focus-visible, group action in flight, failure.
- **Accessibility**: controls use native buttons and explicit labels; Track Name selection is separate from record/mute actions. Shift+R/S/M/I act outside editable controls on the exact tracks containing the Edit cursor or selection. Option/Alt+Shift-click on R/S/M/I applies the source control's next state to selected Track Names.
- **TrackInput adaptation**: the compact I button and Shift+I toggle between In (`on`) and Auto (`automatic`), matching Pro Tools' binary TrackInput action while retaining Mosh's explicit Off choice in the inspector. Its pressed state means In.
- **Mutation**: group actions call the existing `arm_track`, `set_track_solo`, `set_track_mute`, or `set_input_monitor` MoshOps command once per target in visible order. Calls are serial, stop on the first failure, and abort on `projectEpoch` replacement. Both `ok:false` and `ok:true, applied:false` surface through the existing Pro Tools error banner. This preserves canonical validation, JSONL, multiplayer locks, and hardware-application semantics; it is explicitly not an atomic native group command.
- **Layout**: vertical stack row locked to the corresponding lane; resize separator is keyboard-operable.

### Timeline lane and Smart Tool surface

- **Structure**: shared `ClipView` over a grid lane with media-aware intent overlays for fades, MIDI blank marquee, and automation.
- **Variants**: audio, MIDI, automation.
- **States**: default, hover intent, selected, dragging, locked by collaborator, empty.
- **Accessibility**: clips retain shared keyboard semantics; cursor intent is repeated in the status text and tooltips.
- **Layout**: scrollable canvas; lane/header heights remain identical.

### Automation lane editing

- **Structure**: one keyboard-focusable lane surface, a persistent time-range overlay, an SVG curve, and native breakpoint buttons positioned over the curve nodes.
- **Smart Tool**: the lower 75% selects a time range; the top 25% trims every enclosed breakpoint as a batch; Command/Control-click adds a breakpoint. These regions follow Avid's authoritative Smart Tool help rather than approximate tutorial narration.
- **Breakpoint behavior**: direct drag moves one point in time and value; Option/Alt-click or Delete removes it; focus and selected-range membership remain visible independently of color.
- **Clipboard**: ⌘C/⌘X/⌘V and the right-click menu operate on selected automation rather than the clip clipboard. Copied points are stored relative to the selection, Paste targets the edit insertion, Cut removes addressed indices from last to first inside one undo batch, and `projectEpoch` replacement clears the clipboard.
- **Pencil clutch**: Control-drag previews and commits a linear segment; Control+Command-drag samples an ordered freehand segment. This follows the modifier sequence demonstrated in Avid V07 while leaving Command-click breakpoint creation intact.
- **Feedback**: selection and trim previews remain local during the gesture. The persistent overlay exposes the selected span, and the trim readout exposes its delta before a command is committed.
- **Mutation**: individual edits use `set_automation_point` or `remove_automation_point`; selected-range trim/nudge uses one `write_automation_curve` replacement so one gesture remains one undo transaction.
- **Native menus**: macOS Edit-menu Cut/Copy/Paste is handed back to the focused lane or breakpoint before the shared clip dispatcher, so the packaged shortcut path matches the browser path without adding a second keyboard hook.
- **Safety**: pointer cancellation, Escape, command rejection, or `projectEpoch` replacement discards previews and cannot address the replacement project. A disabled lane with no target has no breakpoint focus targets.
- **Accessibility**: the lane describes Enter/Space creation and selection shortcuts; every point is a named native button; selected nodes expose `aria-pressed`; keyboard users can delete a focused point and nudge a selected range.

### Supporting list panel

- **Structure**: labelled list of tracks or clips with native buttons and a collapse control.
- **States**: open, closed, selected row, empty.
- **Accessibility**: `aria-expanded`, region labels, predictable DOM order.
- **Motion**: panel appears immediately; only opacity/color changes are allowed.
- **Layout**: Clip List is a right sidebar; Track List is the left header bank.

### Detail dock and status bar

- **Structure**: dock header + shared PianoRoll for MIDI, clip inspector for audio, or a selected-track inspector with input/output routing, monitor mode, volume/pan, and inserts; bottom status text exposes mode, tool, nudge, and contextual pointer intent.
- **States**: closed, MIDI, audio, selected track, loading catalogs, empty routing catalog, command rejected, empty selection.
- **Accessibility**: labelled region, explicit close button, content stays keyboard reachable.
- **Layout**: dock is a fixed shell row with internal overflow; selected-track channel controls sit beside inserts on wide screens and stack inside the dock's own scroll area on compact screens; status bar never overlays content.

### Audio clip inspector

- **Structure**: clip name, mute state, paired static clip-gain slider and numeric field, 0 dB reset, waveform preview, read-only timing/fade metadata, plus an inline selected-clip static handle and a dynamic clip-local gain envelope in the timeline.
- **States**: clean, locally edited, invalid name, invalid gain, command rejected, project replaced, muted.
- **Accessibility**: every field has a visible label; validation is announced and associated with its field; Escape restores the snapshot value; the mute toggle exposes `aria-pressed`; the inline handle exposes slider semantics, value text, Arrow/Home/End control, and a visible focus ring.
- **Mutation**: rename, mute, and static gain commit only through `rename_clip`, `set_clip_mute`, and `set_clip_gain`. Static gain remains local while a pointer or keyboard gesture is active, accepts `-48…+24 dB`, and commits only on completion. Dynamic breakpoints replace one clip-local envelope through `write_clip_gain_curve`; offsets accept `-48…+6 dB`, are stored source-relative, and remain a single undo transaction per gesture.
- **Safety**: a `projectEpoch` change resets all drafts and prevents a stale editor gesture from addressing the replacement project.
- **Dynamic behavior**: with Smart Tool or Grabber active, clicking the gain line inserts an interpolated breakpoint. Pointer movement changes gain vertically and timing horizontally; keyboard users can add at the playhead, nudge in time/value, or delete a focused point. Escape, pointer cancellation, command rejection, and project replacement discard local preview state.
- **Visual feedback**: the static gain line maps the supported dB range into the waveform body. The shared waveform canvas receives an optional Pro Tools amplitude function and scales every column by static gain plus the interpolated dynamic offset, including local pointer preview; other shells retain their original unscaled renderer path. The dynamic SVG line and native breakpoint buttons stay aligned with that calculation. These are original Mosh primitives, not copied Avid art.

### Insert browser and rack

- **Structure**: Add Insert opens the shared catalog in a modal; existing insert cards expose Open, Power, and Remove without hiding commands in a context menu.
- **States**: catalog loading, filtered, no results, VST3 scan in progress, scan or quarantine error, frozen track, enabled, bypassed.
- **Accessibility**: the search receives initial focus; focus stays inside the modal; Escape/backdrop/Close dismiss; focus returns to Add Insert.
- **Mutation**: catalog entries route through shared `load_plugin`/`load_builtin`; rack actions use `open_plugin_editor`, `bypass_plugin`, and `remove_plugin` through `store.exec`.
- **Safety**: the shell exposes VST3-only rescan for tonight's required hosted-plugin workflow. Scan progress and quarantine failures remain visible; AudioUnit-wide scanning is intentionally unavailable here.

### Ask Moshi drawer

- **Structure**: one toolbar trigger opens a nonmodal bottom-right overlay containing the shared AgentComposer, task drawer, and change toast. At compact width it becomes a full-width bottom sheet.
- **States**: closed by default, composing, listening, working/Stop, completed/task Undo, applied/change Undo, and error.
- **Accessibility**: opening focuses the composer; Escape or Close dismisses; focus returns to the toolbar trigger; the drawer is complementary rather than modal.
- **Layout**: the closed drawer has no DOM or layout footprint. The open drawer overlays instead of resizing the timeline.

### Spot placement dialog

- **Structure**: modal title and clip identity, native Time Scale select, one editable Start field, validation message, Cancel, and Spot confirmation.
- **Variants**: Bars+Beats, fixed-30-fps Timecode, Minutes:Seconds, and Samples use the same conversion contract as the visible rulers.
- **States**: open, invalid location, submitting, command rejected, closed by confirmation, Escape, Cancel, backdrop, or project replacement.
- **Accessibility**: Grabber activation is available by pointer or Enter/Space on a focused clip; Start receives initial focus and selection; Tab stays inside the dialog; Escape and Cancel restore the originating clip; errors are announced and associated with Start.
- **Mutation**: successful confirmation sends exactly one `move_clip` command with `clipId` and parsed non-negative `start`; invalid or stale-project input sends no command.
- **Motion**: immediate modal mount plus tokenized opacity/color feedback only; reduced motion removes the remaining transitions.

## 6. Motion & Interaction

| Token | Value | Usage |
|---|---|---|
| `--pt-motion-micro` | `100ms ease-out` | Hover, press, focus color/opacity |
| `--pt-motion-panel` | `140ms ease-out` | Optional panel opacity only |

- Mode/tool selection uses the beui.dev segmented-tabs accessibility mechanism (`role`/`aria-pressed` equivalent) without its spring: edit commands must feel immediate.
- Link Timeline and Edit Selection adapts the beui.dev switch's native state semantics to the existing depressed toolbar-button primitive; it changes immediately and requires no spatial animation.
- Timeline selection markers adapt beui.dev range-slider pointer capture and slider keyboard semantics, but deliberately omit its spring position smoothing so Grid and sample boundaries never lag the pointer.
- Header resizing follows the beui.dev table mechanism: pointer capture, clamped direct width updates, and no tween during drag.
- Smart Tool feedback changes cursor and status text before mutation; drag mutations commit only through `store.exec` on gesture completion.
- Spot mode intercepts the Grabber's normal move gesture, opens the placement dialog after pointer release (or keyboard activation), and restores the clip trigger when dismissed.
- All nonessential transitions are disabled under `prefers-reduced-motion: reduce`.
- Never animate width, height, left, or grid tracks. Panel layout changes are immediate.

## 7. Depth & Surface

Strategy: mixed tonal shift plus one-pixel dimensional edges.

- Toolbar and track headers use a top highlight, dark bottom edge, and subtle inset counter wells.
- Timeline and clip-list depth comes from tonal differences, not floating cards.
- Menus and tooltips reuse Mosh chrome instead of introducing shell-specific elevation.
- No large soft shadows, glass blur, gradients, or rounded card stacks. Control radius is 2–3px maximum.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- WCAG 2.2 AA target: 4.5:1 body/control text where practical, 3:1 focus and non-text state indicators.
- Keyboard-first editor persona: can choose every mode/tool, toggle rulers/lists, navigate by Tab, nudge selected clips, resize the header column, operate transport, and undo without pointer-only traps.
- Low-vision producer at 200% zoom: essential controls remain reachable, supporting lists collapse before the timeline becomes unusable, and only the timeline intentionally scrolls horizontally.
- Motion-sensitive producer: no required spatial animation; reduced motion disables remaining opacity/color transitions.
- Screen-reader users receive names for icon buttons, pressed/expanded state, regions, selected rows, and the current contextual Smart Tool intent.
- Focus is never conveyed by color alone; `.protools-shell :focus-visible` uses `--pt-focus-ring`, including the higher-contrast Classic ring.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| Exact pixel polish against current Pro Tools | Entire shell | Explicit follow-up; Pro Tools is unavailable locally and no proprietary imagery is copied | Later reference-fidelity pass with licensed access |
| Spot Sync Point and timestamp recall | Spot dialog | The additive contract is defined, but native/mock persistence is intentionally outside tonight's critical path | Implement [Spot Sync Point contract](../../../docs/protools-clone/SPOT_SYNC_POINT_CONTRACT.md) as one tested native/mock/UI lane |
| Memory Locations | Toolbar/list surfaces | Explicitly outside this delivery | Follow-up navigation slice |
| True transient detector | Tab navigation | Mosh exposes waveform peaks, not Pro Tools transient metadata; falls back to clip boundaries | Replace when an additive backend transient feed exists |
| Native Pro Tools behavioral validation | Research/QA | Pro Tools is not installed; browser QA proves Mosh behavior only | Validate later on an authorized reference system |
