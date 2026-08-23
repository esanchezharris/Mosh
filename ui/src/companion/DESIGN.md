# DAWN Companion Design System

## 1. Atmosphere & Identity

A pocket hardware controller resting on warm studio paper. The signature is the
contrast between a dark recessed chassis and five tactile, color-coded pads; lime
light communicates position, focus, and current pending material.

## 2. Color

| Role | Token | Value | Usage |
|---|---|---|---|
| Ground | `--page`, `--page-deep` | `#efe6d5`, `#ded1bb` | Warm page gradient |
| Chassis | `--surface`, `--surface-2`, `--sunken` | `#18181a`, `#232327`, `#0e0e10` | Banner, pad, navigator |
| Text | `--text`, `--dim`, `--faint` | Existing warm-white ramp | Primary, secondary, marker text |
| Accent | `--accent`, `--accent-ink`, `--accent-soft` | Lime ramp | Pending, playhead, focus |
| Recording | `--rec` | Red | Recording state and disabled-recording navigator |
| Warning | `--warn` | Amber | Blocked state and persistent reason |
| Archive | `--region-archive-high`, `--region-archive-low` | Slate blue ramp | Accepted navigator regions |
| Pending | `--region-pending-high`, `--region-pending-low` | Lime ramp | Current pending navigator region |
| Navigator state | `--region-pending-stripe`, `--region-pending-border`, `--disabled-chip`, `--rec-line`, `--warn-line` | Semantic overlays | Region texture and disabled badge |
| Ground warning | `--blocked-ground` | Dark amber | Persistent blocked reason on paper |

Colors carry state. Pending and archive regions must remain distinguishable
without relying on position; blocked/recording state never uses opacity alone.

## 3. Typography

| Level | Size | Weight | Usage |
|---|---:|---:|---|
| State | 21px | 900 | Banner state |
| Pad label | 20px | 900 | Primary action |
| Compact pad label | 15px | 900 | Record/stop |
| Subtitle | 12px | 400 | Pad explanation and banner metadata |
| Marker | 10px | 400 | Pad action marker |

Primary UI uses the system sans stack; controller labels and state use
`ui-monospace, "SF Mono", Menlo, monospace`. Small type is reserved for terse,
high-contrast metadata, never instructions or the only expression of state.

## 4. Spacing & Layout

The base unit is 4px. Existing 8/12/16px clusters define the vertical rhythm;
10px is the compact hardware-grid gutter. The shell is capped at 430px and
centered at larger viewports. The two-column pad grid, header, edit bar, and
navigator must stay fully visible at 375x812, 768x1024, and 1280x900.

## 5. Components

### Status banner
- **Structure**: state label plus beat/bar and host subtitle.
- **States**: paused, playing, recording, busy, blocked, disconnected, pending.
- **Accessibility**: state text is explicit and never color-only.

### Pad tile
- **Structure**: semantic button, action marker, label, optional subtitle.
- **Variants**: keep, again, hear, record, stop; the MARKER action exists only in Mosh mode.
- **States**: default, active, focus-visible, busy-disabled, edit, dragging.
- **Accessibility**: native button semantics and visible lime focus ring.

### Timeline navigator
- **Structure**: labelled region, typed region spans, ticks, playhead.
- **Variants**: Mosh generic regions; Ableton pending and archive regions.
- **States**: enabled, recording-disabled, blocked-disabled.
- **Accessibility**: `role="slider"`, an explicit label, beat/second value text,
  typed region descriptions in an external `aria-describedby` sibling, visible
  disabled treatment, and Arrow/Home/End keyboard seeking while enabled.

### Persistent status message
- **Structure**: live status line below the controller.
- **States**: transient action feedback or persistent blocked reason.
- **Accessibility**: `role="status"`; blocking reasons remain present at rest.

## 6. Motion & Interaction

Pad press uses the existing 140-150ms transform/filter response; edit reordering
uses the existing drag controller. The navigator playhead follows pointer input
immediately; ArrowLeft/ArrowRight step one beat or second, while Home/End seek to
the timeline boundaries. State styling is static. Reduced-motion disables
nonessential pad and edit-button transitions.

## 7. Depth & Surface

Mixed tonal shift, fine borders, inset highlights, and one warm page shadow make
the controller read as hardware. Semantic navigator treatments live inside the
existing recessed track and must not add floating-card depth.

## 8. Accessibility Constraints & Accepted Debt

Target WCAG 2.2 AA for state text and controls, with visible focus and no
color-only state distinctions. Pointer-disabled navigator state must also expose
ARIA state and plain-language text. The disabled slider remains focusable so its
lock reason is discoverable, but pointer and keyboard seek commands are ignored.

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| Compact mono metadata remains below 14px | Pad markers and short subtitles | Fixed phone controller with redundant large labels; this round raises the smallest text and contrast | Revisit if physical iPhone legibility gate fails |
