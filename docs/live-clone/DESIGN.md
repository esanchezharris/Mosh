# Mosh Live Arrangement design contract

Live 11 parity status: NOT PROVEN

## Purpose and authority

This is the rendering contract for the Live-shell Arrangement View before a
component or stylesheet changes. Its visual authority is the installed Ableton
Live 11 Arrangement View capture made for this parity wave. Reproduce the
observable hierarchy and interaction meaning of that capture; do not copy
Ableton assets, source, or implementation.

`SPEC.md`, `WIDGETS.md`, `KEYMAP.md`, and `PARITY.md` remain useful evidence,
but some report Live 12 observations and predate this contract. They are not a
license to mix versions opportunistically. For arrangement-grid decisions the
Live 11 capture wins; the current Live CSS token family remains the shared
Mosh palette/geometry vocabulary until a measured replacement is recorded.

This contract is intentionally narrower than a whole-application clone claim.
It governs the arrangement canvas, its rulers, and the surfaces which must
read as one continuous timeline.

## Existing vocabulary to preserve

- Keep the Live shell scoped under `.live-shell`. No Live token or selector may
  change another shell.
- Preserve the semantic token roles in `live.css`: `--live-lane-bg` is canvas
  ground, `--live-line` is the quiet subdivision, and
  `--live-line-strong` is the stronger bar/structural line. Do not promote a
  gridline to chrome or use clip colour as a grid substitute.
- Keep the measured shell zones and right-header/left-timeline split already
  described in `WIDGETS.md`. The grid belongs only to the time canvas; it must
  never paint through headers, rulers, dock, browser, or status bar.
- `time.ts` is authoritative for tempo/meter conversion, bar boundaries, and
  snapping. `adaptiveGrid.ts` supplies the chosen snap division policy. A CSS
  repeat distance is never an independent timing model.

## ArrangementGrid primitive

`ArrangementGrid` is one positioned, continuous paint layer owned by the
timeline content (`.live-lanes`), not a background repeated independently by
each lane. It has one coordinate space: timeline seconds multiplied by the
active `pxPerSec`.

Its implementation contract is:

- Render exactly one `data-testid="live-arrangement-grid"` inside the scrolling
  timeline content. It spans the complete paintable content width and at least
  the visible timeline height. It extends through normal track lanes, expanded
  take rows, and the unused vertical filler below the final track. With zero
  tracks it still fills the entire empty timeline viewport.
- Each painted division is a positioned child with
  `data-testid="live-grid-line"`, `data-grid-kind` (`bar`, `beat`, or
  `subdivision`), and a machine-readable `data-grid-seconds` value. A line for
  time `t` is laid out at `left: t * pxPerSec`; it begins at the grid's top and
  ends at its bottom. This is a testable mapping contract, not a suggested CSS
  technique.
- Grid, clips, take bars, time-selection band, loop brace, and playhead are
  separate layers. Required bottom-to-top order is: canvas ground/grid;
  ordinary/take clip content; time selection and loop overlays; playhead;
  menus and transient interaction chrome. A grid line must never cover text,
  waveform ink, focus outlines, or pointer targets.
- The grid itself is visual-only: `pointer-events: none`, `aria-hidden="true"`,
  and no focusable descendants. Pointer routing remains on actual lanes/take
  rows/empty ground, whose existing gesture semantics are preserved.

## Line hierarchy and timing math

Bars are the strongest vertical rhythm, beats are visibly quieter, and
subdivisions are quieter still. Line contrast must remain below selection,
clip edge, active loop, and playhead contrast. Horizontal lane boundaries are
structural separators, not substitutes for the grid.

All horizontal placement flows from the same map used by the rulers, snapping,
clip placement, and pointer conversion:

1. Resolve the local meter and tempo at the musical position through `time.ts`.
2. Produce explicit bar and beat boundaries through tempo/meter-map aware
   helpers; never infer a fixed global bar width from the initial meter.
3. Choose the visible subdivision from adaptive/fixed grid state. Adaptive
   state selects a usable resolution from zoom; fixed state preserves the
   selected division. Triplet state changes the subdivision sequence and
   spacing, rather than only changing snap behaviour.
4. Convert every resolved timeline time with the current `pxPerSec`. The
   same conversion owns ruler labels, line `left`, clip coordinates, and
   pointer-to-time mapping.

Tempo ramps and meter changes must therefore cause the grid and rulers to
follow the same map, including boundary transitions. A temporary implementation
may cap offscreen generated lines for performance, but it may not omit a line
inside the visible viewport or create a second timing calculation to do so.

## Viewport and scrolling behavior

The lanes scroller remains the owner of horizontal and vertical scroll. The
grid scrolls with its content exactly once: no parallax and no per-lane phase
reset. Rulers stay horizontally synchronized with that owner; right-hand track
headers remain vertically synchronized without receiving timeline ink.

The grid's paint rectangle is content-width by `max(content-height,
viewport-height)`. This makes the blank area after the last track a continuous
canvas instead of a dead colour block, and preserves the same result for a
new, zero-track project. Resizing lanes or opening/collapsing take rows changes
only the grid's height; its time-origin and horizontal mapping stay unchanged.

## Accessibility and interaction

The timeline already exposes semantic controls, status text, lanes, clip
controls, and take controls. ArrangementGrid adds no duplicate spoken content
or tab stop. Keyboard users continue to operate the existing grid/snap commands
through the control/menu/keymap surface; visual subdivision changes must be
reflected there by the existing pressed/selected state rather than announced by
hundreds of decorative lines.

Do not use a canvas that hides timing information from inspection unless it
also preserves the positioned-line test contract. Decorative lines are
non-interactive; all pointer coordinate calculation must target the real
timeline geometry, then resolve through the shared timing math.

## Accepted debt and non-claims

Accepted debt for this first wave:

- Exact sampled Live 11 colour/contrast deltas and non-default zoom captures
  need a dedicated visual-comparison pass.
- Region comping remains separate from whole-take rows.
- Automation-lane grid treatment, high-density virtualization, and exhaustive
  tempo-ramp/triplet screenshot coverage are later waves once the primitive is
  in place.

These debts do **not** permit blank normal-lane, take-row, filler, or zero-track
canvas regions, independent per-lane grid origins, or a triplet mode that only
changes snapping.

Never claim overall Ableton or Live parity from this work. Such a claim requires
the relevant rows in `docs/live-clone/PARITY.md` and `docs/FEATURE_AUDIT.md` to
be ledgered with an explicit status, the applicable local gate to pass, and
captured visual/interaction evidence for the stated reference state. This
contract and its focused grid test are only entry gates for the arrangement-grid
surface.
