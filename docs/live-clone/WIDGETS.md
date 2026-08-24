# Mosh Live — Live 12 widget/AX extraction (build reference)

Live 11 parity status: NOT PROVEN

These Live 12 observations are historical reference material, not evidence that
the current shell matches Live 11. See `LIVE11_PARITY.md` for current status.

Extracted 2026-08-06 from Live 12 Suite 12.4.2 on this machine with
`.cache/live-ref/dump_ax.py` (pyobjc AX tree dump), `mouse.py` (CGEvent driver —
`dblclick` fixed to set `kCGMouseEventClickState` before posting), and
`measure.py` (pixel edge-scan for geometry). Per-state JSON + proof screenshots
in `.cache/live-ref/ax/<state>.{json,png}`. **The JSON is the data; this file is
the distilled structure.** All geometry in points (screenshot px / 2). Window
during capture: full width (1512pt), top at 34pt, bottom at ~891pt (floating
above the macOS Dock, not maximized).

## 0. What Live's AX tree does and doesn't give you

- **No geometry anywhere.** AXPosition/AXSize are unset on every node (custom
  widgets). Geometry below comes from pixel edge-scans of the proof shots.
- **No AXSelected on rows/headers.** Selection is only observable through the
  announcer `AXStaticText` in the Arrangement group:
  `Timeline, 24, selected on 1-MIDI, Track 1 of 4, Selection at clip Untitled`
  (the clip suffix appears only when a clip is selected). Track-header click
  changes the track chip but the announcer keeps the clip suffix — don't rely
  on it to distinguish.
- Top-level groups under the main window's content group: `Control`, `Browser`,
  `Arrangement`, `Clip Detail` (**only present when the dock is open**),
  `Status` (one `AXStaticText` = the status line, e.g.
  `Insert Mark 19.1.1 (Time: 0:36)`).
- **Context menus are NOT menu-bar menus.** They appear as
  `AXWindow(subrole=AXUnknown) → AXGroup → AXGroup(desc="Context")` with
  `AXMenuItem` children. Shortcut glyphs are baked into the item title
  (`Rename, ⌘R`); checked items get a `✔ ` prefix; section labels are
  `AXStaticText` (`Adaptive Grid:`); the grid pickers are `AXRadioGroup`
  (`Adaptive Grid` / `Fixed Grid`) of `AXRadioButton`s. Disabled items report
  `AXEnabled=false` — Live uses real enablement, not hidden items.
- Slider min/max are exposed and are the ground truth for ranges (table below).
- The Settings window is a separate `AXWindow` ("Settings"), fully exposed.

## 1. Measured zone model (refines SPEC §1)

Top-to-bottom, arrangement-idle, dock closed:

| Zone | Y range (pt) | Height | Note |
|---|---|---|---|
| Titlebar row | 34–62 | **28** | traffic lights + centered doc title, bg `#2e2926` — SPEC's zone model folded this into the control bar |
| Control bar | 62–92 | **30** | SPEC said 28 — measured 30 |
| **Arrangement overview strip** | 92–103 | **~11** | mini-arrangement with clip blocks; **missing from SPEC §1** (§10 only lists it as not-cloned) |
| Bar ruler (1, 5, 9…) | 103–122 | **~19** | SPEC said ~15 |
| Track lanes | 122–~824 | flex | default lane **86pt** |
| Beat-time ruler (0:00 0:10…) + h-zoom scroller | ~831–856 | ~25 | **at the BOTTOM of the lanes**, not the top as SPEC §1 implies (Options → Time Ruler Format configures this) |
| Status bar | ~874–890 | **16** | SPEC said ~15 ✓ |

- Track header column: **fixed 279pt** (x 1213→1492). **Not drag-resizable** —
  two drag attempts on the lane/header hairline produced no movement and no
  time selection. SPEC's "~93pt collapsed" variant has no affordance in
  arrangement view; treat 279pt as the only width until disproven.
- Returns/Main headers: A Reverb 20pt, B Delay 19pt, Main 19pt — SPEC said
  returns ~35pt, Main ~17pt. Refine.
- Browser: default **331pt** (SPEC said 338), category column 109pt ✓.
  Dragging its divider left **hides it entirely** (no hard min clamp observed;
  it reopens at ~165–331pt, remembering). **Max width 1163pt** — at max, the
  header column keeps its 279pt and the lanes squeeze to a sliver.
- Sidebar row pitch: 39px = **19.5pt** (SPEC said 17pt).

### Lane height (dragged, clamped)

- **Default 86pt · min 17pt · max 443pt.** Drag the header-column divider
  between two tracks. At min, the header collapses to the color block + name
  row only. Restores cleanly to 86.

### Detail dock behavior (clip view + device view)

The measured Live 12.4 reference stacks two panels above the status bar. Mosh
intentionally diverges for the MIDI workflow: the MIDI editor and Devices are
**mutually exclusive**, giving note editing the full dock height. Selecting/opening
a MIDI clip shows the editor; clicking the right-side track name shows Devices.
Wave/audio and Moshi drawer postures retain their existing stacked device panel.

- Clip panel default ~248–265pt; **min clamp 226pt** (a short drag past min
  holds at 226; a long drag well past min **dismisses the view** — drag-to-close,
  not a hard floor).
- Devices-only posture remains fixed ~212pt with no splitter. A track-name click
  explicitly re-shows it even if Devices was previously hidden on that same track.
- **Max = Expanded Clip View**: dragging the clip panel divider to the top (or
  View → Expand Clip View ⌥⌘E) makes the editor consume the **entire window** —
  browser, arrangement and headers all hidden, only control bar + editor + status
  bar. This state is **sticky across close/reopen** of the
  clip view. SPEC §7 doesn't mention expanded mode — add it.
- Mixer strip (View → Mixer ⌥⌘M) overlays the bottom of the lanes area,
  **coexists with the dock** (stacked above it), ~350pt tall observed; the lanes
  compress non-uniformly to fit (tracks seen crushed to 19–59pt).

## 2. Per-state findings

### arrangement-idle / clip-selected / track-header-selected
137 nodes. Groups: Control (Tempo and timing / Scale / Playback), Browser,
Arrangement, Status. The Arrangement group contains: announcer text,
`Arrangement Controls` (Set/Previous/Next Locator buttons, Automation Mode and
Lock Envelopes checkboxes), `Track Headers` AXOutline (one `AXRow` per track,
each with a `Track Title Bar` AXTextField), a per-track
`<name> Mixer Panel Group` (I/O below), Waveform Vertical Zoom checkbox+slider,
Optimize Arrangement Height/Width checkboxes, and a `Loop Brace` group
(`3, Arrangement Loop Start Marker` / `7, Arrangement Loop End Marker`).

Per-track Mixer Panel Group inventory (AX identities):
`Input Type` / `Input Channel` AXPopUpButton, `Monitoring` AXRadioGroup
(`In`/`Auto`/`Off` radio buttons — the active one has value=True),
`Output Type` / `Output Channel` popups, `Track Activator`, `Solo/Cue`,
`Arm Recording` checkboxes. **The current audio track also exposes**
`Track Volume` (0.000316…1.995 = −70dB…+6dB), `Track Pan` (−1…1),
`A-Reverb`/`B-Delay` send sliders (0.000316…1). MIDI tracks didn't expose
faders even in mixer mode (only the current track did) — AX quirk, don't
mirror it.

### ctx-clip (right-click MIDI clip) — 37 nodes
Zoom Back from Time Selection `X` · Rename `⌘R` · Edit Info Text · Split `⌘E` ·
Export MIDI Clip... · Activate Loop `⌘L` · Freeze Track `⌥⇧⌘F` ·
Bounce Track in Place · **Bounce to New Track `⌘B` [disabled]** ·
Paste Bounced Audio `⌥⌘V` [disabled] · Crop Clip `⇧⌘J` [disabled — needs a time
selection] · Reverse Clip(s) `R` [disabled — MIDI clip] · ✔ Snap to Grid `⌘4` ·
then inline `Adaptive Grid` radio row (Widest…Narrowest) and `Fixed Grid` radio
row (8 Bars…1/32), then Narrow Grid `⌘1` [disabled at narrowest] ·
Widen Grid `⌘2` · Triplet Grid `⌘3` [disabled].
Enablement is contextual and honest — mirror that (disable, don't hide).

### ctx-lane (right-click empty lane) — 32 nodes
Same skeleton minus clip items; adds **Insert Empty MIDI Clip `⇧⌘M`**.
Grid radio groups identical.

### ctx-header (right-click track header) — 95 nodes
Cut/Copy/Duplicate/Delete · Rename `⌘R` · Edit Info Text · Freeze Track ·
Bounce Track in Place · Insert Audio `⌘T` / MIDI `⇧⌘T` / Return Track `⌥⌘T` ·
Group Tracks `⌘G` · Select Track Content · Insert Take Lane `⌥⇧T` ·
Show Take Lanes `⌥⌘U` · Delete All/Unused Take Lanes [disabled] ·
Link Tracks / Unlink Track(s) [disabled, <2 selected] · Save as Default MIDI
Track · **`Colors` AXRadioGroup with all 70 named swatches** (Salmon, Frank
Orange, Dirty Gold … Eclipse — full list in `ctx-header.json`, feed to
RESOURCES.md) · Assign Track Color to Clips.

### editor-midi / editor-midi-drawmode (Clip Detail group, 78 kids)
- `Clip Title Bar`: Clip Activator checkbox + name.
- `Clip Tabs` AXRadioGroup: **Main Properties / Launch Properties**.
- Start/End: bars.beats.16ths as separate AXSliders with `Set` buttons
  (disabled until the field is edited) and `Show Start/End` scroll-to buttons.
- `Clip Loop` checkbox, Loop Position/Length sliders, Signature (1–99 / 1–16),
  Groove popup (`Swing 16ths 66`) + Hot-Swap/Commit, Scale Mode + Root/Scale
  popups.
- **`Tool Tabs` AXRadioGroup: `Pitch and Time Utilities` /
  `MIDI Transformation Tools` / `MIDI Generative Tools`** — Live 12's
  Transform/Generate panels. SPEC §7's "note tools panel" is now tabbed;
  refine. Contents: Transpose ±127, Fit to Scale, Invert, Add Interval
  (±74), Stretch Factor, ×2 /2, Duration popup (Grid), Set Length, Humanize
  (0–1), Reverse, Legato — most apply-buttons disabled until notes are
  selected.
- `Editor Settings`: Find and Select Notes, Fold to Notes, Fold to Scale,
  Highlight Scale checkboxes + Grid Division button. (SPEC's "Fold/Scale/
  Highlight Scale" — exact names differ.)
- `Loop Brace` group: `1, Clip Loop Start` / `14, Clip Loop End` /
  `1, Clip Start` / `14, Clip End`.
- The note canvas itself is one opaque `AXGroup` ("Clip Untitled, 1",
  focused=True) — **no per-note AX**. All note editing is invisible to AX.
- Velocity lane: `Show/Hide All Editor Lanes`, `Lane Selector`, Randomize +
  Randomization Amount (1–127), Ramp Start/End (1–127), Velocity Deviation
  (±127, disabled until used).
- Draw mode: Options menu item is **`Draw Mode (Pitch Lock Off)`** in 12.4;
  ⌘B did NOT toggle it with the editor focused (menu click works). ON = pencil
  fills accent orange (verified by pixel scan; no AX node for it).

### editor-audio (Clip Detail group, 74 kids)
Same Start/End/Loop/Signature/Groove/Scale skeleton. Audio-specific:
`Tool Tabs` = **Audio Utilities / Audio Transformation Tools**; `Warping`
checkbox, Tempo Leader/Follower button (Follow), `Warp Mode` popup (Beats),
`Granulation Resolution` (Transients), `Transient Loop Mode` (LoopAlt),
Transient Envelope (0–100), **Segment BPM (5–999)** with /2 ×2, Reverse,
Clip Fade-In/Fade-Out, Clip RAM Mode, High-Quality Rate Conversion,
Clip Gain, Transposition ±48st, Cents ±9700 (raw range). `Editor Settings`
carries the file facts as static text (`80s Beat 90 bpm.wav`, `44.1 kHz`,
`24-Bit`, `2 Ch`). Editor canvas = `Audio Editor` group containing warp-marker
groups (`1, Warp`).

### browser-<category>
Sidebar = `Browser Sidebar` AXOutline (Collections/Library/Places headers as
rows). Results = **`<Category> List, N Items` AXOutline** — counts observed:
Sounds 1001, Drums 1001, Instruments 23, Audio Effects 47, Samples 1001
(1001 looks like a display cap). Filter chips are AXCheckBoxes
(`Loop`/`One Shot`/`Impulse Response`) under a `Type` group; `Sounds ▸`,
`Drums ▸`, `Character ▸`, `Genres ▸`, `Key ▸` groups follow. Selected browser
row fill sampled ≈ `#a8c7d3`-family (light blue-gray) — SPEC's `live-select`
estimate `#7a8fa0` is too dark; re-sample from `browser-*.png` before building.

### mixer
The strip adds **no new top-level AX group** — its controls are the same
per-track Mixer Panel Group widgets (volume/pan/sends) noted above. Geometry:
~350pt tall, lanes compress to make room. Returns show Post sends, Main shows
cue/main out. Not shipping in v1 per SPEC — recorded for completeness.

### prefs-lookfeel (Settings window)
**12.4 has no "Look/Feel" tab** — SPEC/task name is stale. The page chooser is
an AXRadioGroup: **Display & Input · Theme & Colors · Audio · Link ·
Tempo & MIDI · File & Folder · Library · Plug-Ins · Record, Warp & Launch ·
Licenses & Updates** (captured Display & Input + Theme & Colors).
Display & Input: Language popup, **Zoom slider 50–200%**, Outline View in Focus,
Show Scroll Bars, Follow Behavior, Hide Labels, tab-navigation toggles,
Pen Tablet Mode, Permanent Scrub Areas, Draw MIDI Notes with Pitch Lock.
Theme & Colors: Theme=Default, Appearance=Follow System, **Tone=Warm** (the
warm palette is a theme tone — our tokens assume it), High Contrast=Off,
Grid Line Intensity / Brightness / Color Intensity / Color Hue sliders,
Auto-Assign Track Colors=On, Clip Color Assignment=Track Color.
Settings window ~555×612pt, modal-ish floating window. Closed without changes.

### device-view
Device panel is the fixed bottom panel ("Drop an Instrument or Sample Here" /
"Drop Audio Effects Here" for audio tracks). With clip view also open it
stacks beneath it. Empty chain = no device widgets exposed.

## 3. Range cheat-sheet (from AXMinValue/AXMaxValue)

Tempo 20–999 · SigNum 1–99 · SigDen 1–16 · Track volume 0.000316–1.995
(−70dB…+6dB) · Pan ±1 · Sends 0.000316–1 · Clip transpose ±48st ·
MIDI editor Transpose ±127 · Interval ±74 · Humanize 0–1 · Velocity tools
1–127 (deviation ±127) · Segment BPM 5–999 · Transient envelope 0–100 ·
Settings zoom 50–200%.

## 4. Remaining contradictions with SPEC.md (action list)

1. Zone model: add the 28pt titlebar row and the **~11pt arrangement overview
   strip**; control bar is 30pt not 28; bar ruler ~19pt not 15.
2. **Resolved by C007:** SPEC now places the elapsed-time ruler + h-zoom surface at
   the **bottom** of the lanes (~25pt combined), distinct from the top bar ruler.
3. Returns 20/19pt, Main 19pt (SPEC: 35/17).
4. Header column is **fixed 279pt** — no drag affordance found (2 attempts);
   drop the "~93pt collapsed" assumption for arrangement view.
5. Dock: device panel **fixed ~212pt**; clip panel min **226pt**, long
   drag-past-min **closes** the view; **Expanded Clip View** full-window mode
   exists and is sticky — none of this is in SPEC §7.
6. Clip view has tab groups (`Clip Tabs`: Main/Launch; `Tool Tabs`:
   Pitch&Time/Transform/Generate) — SPEC's static "note tools panel" description
   predates 12.x tabs.
7. Prefs tab is "Display & Input"/"Theme & Colors", not "Look/Feel".
8. Draw Mode menu title is "Draw Mode (Pitch Lock Off)"; ⌘B unreliable when
   the editor has focus — drive via the menu in automation.
9. Browser default 331pt (not 338), sidebar row 19.5pt (not 17),
   collapses to hidden when dragged left; max 1163pt.
10. `live-select` is lighter than specced — re-sample.
