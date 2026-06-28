# Teardown lane — REAL-path verification runbook

The hermetic suite (`python3 service/teardown/verify.py`, 14 components ×3 deterministic)
proves the **logic**. The verifiers below prove the lanes on **real hardware + real data**
— the built Mosh binary, installed Serum/Vital, a real music encoder (MERT), and real
YouTube tutorials. Each is **gated**: absent its resource it SKIPS cleanly (exit 0), so it
never breaks the deterministic suite. This mirrors `scripts/verify-hardware/`.

## Setup

```bash
# base lane (numpy/librosa/soundfile/pydantic) + the optional rungs you need:
service/teardown/setup-teardown.sh --with-reward     # §11 MERT encoder (torch+transformers)
service/teardown/setup-teardown.sh --with-video --with-sourcing   # §4/§13 (cv2/whisper/yt-dlp; needs brew ffmpeg+tesseract)
service/teardown/setup-teardown.sh --with-extract    # §7 demucs
# run.sh sources service/teardown/.teardown.env (TEARDOWN_PY); the venv + env are gitignored.
```

The binary is auto-detected at `/Applications/Mosh.app/Contents/MacOS/Mosh` (override with
`MOSH_BIN`). The sample library defaults to `~/Downloads/musica` (override `MUSICA_ROOT`).

## The proofs (measured 2026-06-27, this machine)

| § | Verifier | What it proves | Result |
|---|----------|----------------|--------|
| 8 | `synthmatch/verify_live.py` | CMA-ES recovers a known **Serum** patch via render-in-the-loop, scored in the §6 embedding space; params reported by NAME (describe_plugin) | screen → "Bypass"(idx18, swing 0.97) + "Main Tuning"(idx3, 0.16); seed dist **0.93 → ~0.00** in 90 real renders; dominant err **0.051**. (describe_plugin revealed the top screen param is the Bypass toggle — a real diagnostic.) |
| 8-sub | `synthmatch/verify_substitute.py` | the **substitute** regime (§13: core) — approximate a FOREIGN synth's tone (Vital) with an OWNED synth (Serum) | default-patch dist **0.987 → ~0.00** (Serum approximated the Vital tone); `status=substituted` |
| 9 | `render/verify_execute.py` | a Recipe compiles → MoshOps → **non-silent render** + measured `yield.actual` written back | 10/10 cmds ok, rms **0.209**, MIDI resolved from SMF, yield.overall **0.889**, class `inferred` |
| 9-synth | `render/verify_synth_execute.py` | §9 loads a synth **by name** + sets patch params **by name** (via `describe_plugin`) + MIDI → audible synth line | Serum loaded, **2 params set by name** (Main Vol/Main Tuning), MIDI resolved, rms **0.038**, yield **0.833** |
| 7→9 | `render/verify_extraction.py` | the EXTRACTION-regime spine (anchor corpus): real loop → §7 slice → §1 match → §9 **timeline** reconstruction | 9 hits → 9/9 matched → **9 clips on the timeline**, non-silent rms **0.206** |
| sys | `system_smoke.py` | WHOLE chain end to end (DRUM path): build→§7→§1→§9 render→§12 reward | **5/5 legs** green (pull 0.576) |
| sys+synth | `teardown_e2e.py` | WHOLE chain incl. the SYNTH path the orchestrator never wired: §5 piano-roll→MIDI + **§5b GUI→patch (`render/from_screen.py`)** + §7/§1 drums → §9 render → §12 reward. Proves a GUI read DRIVES the synth (the §5b control→plugin param-name alias in `profiles/<synth>.json#plugin_params`) | **9/9 legs** green: §5b **17/17 params APPLIED** (`set_plugin_param` ok 17/17, was 0/17 — name mismatch), Vital renders non-silent (rms 0.11), reward 0.68; A/B read-vs-contrast patch diff-RMS **0.031** (params audibly drive the sound) |
| 4→5b | `render/verify_enrich_render.py` | the §4→§5b AUTO-WIRING is load-bearing: a SKELETON synth element exactly as §4 emits it (plugin OCR-named "Vital", status 'unknown', **no params**) is upgraded by `enrich_synths_from_frames` reading the Vital GUI off a keyframe (committed `vital_init.png`), then rendered on the real engine. A/B on the binary | **A** (raw skeleton) → synth does NOT load (`synths_loaded 0`, params 0); **B** (after enrich) → `synths_loaded 1`, **17 params applied**, non-silent (yield.synth 0.5). So the seam, not luck, makes the synth play. (Constrained, never-blind detection + an ambiguity guard make "never mislabel" a code invariant — see `enrich_from_screen_test.py`.) |
| 4→5+5b | `render/verify_screen_to_synth.py` | the FULL screen→synth-AUDIO chain: a §4 skeleton synth element, fed ONLY by screen reads, plays on the real engine. §5b enrich reads the Vital GUI → params; **§5 reads a piano-roll keyframe → MIDI attached** (`midi_from_frames` + the new `piano_roll_present` bbox + a fine-grid gate that rejects DAW-arrangement views); §9 loads Vital, applies the params, plays the notes | **PASS** — from screen reads alone: 17 params + 4 notes → Vital `synths_loaded 1`, `notes_resolved 1`, non-silent (yield.synth 0.5, midi 1.0). MIDI marked status='partial', conf 0.4 (honest: pitch carries the roll's scroll offset; rhythm is reliable). §2 also gained VISUAL synth naming (`name_synths_in_frames`) so a synth GUI names the plugin when OCR can't read the logo (uniqueness-gated, clean-GUI only). |
| 3 | `sourcing/score.py:validate_yield` (wired in `orchestrate/cli.py`) | the §3 honesty guard: a metadata `yield.predicted` (now populated on every direct-URL teardown via `predicted_from_skeleton`) is compared to §9's `yield.actual`; an over-prediction the reconstruction didn't deliver is flagged, never a silent pass. **CRITICAL:** a render that RAN but produced nothing (actual all-zero) is the MAXIMAL overconfidence and IS flagged — only a never-executed recipe is 'unrendered' (a live run exposed + drove this fix) | LIVE `rnXWr3yhb4o`: predicted overall 0.5 vs actual 0.6875 → **calibrated** (recovered MORE than predicted, correctly not flagged); the emit carries `yield_validation` + an overconfident case appends an Unresolved note to the recipe. Deterministic guards in `sourcing_test.py` (overconfident / calibrated / unscored / unrendered / RAN-but-silent→overconfident). |
| 5b-emb | `synth_from_screen/calib_test.py` | host-invariant calibration now works on an EMBEDDED plugin window (smaller/anywhere in a DAW screenshot), not just a full-screen capture — `compute_calibration` is multi-scale + translation-tolerant (downscaled coarse search → full-res refine; strict 0.78 score; geometric-fit gate) | embedded Vital/Serum read **0.98–1.0** (was 0.51, below the 0.6 gate — the binding live-synth blocker); full-screen unchanged (1.0); rich-texture + gray non-GUI frames → no spurious calib. Closes the "embedded window" live gap. |
| 5-pitch | `midi_from_screen/midi_from_screen_test.py` | §5 absolute-pitch anchor: detect_axes now reads the piano-keyboard GUTTER (the black-key C#/D#/F#/G#/A# pattern is unique → its phase fixes which rows are C) to recover the correct pitch CLASS, instead of assuming a fixed top row (84) → arbitrary wrong note names. Also fixed `_period` (a 1px grid line = 2 Canny edges → row_h read 8 not 10; now clusters a line's edges → correct period, helps pitch AND timing) | a gutter roll with top row G recovers class G; a C5 note reads C (exact when near the default); WITHOUT the anchor the same note reads the WRONG class (anchor is load-bearing); gutter-less roll → keeps the honest default (no false anchor). HONEST scope: recovers pitch CLASS (note names/intervals); absolute OCTAVE needs a label (not OCR-free) so it's anchored near the default. |
| 5b-serum | `render/from_screen_test.py` + a real-binary render | the **Serum `plugin_params` alias** (built from `describe_plugin`: Serum 1 = 319 params, Serum 2 = 543) — every alias value VALIDATED to be a real param name, so a §5b Serum read now drives a render (was dropped) | Serum 2 read **34 params → 34 SET**; Serum 1 read **32 → 32 SET**; both load + render non-silent on the binary. filter_pan/filter_fat omitted (Serum's stereo/var don't unambiguously match the visual pan/fat — dropped rather than mislabel). |
| 11 | `flywheel/train_reward.py [N]` / `verify_reward.py` | train + save the MERT reward head; held-out ordering on **disjoint (unseen) timbres** | **combined (spectral+timing): MERT 0.970 vs eng 0.909**; spectral-only MERT 0.933/0.867; timing-only MERT 1.000/0.938 (`train_reward_musical.py`) — MERT wins every axis |
| 5b | `synth_from_screen/verify_synthgui.py` | read patches off REAL synth GUIs via calibrated profiles — **Vital** (`profiles/vital.json`, captured from the standalone) AND **Serum 2** (`profiles/serum.json`, captured via the Mosh host: `Mosh --demo3` → `open_plugin_editor` → screencapture the 'Serum 2' window). The **white-pointer** reader isolates the colourless pointer line from the colour fill-arc → ABSOLUTE accuracy | both ENV1 ADSRs: **SUSTAIN reads ~1.000** (full on the Init patch, was 0.593 when the arc masked it), at-min knobs ~0.000, conf 0.75. `<SYNTH>_LIVE_CAPTURE=1` re-captures live |
| 13 | `measurement_checkpoint.py [N]` | readability census over real tutorials — how often DAW/piano-roll/synth-GUI are seen → **scopes §8** | n=8: piano-roll **88%**, synth GUI **50%**, DAW id **0%** → "mixed regime; §8-substitute is core" |
| 4 | `video2recipe/cli.py --url <id> --section A B` | a real tutorial → schema-valid Recipe skeleton (frames + OCR + scenes) | e.g. `fw4Ms26mdmc` → piano-roll + "Pigments" detected, valid recipe |
| 10 | `orchestrate/cli.py --url <id> --render` | the conductor now runs §4→§7→§1→§9-compile→**§9-execute (render)→§12-score** (new `render`/`score` stages); `teardown()` produces a real Edit + reward, not just commands. §4's skeleton now auto-calls `enrich_synths_from_frames` (§4→§5b) so an OCR-named synth gets its params read off the keyframes | (a) injected-real proof: stages …→render→score, non-silent (yield.actual.overall 0.83, **synth_params_set 17**), reward pull 1.0. (b) **LIVE** (`0XwRho1x1L0`, 12 s): drums render non-silent rms 0.165, yield 0.59. (c) **LIVE Vital tutorial** (`rnXWr3yhb4o`, 35 s): full chain ran, drums non-silent rms **0.149**; `synths_loaded 0` — diagnosed honestly: the embedded DAW frame shows Vital but §2 OCR **didn't name it** (no synth element to upgrade) AND the GUI read only **0.55** confidence (below the 0.6 safety gate, vs 1.00 on the standalone capture). The screen-read WIRING is now complete + proven load-bearing on the binary (§5b params `verify_enrich_render.py`; §5 MIDI + full chain `verify_screen_to_synth.py`; §2 visual naming `name_synths_test.py`). (d) **LIVE SUCCESS** (full-screen Vital tutorial `0IF60i5uuhc`, 40 s): `synths_loaded 0 → 1` on real input — OCR read neither DAW nor logo, so **§2 visual naming created the Vital element from the GUI**, then **§5b enrich read 17 real params** (`synth_0 plugin=Vital status=params_visible nparams=17`, e.g. `envelope 1 hold 0.686`) → Vital loaded at §9. The earlier `rnXWr3yhb4o` 0.55-confidence miss was an EMBEDDED/small window — full-screen reads clear the 0.6 gate, as predicted. (In this section the §5 MIDI conservatively no-op'd — no clean piano-roll visible — so the synth is loaded+configured but silent there; audible synth live needs a section showing the roll too.) Remaining live limit: detection confidence on embedded/small GUIs + heuristic §5 note transcription on real DAW frames — both §5b/§5 calibration, not wiring. Not faked. |

**Reward-head training note:** held-out is on **disjoint sample pools** (train/test timbres never overlap) — an earlier mix-only split leaked timbres and *understated* MERT's edge; the honest disjoint numbers above are stronger. MERT beats the engineered baseline on both the spectral (sample-swap) and the musical (micro-timing/groove) axis, where engineered features are largely blind. The trained head saves to `reward_head.json` (gitignored) and loads as the §12 `Reward` pull via `TrainedRewardHead`.

Run any of them with the teardown python, e.g.:

```bash
source service/teardown/.teardown.env
PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/verify_reward.py
PYTHONPATH=service python3 service/teardown/synthmatch/verify_live.py   # uses /Applications binary
PYTHONPATH=service python3 service/teardown/render/verify_execute.py
```

## Known gaps (the next rungs, deliberately deferred)

- **`describe_plugin` MoshOps command — LANDED.** `describe_plugin {trackId,index,limit} →
  params[{index,name,value}]` (uncapped; Serum 2 exposes 543) is now a read-only command.
  §8 reports recovered patch params by NAME, and §9 resolves synth load + param-name→index
  mapping (see 9-synth above). Verified: selftest **1036/1036 ×3** (the new check guards a
  catalog-present run), vitest **591**, functional Serum probe + the §9-synth proof. Built
  into `build-macos-arm64-release` (not yet deployed to /Applications — `run-mosh.sh deploy`
  to ship it).
- **§9 timeline placement — LANDED.** `Element.onsets` + per-onset clips on one track
  (`from_extraction.py` groups §7 slices); proven end-to-end (verify_extraction.py).
- **§5b knob VALUES — CALIBRATED + ABSOLUTE (Vital + Serum 2).** `profiles/vital.json` and
  `profiles/serum.json` from real GUI captures (Serum via the Mosh host's `--demo3` editor pop-out
  — the no-standalone path). The **white-pointer** read (bright + low-saturation pointer line,
  ignoring the colour fill-arc) fixed the absolute accuracy: a full SUSTAIN now reads ~1.0 instead
  of ~0.5 (the fill-arc's centroid trap). `verify_synthgui.py` asserts both synths' ENV1 ADSR
  absolutely (sustain ~full, at-min knobs ~0, conf 0.75). Remaining: more controls per synth
  (oscillator/filter pages), graphic/curve params (still §8-refined), more synths via profiles.
- **§1 role classifier — BAND-ENERGY rewrite.** Replaced the single-centroid rule (which dumped
  ~52% of real one-shots to "other" and collapsed overlapping loop slices) with per-band energy
  fractions on the attack transient + a dominant-band fallback. On a 566-file real-library sample
  the **"other" rate fell from ~52% → 0.5%**; kick-vs-808 now split by a sustain ratio (an 808
  rings, a kick decays) so real kick one-shot files no longer all mis-read as 808; overlapping
  mixtures (kick+hat → kick, snare+hat → snare) classify by their foundation instead of "other".
  Guarded in `drummatch_test.py` (mixture cases + the silent→other invariant).
- **Teardown UI — LANDED.** v2 browser-drawer "Teardown" tab (`TeardownPanel.tsx`) +
  `teardown_analyze`/`teardown_render` MoshOps proxy commands + `/teardown/recipe` &
  `/teardown/execute` service routes. The deployed app bundles the lane code; `/teardown/*`
  503 gracefully until `setup-teardown.sh` provisions the venv in a stable location.
- **§2 DAW detection is weak** — the census identified the DAW in 0/8 tutorials: the OCR
  title-bar heuristic doesn't fire on mid-tutorial frames (the DAW chrome isn't on screen
  while editing). Piano-roll + plugin-name detection both work well (88% / 50%), so this is
  not load-bearing, but `vision/daw.py` wants a real classifier (or keyframes that catch
  the menu bar) if the DAW name is ever needed.

## What the §13 census told us about §8 (the spec's whole point)

Piano-roll is visible **88%** of the time → §5 MIDI is the dependable backbone. A synth GUI
is surfaced only **~50%** of the time (Serum dominates the long tail: Omnisphere, Massive,
Vital, Sylenth1, Kontakt) → **§8-substitute is core, not a deferrable footnote**: for the
half where no readable patch is shown (or the plugin is unowned), you must approximate with
an owned synth. Where the GUI *is* shown, §5b-read + §8-refine is the cheaper path. This is
exactly the "mixed regime" the build plan's measurement checkpoint was meant to resolve.
