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
| 11 | `flywheel/verify_reward.py` | a music-native encoder (**MERT**) beats the engineered baseline at preserving the ablation ordering, held out on real audio | 2443 samples → 40 real triplets → **MERT 0.938 vs engineered 0.812** |
| 13 | `measurement_checkpoint.py [N]` | readability census over real tutorials — how often DAW/piano-roll/synth-GUI are seen → **scopes §8** | n=8: piano-roll **88%**, synth GUI **50%**, DAW id **0%** → "mixed regime; §8-substitute is core" |
| 4 | `video2recipe/cli.py --url <id> --section A B` | a real tutorial → schema-valid Recipe skeleton (frames + OCR + scenes) | e.g. `fw4Ms26mdmc` → piano-roll + "Pigments" detected, valid recipe |

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
- **§9 timeline placement** — `compile.py` places a matched sample at `startSeconds=0`
  (one element per track). Sequencing multiple slices on one track at their onset times is
  a compiler extension needed for a faithful drum reconstruction from §7 slices.
- **§5b knob VALUES** — the census measures whether a synth GUI is *seen*; reading the
  actual knob values needs calibrated per-synth profiles (`synth_from_screen/profiles/`).
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
