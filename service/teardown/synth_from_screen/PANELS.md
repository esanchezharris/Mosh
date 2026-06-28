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
| **Dynamic FX rack** | Serum FX tab, Vital EFFECTS tab | NOT fixed — knob positions shift with which effects are enabled + their order. `fx_rack.detect_fx_chain` reads **which effects are on + their order** off the rack list (power-dot colour, names from the profile's fixed order) | **chain-detect DONE** (Vital + Serum 1); per-effect *knob* reading still a next rung |
| **Modulation matrix** | Serum MATRIX, Vital MATRIX | tabular: rows of source → (bipolar/stereo/morph) → amount → destination. `matrix.read_matrix` reads each OCCUPIED row's amount + best-effort OCR; an empty Init matrix returns [] (no hallucination) | **structural reader DONE** (Vital); validated on the empty matrix + synthetic populated; real-populated calibration is a follow-up |
| **Settings / menus** | Serum GLOBAL, Vital ADVANCED | toggles + dropdowns + a few knobs; OCR labels + `read_toggle`/`read_menu` | low priority |

A prerequisite for all of the above — **page/tab detection** — is **BUILT** (`page_detect.py`):
`detect_active_tab(img, synth)` reads the active-tab indicator (Serum's green dot, Vital's
coloured underline) from the tab strip and maps it to the nearest tab anchor; `identify_synth`
picks the synth whose highlight is cleanest. Pure CV (no OCR), resolution-independent (the tab
strip is declared in each profile's `"tabs"` block in reference-pixel space, scaled like the
control coords), and verified 5/5 on the real committed panels (Serum OSC + all four Vital
tabs) plus synthetic strips. Calibrated synths: Serum 2, Vital (Serum 1 once installed).

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
- **FX**: dynamic rack (Hyper/Dimension, Distortion, Flanger, Phaser, Chorus, Delay,
  Compressor, Reverb, EQ, Filter). Each enabled effect shows its own knob set.
- **MIX**: per-oscillator level/pan mixer (Serum-2-only tab).
- **MATRIX**: mod-routing table. **GLOBAL**: global/voicing settings.
- ⚠️ **Constraint:** Serum has no standalone, so it's hosted in Mosh — and the hosted VST3
  editor does **not** accept synthetic tab clicks (both computer-use and raw CGEvent are
  swallowed by the editor NSView; the default page captures fine because that's read-only).
  So the **non-default Serum tabs can't be auto-navigated** for live calibration. Options:
  the owner navigates to a tab manually and we screencapture it, or we calibrate from a
  reference image (resolution-approximate until verified live).

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
7. **Serum 2 non-default tabs** — tab *detection* is done; still to add: Serum 2 `fx_list`
   (needs an FX-with-effects capture), the MIX-tab fixed-knob profile, a Serum `matrix` block.
   The Ableton-host route (accepts clicks) is proven.
8. **Vital filter DRIVE/MIX/KEY-TRK** — needs the filter ENABLED to read bright/unambiguous
   (dim+off on Init reads unreliably). Same for per-effect FX knobs.
