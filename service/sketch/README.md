# Sketch — embodied capture (Phase 0)

The narrowest proof of the *embodied-capture wedge*: a recorded **beatbox** WAV +
a **known BPM** becomes a real, editable **drum clip** in the live Tracktion Edit,
emitted purely as MoshOps. (Spec: `~/Downloads/SKETCH_SPEC.md`, §0–5/§7. Internal
lineage: "the Michael Jackson pipeline" — make the sound with your mouth, Moshi
finishes the song.) This is **Phase 0 only** — drums, 3-class vocab, fixed loop.

## What it does (and the constraints that keep it small)

- **Tempo is known** — the user sets the BPM and boxes to a click. No tempo estimation.
- **3-class vocab** — `kick` / `snare` / `hat`, on a **16th-note grid**, a fixed **1–2 bar** loop.
- **Capture = file upload** for the spike (no native audio-in).
- **Output is MoshOps** against the native Edit — no MIDI files, no audio generation, no NLU.
- **Deterministic** — same WAV + same BPM + same bars → byte-identical hits → byte-identical notes.

## Pieces

| File | Role |
|------|------|
| `setup-sketch.sh` | Creates the dedicated `.venv` (librosa + numpy), validates the import, writes `.sketch.env` (`SKETCH_PY`). `run.sh` sources it. |
| `beatbox_cli.py` | The deterministic transduction: onset detect → 3-class band-energy heuristic → 16th-grid quantise → velocity from energy. Emits JSON to stdout. |
| `make_fixtures.py` | Synthesises the committed test fixtures (stdlib only; no recordings). |
| `fixtures/*.wav` | A boom-bap (90 BPM) + a trap-hat (140 BPM) loop, committed so the build/selftest never need Python. |

The CLI runs **under the dedicated venv** as a subprocess of the service's
`POST /sketch`, so librosa's deps (numba / scipy / soundfile) never touch the service
interpreter or the SA3 MLX venv. Graceful-absent: with no venv, `/sketch` → 503
`sketch_unavailable` and the rest of Mosh is unaffected.

## Pipeline → MoshOps

```
beatbox.wav + bpm  →  /sketch  →  beatbox_cli.py
   onset_detect (librosa, front-padded so the downbeat is caught)
   per-onset band energy:  low(<150) → kick · mid(150-2k) → snare · else → hat
   quantise each onset to the nearest 16th on the KNOWN grid
   velocity from onset RMS (relative to the loudest hit)
        ↓  {bpm, bars, hits:[{step, role, velocity}]}
native cmdSketchBeatbox  →  emits PURELY as MoshOps:
   set_tempo{bpm} → create_track{type:"drum"} → add_midi_clip{notes…}
   (role → GM pitch: kick 36 · snare 38 · closed hat 42 — mirrors the bundled kit)
```

Each session also appends a training tuple to `~/Library/Mosh/session/sketch-sessions.jsonl`
(tempo, audio ref, transduced hits, emitted MoshOps — see spec §6). The user's own
audio is clean, owned provenance; the reference is retained.

## Setup & use

```bash
service/sketch/setup-sketch.sh            # one-time: build the librosa venv
# then, from the agent / a script:
#   sketch_beatbox { file: "<beatbox>.wav", bpm: 90, bars: 1 }
```

## Gated selftest

```bash
# from the repo root (so the service spawns + the fixtures resolve):
MOSH_SELFTEST_SKETCH=1 \
MOSH_SKETCH_FIXTURE_DIR="$PWD/service/sketch/fixtures" \
  build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest
```

Asserts: recognisable kick/snare/hat land in a real editable clip, the tempo is set,
and the transduction is byte-identical across two runs. The default `Mosh --selftest`
(no env) stays green whether or not the venv is present.

## Not in Phase 0 (gated on a "stop and look" review)

Robust drum capture / trained classifier (Phase 1), bass-line capture (Phase 2),
harmonic intent (Phase 3), the full onboarding flow (Phase 4). Do not build ahead of
the brain — see the spec §1.
