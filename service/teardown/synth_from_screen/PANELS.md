# §5b — Synth-GUI panel catalog (what can show up in a tutorial)

A visual reconnaissance of the synth GUIs the patch-reader (§5b) has to handle, so profiles
can be built for every page a tutorial might show — not just the default ENV row. Built from
**real captures of the installed plugins** (Serum 2 via the Mosh host, Vital standalone) plus
**reference study of Serum 1** (not installed on this machine).

Reference frames (own-captures of licensed plugins) live in `fixtures/panels/`. Recapture any
of them with the method in "Reproduction" below.

## The one thing that's universal: the white-pointer knob

Serum 1, Serum 2 **and** Vital all draw a knob as a **white pointer line** over a coloured
arc/tick (teal in Vital, blue in Serum). That means `controls.read_knob(..., pointer="white")`
— which isolates the colourless pointer from the saturated arc — is the correct reader for
**every** knob on **every** page of **all three** synths. The isolation is **skin-relative**
(the pointer is read as the colourless feature deviating most from the knob's own body
brightness, either polarity) so it works on dark-bodied knobs (Vital / Serum 2) AND lighter
skins / dark-on-light pointers (Serum 1) without assuming an absolute brightness. The ENV-ADSR profiles
(`profiles/vital.json`, `profiles/serum.json`) already use it and read absolute values
correctly (full SUSTAIN ≈ 1.0). Extending coverage is "add more control entries," not "write a
new reader" — except for the dynamic/tabular pages noted below.

## Page types (and how the reader must treat each)

| Page type | Where | Reader strategy | Status |
|-----------|-------|-----------------|--------|
| **Fixed knob grid** | OSC/filter/ENV/LFO on the main page; always-visible ENV column | fixed (cx,cy,r) per control in the profile, `pointer="white"` | ENV done; OSC/filter **buildable now** from the captures |
| **Dynamic FX rack** | Serum FX tab, Vital EFFECTS tab | NOT fixed — knob positions shift with which effects are enabled + their order. Must (1) detect each enabled effect's header (label OCR + colour highlight), (2) read its knobs *relative* to that module's box | **needs a rack-aware reader** (next rung) |
| **Modulation matrix** | Serum MATRIX, Vital MATRIX | tabular: rows of source → (bipolar/stereo/morph) → amount → destination. Read with OCR + the amount knob/field, not knob-angle CV | **needs a table reader** |
| **Settings / menus** | Serum GLOBAL, Vital ADVANCED | toggles + dropdowns + a few knobs; OCR labels + `read_toggle`/`read_menu` | low priority |

A prerequisite for all of the above — **page/tab detection** — is **BUILT** (`page_detect.py`):
`detect_active_tab(img, synth)` reads the active-tab indicator (Serum's green dot, Vital's
coloured underline) from the tab strip and maps it to the nearest tab anchor; `identify_synth`
picks the synth whose highlight is cleanest. Pure CV (no OCR), resolution-independent (the tab
strip is declared in each profile's `"tabs"` block in reference-pixel space, scaled like the
control coords), and verified 5/5 on the real committed panels (Serum OSC + all four Vital
tabs) plus synthetic strips. Calibrated synths: Serum 2, Vital (Serum 1 once installed).

## Serum 2  (installed — real captures)

Tabs: **OSC · MIX · FX · MATRIX · GLOBAL** (Serum 2 added MIX vs Serum 1). Dark skin.
- **OSC** (`fixtures/panels/serum2_osc.png`): OSC A/B/C + SUB + NOISE across the top; two
  FILTER columns on the right; a row of fixed knobs per oscillator (PAN, WT POS, UNISON,
  DETUNE, BLEND, WARP, LEVEL) and per filter (CUTOFF, RES, DRIVE, FAT, PAN, MIX); ENV 1 ADSR
  (ATK/HOLD/DEC/SUS/REL — **no DELAY knob**) + LFO row at the bottom; MACROS column on the
  left. **All fixed-position → directly profilable** (the ENV row already is).
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
  (DELAY/ATTACK/HOLD/DECAY/SUSTAIN/RELEASE) + LFO on the right. Fixed-position.
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
- `verify_synthgui.py` reads the committed ENV fixtures and asserts absolute ADSR values.

## Next rungs (in priority order)

1. ~~**Tab/page detection**~~ — **DONE** (`page_detect.py`; see above).
2. ~~**Serum 1 profile**~~ — **DONE** (live via Ableton; ENV + tabs calibrated, verified).
3. **OSC + FILTER profiles** for all three synths from the captures (fixed knobs, white-pointer)
   — the highest-value still-buildable-now addition (filter cutoff/res/drive and osc
   unison/detune are ubiquitous in tutorials). The white-pointer reader is verified on Serum's
   OSC knobs; the careful part is correct knob↔label mapping (dense layout — do it methodically).
4. **Rack-aware FX reader** (detect enabled-effect headers → read knobs relative to each) for
   the dynamic FX pages of all three synths.
5. **Matrix table reader** (OCR routing rows).
6. **Serum 2 non-default tabs** — re-capture via Ableton (accepts clicks) to calibrate FX/MIX/
   MATRIX/GLOBAL the same way as Serum 1.
