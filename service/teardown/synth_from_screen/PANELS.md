# §5b — Synth-GUI panel catalog (what can show up in a tutorial)

A visual reconnaissance of the synth GUIs the patch-reader (§5b) has to handle, so profiles
can be built for every page a tutorial might show — not just the default ENV row. Built from
**real captures of the installed plugins** (Serum 2 via the Mosh host, Vital standalone) plus
**reference study of Serum 1** (not installed on this machine).

Reference frames (own-captures of licensed plugins) live in `fixtures/panels/`. Recapture any
of them with the method in "Reproduction" below.

## The two knob readers (pick per synth)

Every knob is read by `controls.read_knob(...)` with a `pointer` mode in the profile:

- **`pointer="white"` (Vital).** Vital draws a **white pointer line** over a teal fill-arc. The
  reader isolates the colourless (low-chroma) pointer from the saturated arc, **skin-relative**
  (the pointer is the colourless feature deviating most from the knob's own body brightness,
  either polarity), so absolute values read correctly (full SUSTAIN ≈ 1.0).
- **`pointer="blue_tick"` (Serum 1 AND Serum 2).** Serum marks each value with a **saturated
  blue tick at the rim**, at exactly the value angle. The white read is fragile on **Serum 2's
  glossy skin** — a bright top-bevel highlight is low-chroma like the pointer, so its mass drags
  the centroid toward 12-o'clock and low values misread ~0.5. The blue tick is the *opposite*
  (high chroma) and sits cleanly in a rim annulus, so it reads every Serum knob (filter, OSC,
  ENV) correctly on both Serum versions. It **falls back to the white pointer** when no tick is
  found (a non-default Serum skin).

All three synths' profiles now carry **ENV ADSR + OSC + FILTER** knobs (`profiles/{vital,serum,
serum1}.json`), verified absolutely by `verify_synthgui.py` (SUSTAIN ≈ 1.0; pan/cutoff ≈ 0.5;
res/drive/wtpos ≈ 0; mix/rand ≈ 1; level high). Extending coverage further is "add more control
entries," not "write a new reader" — except for the dynamic/tabular pages noted below.

## Page types (and how the reader must treat each)

| Page type | Where | Reader strategy | Status |
|-----------|-------|-----------------|--------|
| **Fixed knob grid** | OSC/filter/ENV/LFO on the main page; always-visible ENV column | fixed (cx,cy,r) per control in the profile, `pointer="white"` (Vital) / `"blue_tick"` (Serum) | **ENV + OSC + FILTER DONE** for all 3 synths (verified) |
| **Dynamic FX rack** | Serum FX tab, Vital EFFECTS tab | `fx_rack.detect_fx_chain` reads **which effects are on + order** off the FIXED rack power-dot column (NOT the effect icon — that column shows the expanded panel, which STACKS by enabled-order and moves). `fx_params.read_fx_params` reads each enabled effect's **knobs**, computing its panel_top from the stack (base_y + Σ heights of enabled-before). | **chain-detect DONE** (Vital + Serum 1) + **per-effect KNOBS DONE v1** (Vital Chorus+Delay, stacking-proven). Other Vital effects + Serum 2's add-rack are follow-ups |
| **Modulation matrix** | Serum MATRIX, Vital MATRIX | tabular: rows of source → (bipolar/stereo/morph) → amount → destination. `matrix.read_matrix` reads each OCCUPIED row's amount + best-effort OCR; an empty Init matrix returns [] (no hallucination) | **DONE** (Vital + **Serum 2**, the latter calibrated cross-host via the logo landmark); validated empty→[] (incl. under a title-bar shift) + synthetic populated; real-populated value calibration is a follow-up |
| **Settings / menus** | Serum GLOBAL, Vital ADVANCED | toggles + dropdowns + a few knobs; OCR labels + `read_toggle`/`read_menu` | low priority |

A prerequisite for all of the above — **page/tab detection** — is **BUILT** (`page_detect.py`):
`detect_active_tab(img, synth)` reads the active-tab indicator from the tab strip and maps it to
the nearest tab anchor; `identify_synth` picks the synth whose highlight is cleanest. Pure CV (no
OCR), resolution-independent + **host-invariant** (the tab strip is declared in each profile's
`"tabs"` block in reference-pixel space, mapped onto the frame by the shared `calib` landmark —
so the band lands on the dots row regardless of the host's title-bar height). The active-indicator
detection is **hue+saturation AGNOSTIC** (`highlight: "bright"` for Serum): Serum's active-tab dot
renders GREEN (Mosh/standalone), BLUE (Ableton), or WHITE (the MIX tab) — same plugin,
host/page-dependent — so only *brightness* is invariant (the active dot is brighter than the dim
grey inactive dots); Vital's saturated underline stays `"saturated"`. Verified on **all 13 real
committed panels** — Serum 2's full five tabs across both Mosh and Ableton, Serum 1's four,
Vital's four — plus synthetic strips.

**Host-invariant calibration** (`calib.py`) is the load-bearing layer under every reader. The host
title bar is chrome that TRANSLATES the synth content (Mosh's Serum window is ~26px taller than
Ableton's at full res), so pure proportional scaling (`frame_h/ref_h`) smears that shift over the
height and mislabels knobs near the top (e.g. a 40px title-bar delta drives filter_res 0.094→0.351,
filter_drive 0.0→0.318 — a mislabel sets the WRONG param, worse than no profile). `calib` detects
the synth's own **logo** (top-left, below the chrome, present on every page, accent/preset-invariant)
via `cv2.matchTemplate` against a bundled `profiles/<synth>.logo.png`, and maps every control as
`coord*s + (dx,dy)` relative to where the logo actually landed (width is chrome-free → `s =
frame_w/ref_w`; the matched `dy` carries the title-bar offset; `dx≈0` gates match validity). All
four loaders (`export.load_profile`, `page_detect`, `fx_rack`, `matrix`) route through it; pass the
frame image to enable it, omit it for the byte-identical legacy proportional fallback (so it's a
strict generalization — identical reads when the frame preserves the reference aspect, corrected
reads only across hosts). Proof (hermetic): a simulated 20/40px title-bar shift on serum_init →
host-invariant recovers knobs with max|Δ|=0.000 vs proportional 0.164/0.318.

## Serum 2  (installed — real captures)

Tabs: **OSC · MIX · FX · MATRIX · GLOBAL** (Serum 2 added MIX vs Serum 1). Dark but **glossy**
skin (the bevel-highlight that forced the `blue_tick` reader).
- **OSC** (`fixtures/panels/serum2_osc.png`): OSC A/B/C + SUB + NOISE across the top; FILTER
  1/2 on the right; a row of fixed knobs per oscillator (WT POS, UNISON [number box], DETUNE,
  BLEND, PAN; **dual** WARP1/WARP2 + LEVEL) and per filter (CUTOFF/RES/PAN over DRIVE/FAT/MIX,
  plus a vertical LEVEL slider); ENV 1 ADSR (ATK/HOLD/DEC/SUS/REL — **no DELAY knob**) + LFO row
  at the bottom; MACROS column on the left. **DONE in `profiles/serum.json`:** ENV 1 + OSC A
  (wtpos/detune/blend/pan/warp1/warp2/level) + FILTER 1 (cutoff/res/pan/drive/fat/mix), all
  `blue_tick`. UNISON (a voices number-box) and PHASE/RAND (tiny header value-displays) are
  omitted; the filter LEVEL slider isn't a knob. The OSC/filter coords were captured full-res
  via **Ableton** (the Mosh-host editor doesn't accept tab clicks) and converted into the
  Mosh-window reference space (the two windows differ only by a ~25px title-bar offset: same x,
  Mosh cy = Ableton cy + 25), so they verify against the committed Mosh-captured fixture.
- **The non-default tabs were captured LIVE via Ableton** (its hosted editor accepts tab clicks;
  the Mosh-hosted editor swallows them) and committed as fixtures (`serum2_{fx,mix,matrix,
  global}.png`). Each is structurally DIFFERENT from Serum 1 / Vital and needs its own reader —
  none is a clean fixed-knob grid, so no per-tab control profile was added (see the cross-host
  note below for why coords aren't shipped yet):
  - **FX** (`serum2_fx.png`): NOT a fixed 9-effect list (unlike Serum 1) — it's a **dynamic
    "+ FX" add-rack** with MAIN / BUS 1 / BUS 2 buses; you ADD effect modules (empty on Init).
    So `fx_rack.detect_fx_chain` (fixed-list) does NOT apply to Serum 2 — it needs an
    added-module reader (detect each inserted effect module + its bus). `serum.json` has no
    fx_list (correct: detect_fx_chain returns []).
  - **MIX** (`serum2_mix.png`): per-source channel strips (SUB/OSC A/B/C/NOISE/FILTER 1/2/BUS),
    each a FILTER-routing dropdown + small BUS/PAN knobs + a **vertical FADER** + level meter.
    The faders are the main control → needs a vertical-slider reader (matrix.py has a *horizontal*
    one). PAN knobs are readable but tiny.
  - **MATRIX** (`serum2_matrix.png`): a clean routing TABLE — SOURCE | CRV | AMOUNT (horizontal
    slider) | POL | DESTINATION | OUT | AUX SOURCE | INV, 16 rows (8 cleanly visible in the
    fixture), all empty on Init. **DONE in `profiles/serum.json` (`matrix` block):** calibrated
    from this Ableton capture but stored in the Mosh reference space — **host-invariant calibration
    bridges the title-bar offset** so the same coords read either host. The AMOUNT slider x0/x1 are
    symmetric about the centered (neutral 0.5) handle so an Init row reads inactive; the source/dest
    cells are deliberately narrow to EXCLUDE the saturated CRV curve thumbnails and the blue POL
    arrow (which would otherwise read as 'occupied' and hallucinate a routing). Validated:
    `read_matrix → []` on the empty Init matrix (no hallucination), AND still `[]` under a simulated
    20px title-bar shift (proportional scaling would slide the rows onto the graphics → false rows).
    Per-row AMOUNT *value scale* + rows>8 await a POPULATED Serum 2 matrix capture.
  - **GLOBAL** (`serum2_global.png`): global/voicing settings (toggles + dropdowns) — low value.
- ✅ **Cross-host calibration — SOLVED** (was the blocker for matrix/MIX). The Serum 2 OSC/filter/
  matrix coords live in the **Mosh** window reference space (`reference_size [2380,1544]`); the
  Ableton-hosted window is shorter (a ~1.7% shorter title bar). **Host-invariant calibration**
  (`calib.py`, see above) now detects the SERUM 2 logo landmark and offsets all coords relative to
  it, so a block measured from an Ableton capture reads correctly from BOTH hosts. This unblocked
  the `matrix` block (done) and the MIX vertical-fader block (a remaining reader, not a calibration
  blocker anymore).

## Vital  (installed — real captures, all tabs)

Tabs: **VOICE · EFFECTS · MATRIX · ADVANCED**. Dark skin. The **ENV/LFO modulator column on
the right is visible on every tab** → the ADSR profile is robust regardless of page.
- **VOICE** (`vital_voice.png`): OSC 1/2/3 + SMP (sampler), each with a wavetable display,
  UNISON/PHASE knobs, LEVEL/PAN, FILTER; two filters at the bottom; ENV 1 ADSR
  (DELAY/ATTACK/HOLD/DECAY/SUSTAIN/RELEASE) + LFO on the right. **DONE in `profiles/vital.json`:**
  ENV 1 + OSC 1 (level/pan/unison/phase), all `pointer="white"`.
  - ⚠️ **Vital's filter CUTOFF/RES are GRAPH-DRAG, not knobs** — you set them by dragging the
    filter response graph (X=cutoff, Y=resonance). They're graphic params (→ §8's domain), NOT
    white-pointer-readable. The filter module's only *knobs* are DRIVE/MIX/KEY-TRK (dim unless
    the filter is enabled), so Vital has no profilable cutoff/res knob — unlike Serum, where
    cutoff/res ARE knobs. (This is *why* Serum is the high-value filter-knob target.)
- **EFFECTS** (`vital_effects.png`, shown with Chorus+Delay enabled): dynamic rack — Chorus,
  Compressor, Delay, Distortion, EQ, Filter, Flanger, Phaser, Reverb. Enabled modules expand
  inline to their knobs (FEEDBACK/MIX/DEPTH/CUTOFF/SPREAD…). Positions depend on what's on.
- **MATRIX** (`vital_matrix.png`): SOURCE/BIPOLAR/STEREO/MORPH/AMOUNT/DESTINATION table + a
  Mod-Remap curve.
- **ADVANCED** (`vital_advanced.png`): per-oscillator advanced (unison stack, detune range,
  stereo/table spread), VOICE (round-robin, note priority, tuning), OVERSAMPLING, DISPLAY.
- Vital standalone **does** accept synthetic clicks → fully auto-navigable for live capture.

## Serum 1  (installed — LIVE captures via Ableton)

The original Serum (lots of tutorials still use it). **4 tabs: OSC · FX · MATRIX · GLOBAL**
(no MIX tab, vs Serum 2's 5); active tab marked by a **blue** dot. Same white-pointer knobs.
Captured live from the installed plugin **hosted in Ableton Live** — Mosh's in-process host
*crashes* on Serum 1 (`com.xfer.serum.VST3`; a real hosting bug, not licensing), but Ableton
hosts it fine **and accepts synthetic tab clicks** (unlike Mosh's hosted editor), so all four
tabs were navigated + captured. The installed skin is **dark** (not the lighter grey of old
web screenshots). `profiles/serum1.json` is calibrated: ENV 1 ADSR (ATTACK/HOLD/DECAY/SUSTAIN/
RELEASE — no DELAY) reads absolutely (SUSTAIN 1.000) and all 4 tabs detect.
- **OSC**: OSC A + OSC B (2 oscillators vs Serum 2's 3) + SUB + NOISE + one FILTER; ENV + LFO.
  **DONE in `profiles/serum1.json`:** ENV 1 + OSC A (detune/blend/phase/rand/wtpos/warp/pan/
  level) + FILTER (cutoff/res/pan/drive/fat/mix), all `blue_tick`. Calibrated full-res live via
  Ableton. UNISON is a voices number-box (omitted). Single WARP (vs Serum 2's dual).
- **FX**: dynamic rack (Hyper/Dimension, Distortion, Flanger, Phaser, Chorus, Delay,
  Compressor, Reverb, EQ, Filter) — same structure as Serum 2's FX.
- **MATRIX / GLOBAL**: routing table / global settings.
- 💡 Ableton-as-host accepts clicks → the same route can capture **Serum 2's** non-default tabs
  (FX/MIX/MATRIX/GLOBAL) that Mosh's editor blocked.

## Synth identification

`page_detect.detect_active_tab(img, synth)` (synth KNOWN — from §4's plugin-name OCR) is the
load-bearing, reliable API (verified on all 9 real panels). `identify_synth(img)` (synth
UNKNOWN) is **best-effort** — it can cross-match visually-similar plugins at low resolution, so
the pipeline should pass the known synth rather than rely on vision-guessing the synth.

## Reproduction (how these were captured)

- **Vital** (standalone, auto-navigable): `open -a Vital`; computer-use clicks the tab
  (VOICE/EFFECTS/MATRIX/ADVANCED); `screencapture -x -o -l<windowId>` grabs the clean window
  (Quartz window id by owner "Vital"). For EFFECTS, enable a module first to expose its knobs.
- **Serum 2** (hosted, default page only): `Mosh --demo3` loads Serum 2 + opens its editor;
  `screencapture -l<id>` of the "Serum 2" window. Non-default tabs need manual navigation
  (see the constraint above).
- `verify_synthgui.py` reads the committed fixtures and asserts absolute values for the ENV
  ADSR **and** the OSC/FILTER knobs (hand-labeled bounds: pan/cutoff ≈ 0.5, res/drive/wtpos ≈ 0,
  mix/rand ≈ 1, level high) — real proof the new coords + readers recover correct positions.

## Next rungs (in priority order)

1. ~~**Tab/page detection**~~ — **DONE** (`page_detect.py`).
2. ~~**Serum 1 profile**~~ — **DONE** (live via Ableton; ENV + tabs calibrated, verified).
3. ~~**OSC + FILTER profiles** for all three synths~~ — **DONE** (ENV + OSC + FILTER; Serum via
   `blue_tick`, Vital via `white`; Vital's cutoff/res are graph-drag so only its OSC knobs apply).
4. ~~**More oscillators**~~ — **DONE**: Serum 1 OSC B + SUB + NOISE; Serum 2 OSC B/C + NOISE;
   Vital OSC 2/3 LEVEL/PAN (read skin-relative even when dim/off). Number-box controls (UNISON
   voices, SUB OCTAVE, Serum-2 NOISE START/RAND) omitted.
5. ~~**Rack-aware FX reader (chain detect)**~~ — **DONE** (`fx_rack.detect_fx_chain`): which
   effects are on + order, for Vital + Serum 1. Per-effect *knob* reading (read each enabled
   module's knobs via a per-effect-type sub-profile) is the remaining depth.
6. ~~**Matrix table reader (structural)**~~ — **DONE** (`matrix.read_matrix`): per-row amount +
   best-effort OCR, empty→[]. Calibrate against a REAL populated matrix (add routings via the GUI)
   to confirm the active-row thresholds beyond the synthetic test.
7. ~~**Serum 2 non-default tabs — capture**~~ — **DONE**: FX/MIX/MATRIX/GLOBAL captured live via
   Ableton + committed as fixtures + characterized (see the Serum 2 section). Each needs its own
   reader: FX = added-module reader (dynamic +FX rack, not the fixed list); MIX = vertical-fader
   reader; MATRIX = the existing `read_matrix` (the Serum 2 `matrix` block is now calibrated — see 8).
8. ~~**Host-invariant calibration**~~ — **DONE** (`calib.py`): a logo-landmark template match
   offsets every control's coords relative to where the synth's own logo actually landed, so one
   profile reads correctly regardless of the host's title-bar height. All four readers
   (`export`/`page_detect`/`fx_rack`/`matrix`) route through it; graceful proportional fallback when
   no image/landmark. **Unblocked + landed:** the Serum 2 `matrix` block (empty→[] host-portably);
   fixed page-detect's green-only hue bug → all 5 Serum 2 tabs detect across Mosh+Ableton.
9. **Serum 2 MIX vertical-fader reader** — DEFERRED (lower marginal value): the MIX faders largely
   DUPLICATE the already-profiled OSC-page LEVEL knobs; the unique part is per-channel bus/pan
   routing. Needs a new vertical-slider reader + 8-channel calibration (handle-vs-meter-vs-dB-tick
   disambiguation). No longer calibration-blocked. Pick up if bus/pan routing is needed.
10. ~~**Per-effect FX knob reading**~~ — **DONE v1** (`fx_params.read_fx_params`, calibrated LIVE):
   reads an enabled effect's knobs, modeling Vital's DYNAMIC panel STACK
   (panel_top = base_y + Σ heights of enabled-before, in rack order). **Chorus + Delay** calibrated
   + stacking-proven (Delay reads identically stacked-below-Chorus vs alone-at-top). Building this
   ALSO uncovered + fixed a real `detect_fx_chain` bug (it sampled the moving panel column, not the
   fixed rack power-dot — misread Delay-alone as Chorus). Follow-ups: the other 7 Vital effects;
   Serum 2's FX is a DIFFERENT shape (a dynamic "+FX" add-rack with bus assignment, empty on Init —
   needs an added-module reader, not this fixed-rack model).
11. ~~**Vital filter DRIVE/MIX/KEY-TRK**~~ — **DONE** (calibrated LIVE: enabled FILTER 1, read
   defaults DRIVE 0 / MIX 1.0 / KEY-TRK 0.5 + a drag → 0.81 to prove tracking). vital.json + fixture
   vital_filter_on.png. Read only when the filter is enabled.
12. ~~**Populated-matrix value calibration**~~ — **DONE for Serum 2** (added a Mod-Wheel routing
   LIVE: read_matrix []→[1 routing], OCR'd source, amount 0.50→0.79; rows=8 confirmed required, not
   conservative — 16 hallucinates from the bottom UI). Vital populated-matrix + raising Serum 2
   rows>8 (needs a scrolled/taller matrix capture) remain.
