# Mosh Live — Live 12 Arrangement-View clone SPEC (build contract)

Measured 2026-08-06 from the owner's Live 12 Suite 12.4.2 on this machine (macOS,
3024×1964 Retina screenshot = 1512×982 pt; all geometry below in **points**, halved from
screenshot pixels). Reference screenshots live in `.cache/live-ref/` (gitignored):
`04-arrangement2` (empty arrangement), `05-midiclip` (clip + clip view), `06-notes`
(painted notes), `07-samples` (browser samples), `08-audioclip` (sample editor),
`09-ctxmenu` (clip context menu), `10-mixer` (arrangement mixer). Tooling used:
`mouse.py` (CGEvent driver), `sample.py` (pixel sampler) — both in that folder.

Legal boundary (from the approved plan): everything here is **observed/measured**, no
Ableton assets are copied. Ableton's font ("Ableton Sans") and icons are proprietary —
substitute our own (system sans + our icon set), matching metrics, not artwork.

---

## 1. Zone model (Arrangement View)

```
┌──────────────────────────────────────────────────────────────────┐
│ CONTROL BAR (30pt)                                               │
├──────────┬──────────────────────────────────────────┬────────────┤
│ BROWSER  │ RULER (bar numbers) ~19pt                │ TRACK      │
│ ~331pt   │                                          │ HEADERS    │
│ (2 col:  │                                          │ (RIGHT!)   │
│ cats     │ TRACK LANES — 86pt default lane height   │ ~275pt     │
│ 109pt +  │                                          │ (with I/O) │
│ results) │                                          ├────────────┤
│          │                                          │ returns    │
│          │                                          │ ~35pt,     │
│          │                                          │ Main ~17pt │
│          ├──────────────────────────────────────────┼────────────┤
│          │ ELAPSED-TIME RULER + H-ZOOM ~25pt        │ 1/1 corner │
├──────────┴──────────────────────────────────────────┴────────────┤
│ CLIP VIEW / DETAIL DOCK ~265pt (toggle; auto-opens on clip ⌃)    │
│  [clip params | note tools | keys strip | editor | velocity]     │
├──────────────────────────────────────────────────────────────────┤
│ STATUS BAR ~15pt (context line left, track chip right)           │
└──────────────────────────────────────────────────────────────────┘
```

- Window chrome: standard macOS titlebar with document title centered ("Untitled").
- The **track headers are on the RIGHT** of the lanes — Live's signature. Lanes scroll
  horizontally under a fixed header strip.
- **Mixer** (View → Mixer) is a horizontal strip-overlay at the BOTTOM of the lanes area,
  above the clip dock (`10-mixer`): I/O section, Sends knobs, pan, fader with dB scale,
  track number / S / arm buttons. We do NOT ship a mixer in v1 of the clone (Mosh's mixer
  exists in classic; tuck behind the same toggle position later).
- The **clip view dock** auto-opens when a clip is double-clicked and can be toggled
  (View → Clip View / Device View). It sits ABOVE the status bar, full width, and the
  lanes shrink to make room (nothing overlaps, nothing floats).

## 2. Palette (sampled, quantized ±2)

| Token | Value | Where |
|---|---|---|
| `live-bg-deep` | `#2e2926` | control bar, rulers, dock headers |
| `live-bg` | `#3b3430` | lanes, browser, info view, panels |
| `live-bg-raise` | `#3d3733` | editor grid, lighter panel rows |
| `live-bg-inset` | `#13100d` | clip params panel (near-black warm) |
| `live-line` | `#282420` | hairlines, gridlines (subtle, low contrast) |
| `live-text` | `#bcb3a6` | primary text/icons (warm bone) |
| `live-text-dim` | `#8a827a` (est.) | secondary labels |
| `live-accent` | `#f3b166` | ACTIVE controls: draw mode, track number box, loop toggle, warp |
| `live-select` | `#7a8fa0` (est.) | browser row selection (cool gray-blue) |
| `live-status` | `#121e21` | status bar (dark teal-black) |
| track/clip colors | per-track: `#836ddd` (lavender), `#c870d8` (pink), `#a878c0`… | user-assignable; Mosh already has track colors |
| editor note fill | `#b9dce9` light / `#aecfdb`; selected darker navy `#35302d`-family | notes take a LIGHT tint of clip color; selection darkens |

Type: Ableton Sans ≈ 11–12pt UI / 10pt micro (ruler numbers, lane micro-labels). Use
`-apple-system` with the same sizes; letter-spacing 0; no uppercase micro-labels except
category headers ("Collections", "Library", "Places" — small caps gray).

## 3. Control bar inventory (left → right, 28pt tall)

`◧ Link ▾ · Tap · 120.00 (tempo field) · meter glyphs · 4/4 · 0% (swing) · count-in ● ▾ "1 Bar" ·`
`key sig [C ▾ Major ▾] · follow →← · POSITION "35. 4. 4" (bars.beats.16ths) · ▶ ■ ● (play/stop/record) ·`
`+ (add track) · link · ← · punch icons · loop ○ · loop start "3. 1. 1" · curve · automation · loop end "4. 0. 0" ·`
`⋯ [pencil = DRAW MODE, accent when ON] [keys icon = computer MIDI] Key MIDI (map modes) · 48.0 kHz · CPU 0% ▾ · ≡`

Mosh mapping: transport/position/tempo/metronome/loop exist in the store; draw-mode (B)
and computer-keyboard exist in the piano roll — promote to control-bar toggles (they
already persist as settings). Key/MIDI map modes: skip (no Mosh analog). CPU/sample rate:
nice-to-have readout, stub ok.

## 4. Browser (left, ~338pt, two columns)

- Left column (~109pt): **Collections** (Favorites), **Library** (All, Sounds, Drums,
  Instruments, Audio Effects, MIDI Effects, Modulators, Max for Live, Plug-Ins, Clips,
  Samples, Grooves, Tunings, Templates), **Places** (Packs, Splice, Cloud, Push, User
  Library, Current Project, Add Folder…). Small icon + label rows, 17pt row height;
  selected row = cool gray-blue fill, full-width.
- Right column: filter rows (Type: Loop/One Shot/Impulse Response chips; Sounds ▸;
  Drums ▸; Character ▸; Genres ▸; Key ▸) then a **Name** results list (waveform glyph +
  filename, ~17pt rows). Drag result → lane creates a clip (verified working gesture).
- Mosh mapping: our sample/plugin browser content rehoused into this two-column shape.
  Categories map to: Sounds→(presets), Drums→drumkits, Instruments→plugins(inst),
  Audio Effects→plugins(fx), Samples→sample library, Places→file bookmarks.

## 5. Track headers (RIGHT side, ~275pt with I/O, ~93pt collapsed)

Per track (86pt tall to match lane):
- Color block + name (top-left of header), unfold triangle for take lanes.
- I/O grid (when shown): input source ▾ / channel ▾ / **monitor tri-state In·Auto·Off**
  (active = accent orange) / output ▾.
- Track number box (accent orange fill, dark number), **S** solo, arm circle; audio
  tracks add **C** cue + level readout.
- Far-right dot-grip column (~10pt) for lane-height drag.
- Above the headers: "Set" chip + wrench/lock icons; ◀ ▶ nav arrows below.
- Returns (A Reverb, B Delay) + **Main** headers sit BELOW the track headers, shorter.

Mosh mapping: track header content = name, color, mute/solo/arm (exists in store),
monitor state (exists), I/O dropdowns can be stubs reading current routing. Number box =
track index.

## 6. Clips (arrangement)

- **Anatomy**: full-height rounded body (~4pt radius), a darker **header strip** on top
  (~13pt) carrying the clip name; loop-length notches at header right; content preview
  below: MIDI = vertical grid lines + dark note blocks on clip-colored ground; audio =
  waveform in darker ink on tinted ground.
- MIDI clip body `#836ddd`-family (track color); header strip is the same hue darkened
  ~45% (`#36302c` observed is deselected-name strip — verify per color).
- Selected clip: brighter/lighter body + name strip inverts to dark text on light.
- Waveform ink: darker complement of clip color (`#5b4067` on `#879da5` observed).
- Green triangle top-left of clip region = start marker when clip start is before
  visible region / play position indicator.

## 7. Clip view dock (the MIDI editor — Phase 2's target)

Total ~265pt, full width. Left → right:

**Mosh interaction contract:** opening/selecting a MIDI clip makes the MIDI editor
replace the Devices rack in this dock; the two never stack. Clicking the selected
track's right-side name box closes the clip view and restores Devices. This is an
intentional usability override of the measured Live stacked-panel posture: stacking
leaves too little vertical room for note editing.

1. **Clip params panel** (~150pt, near-black `#13100d`): Start/Position/Length fields
   (bars.beats.16ths, with Set buttons), Loop toggle (accent when on), Signature,
   Groove, Scale pickers.
2. **Note tools panel** (~110pt): pitch readout, Fit to Scale / Invert / Add Interval,
   Stretch knob, ×2 //2, Grid ▾, Set Length, %, Humanize, Reverse, Legato.
   → v1: omit this panel; our equivalents live in the editor header already.
3. **Keys strip** (~15pt!): micro piano keys, C3 label, hover plays note.
4. **Editor**: bar ruler (~15pt, numbers 1 2 3…, loop brace shield-markers under it),
   grid (bg `#3d3733`, bar lines slightly stronger than beat lines), notes = light-tint
   blocks with ~2pt radius, velocity lane at bottom (~40pt, triangle markers on a
   127/64/1 scale, velocity-colored), bottom toolbar row: Velocity / Randomize / Ramp /
   Deviation fields.
5. Top strip of dock: search, **Fold**, **Scale**, **Highlight Scale**, and the
   **Notes / Envelopes / MPE** tab group; far right the grid readout ("1/16").

**Editor interactions (observed + verified against Live behavior):**
- Draw mode ON (pencil, accent): click-drag paints a note of drag length, floor-snapped
  to grid; click = grid-length note. OFF: double-click creates grid-length note;
  single click selects.
- Note drag = move (time+pitch), edge drag = resize, Delete = remove, marquee on empty
  ground = select. Velocity: drag marker height.
- Fold hides unused rows; editor grid follows zoom (adaptive) or fixed per context menu.
- Clip loop brace under ruler drags to set loop.

## 8. Arrangement interactions (for Phase 3 audit)

- Click clip = select; drag clip body = move (Mosh's ableton gesture table: header-drag
  moves — VERIFY against Live 12: whole clip body drags, there is no separate header
  drag region; the time-selection drag happens on the lane BACKGROUND / upper half of
  clip? → flagged for the audit pass).
- Drag on empty lane = time selection; ⌘⇧M inserts MIDI clip over selection;
  double-click empty lane = create clip + open editor; double-click clip = open editor.
- ⌘E split, ⌘J consolidate, ⌘L activate loop, ⌘1/2/3 narrow/widen/triplet grid,
  ⌘4 snap toggle, ⌘R rename, 0 = deactivate clip/note, X = zoom back.
- Zoom: ⌘+/−, or drag either Arrangement ruler; the lower ruler reads elapsed time
  and both preserve the time beneath the pointer after horizontal scrolling.
- Context menu inventory captured in `09-ctxmenu` (see §7 of plan for which exist in
  Mosh: split/consolidate/crop/rename/loop/freeze?/bounce exist as moshops).

## 9. Status bar

Left: context-sensitive line (selection readout: "Note Selection Time: 8.1.3–8.4.4
(0.3.1) Pitch: F#3 (66) Velocity: 100 Probability: 100%"). Right: current track chip
(color + name), tiny meters. Mosh: selection readout is genuinely useful — implement.

## 10. What we deliberately DON'T clone (v1)

Session View, Key/MIDI map modes, groove pool, tunings, MPE tab, take lanes UI (engine
has them; UI later), video window, Link, follow actions, automation envelopes editor
(exists separately in Mosh), Max for Live, second window, overview strip.

## 11. Moshi placement (owner decision: tucked)

Control-bar far-right gets ONE Moshi button (spark icon). It toggles a bottom drawer
ABOVE the status bar (same dock mechanism as clip view) or ⇧⌘M-ish shortcut; no
persistent rail. Agent toasts keep their current transient style.
