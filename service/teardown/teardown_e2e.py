#!/usr/bin/env python3
"""FULL front-to-back teardown E2E — the SYNTH/melodic path the orchestrator never wires, chained
end to end and rendered:

  §5 MIDI-from-screen (piano-roll → notes → SMF)  +  §5b synth-GUI read (GUI → patch params)
  +  §7 slice / §1 match (loop → owned drum samples)
      →  §0 Recipe (a synth element playing the read patch + the screen-read MIDI, plus drum tracks)
      →  §9 execute (MoshOps → real render)
      →  §12 reward (trained head scores the reconstruction)

This complements system_smoke.py (drum-only) by exercising the screen-read → synth-render seam:
§5b's params actually driving `set_plugin_param`, and §5's notes actually playing through the synth.
Each leg SKIP/FAILs cleanly so a partial environment still shows how far the chain got, and the run
reports exactly where a seam is unwired (Phase-0 discovery).

    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/teardown_e2e.py
"""
from __future__ import annotations

import glob
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from teardown.drummatch import DrumMatcher  # noqa: E402
from teardown.extract.drum_slice import slice_oneshots  # noqa: E402
from teardown.midi_from_screen import Axes, detect_notes, write_midi  # noqa: E402
from teardown.recipe import (Element, Meta, MetaField, Midi, Plugin, Recipe,  # noqa: E402
                             SynthPatch)
from teardown.render.execute import execute_recipe  # noqa: E402
from teardown.render.from_extraction import recipe_from_extraction  # noqa: E402
from teardown.render.from_screen import synth_element_from_gui  # noqa: E402

SR = 44100
BIN = os.environ.get("MOSH_BIN", "").strip() or "/Applications/Mosh.app/Contents/MacOS/Mosh"
MUSICA = os.environ.get("MUSICA_ROOT", os.path.expanduser("~/Downloads/musica"))
INDEX_DIR = os.environ.get("REWARD_INDEX_DIR", "/tmp/td-reward-index")
FIXDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "synth_from_screen", "fixtures")
# which synth to reconstruct with: a profile we have AND a plugin Mosh can host.
SYNTH = os.environ.get("TD_E2E_SYNTH", "vital")           # vital | serum
SYNTH_PLUGIN = {"vital": "Vital", "serum": "Serum"}[SYNTH]
SYNTH_FIXTURE = os.path.join(FIXDIR, f"{SYNTH}_init.png")


def load_mono(path, max_s=2.0):
    import soundfile as sf
    import librosa
    y, fsr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if fsr != SR:
        y = librosa.resample(y, orig_sr=fsr, target_sr=SR)
    return y[: int(max_s * SR)].astype(np.float32)


def build_loop():
    pool = sorted(glob.glob(os.path.join(MUSICA, "**", "*.wav"), recursive=True))[:60]
    a, b, c = load_mono(pool[0], 1.0), load_mono(pool[1], 1.0), load_mono(pool[2], 0.3)
    n = int(2.0 * SR)
    buf = np.zeros(n, np.float32)

    def place(s, t):
        i = int(t * SR); seg = s[: n - i]
        if seg.size:
            buf[i:i + seg.size] += seg
    for t in (0.0, 1.0):
        place(a, t)
    for t in (0.5, 1.5):
        place(b, t)
    for k in range(8):
        place(c, k * 0.25)
    buf = (buf / (np.max(np.abs(buf)) or 1.0) * 0.9).astype(np.float32)
    out = os.path.join(tempfile.mkdtemp(prefix="td-e2e-"), "loop.wav")
    import soundfile as sf
    sf.write(out, buf, SR)
    return out, buf


def synth_pianoroll():
    """Synthesize a piano-roll frame (saturated notes on a desaturated grid) — the §5 CV core's
    documented input shape — and return (image, axes, known_notes)."""
    import cv2
    TOP_MIDI, ROW_H, PPB, N_ROWS, N_BEATS = 72, 8, 40, 24, 8
    H, W = N_ROWS * ROW_H, N_BEATS * PPB
    axes = Axes(pitch_top_y=ROW_H / 2, row_h=ROW_H, top_midi=TOP_MIDI, time_left_x=0.0, px_per_beat=PPB)
    img = np.full((H, W, 3), 30, np.uint8)
    for r in range(N_ROWS):
        cv2.line(img, (0, r * ROW_H), (W, r * ROW_H), (60, 60, 60), 1)
    for b in range(N_BEATS):
        cv2.line(img, (b * PPB, 0), (b * PPB, H), (80, 80, 80), 1)
    known = [(60, 0, 2), (64, 2, 1), (67, 4, 2), (71, 6, 1)]
    for p, sb, lb in known:
        row = TOP_MIDI - p
        y1 = int(axes.pitch_top_y + row * ROW_H - ROW_H / 2)
        x1 = int(sb * PPB)
        cv2.rectangle(img, (x1, y1), (x1 + lb * PPB - 2, y1 + ROW_H - 1), (0, 200, 0), -1)
    return img, axes, known


def main() -> int:
    legs = []

    def leg(name, ok, extra=""):
        legs.append((name, ok, extra))
        print(f"  [{'ok ' if ok else 'SKIP/FAIL'}] {name}  {extra}")

    # ── §5 MIDI-from-screen: synthetic piano-roll → notes → SMF ──────────────────────
    smf = None
    n_notes = 0
    try:
        roll, axes, known = synth_pianoroll()
        notes = detect_notes(roll, axes)
        n_notes = len(notes)
        smf = write_midi(notes, os.path.join(tempfile.mkdtemp(prefix="td-e2e-midi-"), "lead.mid"), bpm=140)
        leg("§5 MIDI-from-screen", n_notes == len(known) and os.path.isfile(smf),
            f"{n_notes} notes → {os.path.basename(smf)}")
    except Exception as e:  # noqa: BLE001
        leg("§5 MIDI-from-screen", False, f"{type(e).__name__}: {e}")

    # ── §5b synth-GUI read → synth Element (params translated to the plugin's real names) ──
    synth_el = None
    if os.path.isfile(SYNTH_FIXTURE):
        synth_el = synth_element_from_gui(SYNTH_FIXTURE, SYNTH, midi_ref=smf, note_count=n_notes)
        n_params = len(synth_el.synth_patch.params)
        leg("§5b synth-GUI read", n_params > 0,
            f"{n_params} plugin-keyed params from {os.path.basename(SYNTH_FIXTURE)}")
    else:
        leg("§5b synth-GUI read", False, f"fixture absent ({SYNTH_FIXTURE})")

    # ── §7 slice + §1 match: loop → owned drum samples ───────────────────────────────
    matches = []
    if os.path.isdir(MUSICA):
        loop_path, loop_audio = build_loop()
        slices = slice_oneshots(load_mono(loop_path, 2.0), SR)
        dm = DrumMatcher()
        if os.path.isdir(INDEX_DIR):
            dm.load(INDEX_DIR)
        if not dm.index.paths:
            dm.build_index(MUSICA); dm.save(INDEX_DIR)
        for sl in slices:
            m = dm.query(sl.samples, k=1)
            matches.append({"t_s": sl.t_s, "role": sl.role_guess,
                            "match": m[0].path if m else None,
                            "distance": m[0].distance if m else None})
        n_matched = sum(1 for m in matches if m["match"])
        leg("§7+§1 drum match", n_matched > 0, f"{n_matched}/{len(matches)} → owned samples")
    else:
        loop_audio = None
        leg("§7+§1 drum match", False, f"library absent ({MUSICA})")

    # ── §0 Recipe: the synth element (read patch + screen MIDI) + the drum tracks ─────
    drum_rec = recipe_from_extraction(matches) if matches else Recipe()
    if synth_el is None:        # no GUI fixture → still play the screen-read MIDI through the synth
        synth_el = Element(element_id="lead", role="lead", label="Lead",
                           midi=Midi(status="extracted", midi_ref=smf, note_count=n_notes,
                                     confidence=0.8) if smf else Midi(),
                           synth_patch=SynthPatch(status="unknown",
                                                  plugin=Plugin(name=SYNTH_PLUGIN, available_locally=True)),
                           confidence=0.7)
    n_params = len(synth_el.synth_patch.params)
    rec = Recipe(meta=Meta(tempo_bpm=MetaField(value=140, confidence=0.7)),
                 elements=[synth_el] + list(drum_rec.elements))
    leg("§0 recipe assembled", True, f"{len(rec.elements)} elements (1 synth + {len(drum_rec.elements)} drum)")

    # ── §9 execute: render the whole reconstruction ──────────────────────────────────
    if not os.path.isfile(BIN):
        leg("§9 render", False, f"binary absent ({BIN})")
        _summary(legs)
        return 0
    out = os.path.join(tempfile.mkdtemp(prefix="td-e2e-recon-"), "recon.wav")
    res = execute_recipe(rec, bin_path=BIN, out_wav=out,
                         session_dir=tempfile.mkdtemp(prefix="td-e2e-sess-"), timeout_s=240)
    leg("§9 render", res.nonsilent,
        f"rms {res.audio_rms:.3f}, yield {res.yield_actual.get('overall')}")
    # the synth-path seam: did the read patch actually drive the synth?
    leg("  ↳ synth loaded", res.synths_loaded > 0, f"{res.synths_loaded} plugin(s)")
    leg("  ↳ §5b params APPLIED", res.synth_params_set > 0,
        f"{res.synth_params_set}/{n_params} set_plugin_param "
        f"({len([u for u in res.unresolved if u.get('param')])} unresolved param(s))")
    leg("  ↳ §5 notes inlined", res.notes_resolved > 0, f"{res.notes_resolved} midi element(s)")

    # ── §12 reward: score the reconstruction vs the loop as exemplar ──────────────────
    try:
        from teardown.flywheel.reward_encoder import TrainedRewardHead
        from teardown.flywheel.reward import Reward
        if TrainedRewardHead.available() and loop_audio is not None:
            head = TrainedRewardHead()
            head.add_exemplars([(loop_audio, SR)])
            reward = Reward(pull=head.pull, version="reward-" + head.version)
            scores = reward.score_audio(load_mono(out, 4.0), SR)
            leg("§12 reward", "pull" in scores,
                f"pull {scores.get('pull'):.3f}, composite {reward.composite(scores)}")
        else:
            leg("§12 reward", False, "reward head/venv or loop absent")
    except Exception as e:  # noqa: BLE001
        leg("§12 reward", False, f"{type(e).__name__}: {e}")

    return _summary(legs)


def _summary(legs) -> int:
    ran = [l for l in legs if l[1]]
    core = ("§5 MIDI-from-screen", "§5b synth-GUI read", "§7+§1 drum match", "§9 render")
    core_ok = all(l[1] for l in legs if l[0] in core)
    print(f"\n  {'PASS' if core_ok else 'PARTIAL/FAIL'} — {len(ran)}/{len(legs)} legs green; "
          f"full synth+drum teardown→render{'→reward' if any(l[0]=='§12 reward' and l[1] for l in legs) else ''} "
          f"on one input.")
    return 0 if core_ok else 1


if __name__ == "__main__":
    sys.exit(main())
