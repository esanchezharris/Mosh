# Live 12 bundle + local-resource analysis (2026-08-06)

Local-only analysis of the installed Live 12 Suite 12.4.2. Nothing here copies Ableton
assets into the repo; this is a map of what exists and what it tells the clone.

## App bundle (`Ableton Live 12 Suite.app/Contents/Resources`)

Lean: icons, `.lproj` localizations, `Ableton Live Engine.bundle`, ReWire, and
`UiFrameworkMetalShaders.metallib` (their custom UI toolkit renders via Metal — confirms
the layout is code-driven, not declarative; AX dumping > resource mining for geometry).

**The cursor set is the complete gesture vocabulary** — 24 cursors ship as PNGs:

| Cursor | Gesture it encodes |
|---|---|
| DrawingPencil | draw mode (note/breakpoint painting) |
| Drag / DragCopy / NoDrag | move vs copy-drag (⌥) vs invalid target |
| DragLeftEdge / DragRightEdge | clip trim |
| StretchLeftEdge / StretchRightEdge | warp-stretch clip edges (distinct from trim!) |
| ResizeUp/Down/Left/Right WithBar | lane/dock/pane splitters |
| AddBreakpoint / Curve | automation: add point, bend segment |
| Chop / Slice / SliceFromEnd | audio slicing (Simpler) |
| In/OutMarker | clip start/end marker placement |
| Convert | drag-to-convert (audio→MIDI etc.) |
| ContextMenu / Speaker / Watch / Zoom | right-drag hint, audition, wait, zoom scrub |

For Mosh's clone this is the checklist of pointer affordances a Live user expects to
*see* — the cursor change IS the discoverability. Each maps to a region+gesture rule in
our gesture tables.

## User-level locations

- `~/Library/Preferences/Ableton/Live 12.4.2/` — `Preferences.cfg` (binary, private
  serialization; header `LivePreferencesT`), `Log.txt`, `PluginScanDb.txt`,
  `Library.cfg`, `UsageData.cfg`, `User Remote Scripts/`. No `Options.txt` (user never
  created one; it's the documented hidden-prefs override file — if we ever need Live
  behaviors toggled for comparison, that's the switch).
- `~/Library/Application Support/Ableton/Live Database/` — SQLite: files db +
  `Live-plugins-1.db` (their plugin catalog).
- `~/Library/Application Support/Ableton/Live 12.4.2/` — only `Unlock` (licensing).
  Skins are NOT user-facing files in Live 12 (built-in themes, chosen in Preferences →
  Look/Feel; the observed "Mid Dark"-family palette is what SPEC.md sampled).

## Mosh-relevant takeaways

1. **Our scan/catalog posture matches Live's** (persistent catalog + rescan), and our
   deep sweep covers what Live's scanner covers. Verified 2026-08-06: 817 catalog
   entries incl. the 23 moduleinfo-less VST3s (Valhalla×9, Vital, OTT, soothe2,
   FabFilter, Auto-Tune, Waves shells…).
2. Cursor affordances are a parity gap: Mosh shows grab/ew-resize in a few spots; Live
   distinguishes move/copy/trim/stretch/slice/draw per region. Cheap to adopt per-region
   `cursor:` rules in the live shell — fold into the W2 burn-down.
3. Nothing in the bundle gives the UI away structurally — the AX dump program
   (WIDGETS.md) is the right deep source, as planned.

## Appendix — Live 12 track-color palette (70 swatches, sampled 2026-08-06)

The header context menu's Colors grid is a custom-drawn control (not AX-exposed);
these were pixel-sampled from the open menu (`.cache/live-ref/_ctxcolors.png`).
Row order as displayed, 14 per row: bright / saturated / pastel / muted / deep.
Swatch names are not AX-exposed; values are what the clone's color menu needs.

`#f099a7` `#f2a948` `#c49b40` `#f7f48d` `#cbf94f` `#77fb58` `#79fbaf` `#8dfce8` `#97c3fa` `#5e7fdd` `#96a6f9` `#ca72de` `#d45d9e` `#ffffff`

`#eb4a41` `#e5742e` `#937451` `#fcf15e` `#a5fc7c` `#67c039` `#56bcaf` `#6de6fc` `#4ba1e8` `#367bbb` `#836ddd` `#ad7ac1` `#eb4cce` `#d0d0d0`

`#d36e60` `#f2a77c` `#cdae79` `#f0feb7` `#d5e3a0` `#becf7f` `#a3c392` `#dcfce3` `#d4f0f7` `#bbc1e0` `#cabce1` `#aa99e0` `#e3dce1` `#a9a9a9`

`#be948d` `#af845d` `#95846d` `#beba74` `#abbd3b` `#88af5a` `#94c0ba` `#a0b2c2` `#8ba4bf` `#8693c7` `#a296b3` `#baa0bc` `#b27595` `#7b7b7b`

`#a13d38` `#9e5639` `#6d5043` `#d7c440` `#889637` `#669d42` `#469a8e` `#356281` `#1f2e90` `#37519d` `#5e4ca7` `#9850a8` `#bc3d6d` `#3c3c3c`
