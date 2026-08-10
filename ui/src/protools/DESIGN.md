# Mosh Pro Tools Shell Design System

This contract is scoped to `.protools-shell`. Existing Mosh shells keep their own visual systems.

## 0. Research Log

- Product reference: reviewed the Avid documentation and visual references recorded in `docs/protools-clone/RESEARCH.md`; extracted Edit Window hierarchy, dense control grammar, ruler stacking, list placement, tools, and keyboard behavior without copying any asset.
- Existing-system extraction: mapped `ui/src/live/`, shared `ClipView`, `PianoRoll`, `SettingsPanel`, `MoshMenu`, `MoshTip`, icons, interaction tables, and global store ownership; selected additive reuse instead of a parallel data path.
- Interaction reference: read beui.dev `tabs` and `table` source; kept its accessible segmented-control semantics and direct pointer-resize mechanism, but omitted its spring library because an editing surface needs immediate, low-motion feedback.
- Spot interaction reference: read Avid's “Spotting Clips” procedure and beui.dev `center-morph-modal` source. Kept controlled open state, initial focus, focus containment, Escape/backdrop dismissal, and trigger restoration; omitted the center-unfold animation and motion dependency to preserve the shell's immediate panel contract.
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
- **States**: visible/hidden, hover, focus, current playhead.
- **Accessibility**: each toggle exposes `aria-pressed`; row name remains text, not an image.
- **Layout**: fixed name column + horizontally translated tick field; timeline owns horizontal scroll.

### Track control row

- **Structure**: color strip, select/name button, record/solo/mute controls, and snapshot-backed output metadata.
- **States**: default, hover, selected, armed, muted, soloed, focus-visible.
- **Accessibility**: controls use native buttons and explicit labels; track name selection is separate from record/mute actions.
- **Layout**: vertical stack row locked to the corresponding lane; resize separator is keyboard-operable.

### Timeline lane and Smart Tool surface

- **Structure**: shared `ClipView` over a grid lane with media-aware intent overlays for fades, MIDI blank marquee, and automation.
- **Variants**: audio, MIDI, automation.
- **States**: default, hover intent, selected, dragging, locked by collaborator, empty.
- **Accessibility**: clips retain shared keyboard semantics; cursor intent is repeated in the status text and tooltips.
- **Layout**: scrollable canvas; lane/header heights remain identical.

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

- **Structure**: clip name, mute state, paired clip-gain slider and numeric field, 0 dB reset, waveform preview, and read-only timing/fade metadata.
- **States**: clean, locally edited, invalid name, invalid gain, command rejected, project replaced, muted.
- **Accessibility**: every field has a visible label; validation is announced and associated with its field; Escape restores the snapshot value; the mute toggle exposes `aria-pressed`.
- **Mutation**: rename, mute, and gain commit only through `rename_clip`, `set_clip_mute`, and `set_clip_gain`. Gain remains local while a pointer or keyboard gesture is active, accepts `-48…+24 dB`, and commits only on completion.
- **Safety**: a `projectEpoch` change resets all drafts and prevents a stale editor gesture from addressing the replacement project.

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
