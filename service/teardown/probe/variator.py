#!/usr/bin/env python3
"""Loop variator — turns the curated real-sample catalog into a deliberately quality-spread
set of renderable candidate programs for the reward-validity probe.

Each candidate is a MoshOps command program (drum kit MIDI + imported, tempo-matched melodic
loop) that renders to a ~WINDOW_S short loop. The spread is engineered so the owner has a real
gradient to rank — and so we can see which composite term (pull/pq/clean) tracks that ranking:

  transform     intends         damages
  ──────────    ─────────       ─────────────────────────────────────────
  tight         clearly good    (none — quantized, in-tempo, balanced mix)
  groove_loose  good-ish        slight timing jitter
  groove_drunk  poor (musical)  heavy timing jitter + bad swing      → pull/timing
  tempo_off     poor (musical)  drums race vs native-speed melodic   → pull/timing+timbre
  key_clash     poor (musical)  wrong melodic loop (off-key/tempo)   → pull/timbre
  cluttered     mid-poor        16th-hat density + 2nd offset melody → pull + pq
  mud_clip      poor (product.) melodic +11 dB → mud/clipping        → pq/clean (surface)

Plus a few hand anchors (off-genre incoherence, near-silence, bare tight/sloppy drums).

UNITS (verified against MoshOps.cpp): clip start/length are SECONDS; note start/length are BEATS
(mapped to time by the edit tempo). So drum notes are placed on a beat grid sized to fill WINDOW_S
at the chosen tempo; the melodic clip is imported (native speed) and repeated to cover the window.
All randomness is seeded per candidate → fully deterministic programs.
"""
from __future__ import annotations

import math
import random

WINDOW_S = 10.0
KICK, SNARE, CLAP, HAT, OHAT = 36, 38, 39, 42, 46


def _drum_notes(bpm: float, window_s: float, *, jitter=0.0, swing=0.0, hat_div=0.5,
                drop=0.0, sparse=False, clutter=False, seed=0) -> list[dict]:
    """A trap/lofi 4/4 kit pattern over enough bars to fill window_s. jitter/swing in beats."""
    rng = random.Random(seed)
    n_beats = math.ceil(window_s * bpm / 60.0)
    n_bars = math.ceil(n_beats / 4)

    def j(t):  # timing humanize/damage
        return round(max(0.0, t + (rng.uniform(-jitter, jitter) if jitter else 0.0)), 4)

    notes = []
    for bar in range(n_bars):
        base = bar * 4.0
        # kick: downbeat + a syncopated hit (skip the synco when sparse)
        notes.append({"pitch": KICK, "start": j(base + 0.0), "length": 0.5, "velocity": 120})
        if not sparse:
            notes.append({"pitch": KICK, "start": j(base + 2.5), "length": 0.5, "velocity": 110})
        # backbeat snare/clap on beats 2 and 4 (0-indexed 1 and 3)
        notes.append({"pitch": SNARE, "start": j(base + 1.0), "length": 0.5, "velocity": 112})
        notes.append({"pitch": SNARE, "start": j(base + 3.0), "length": 0.5, "velocity": 112})
        if clutter:
            notes.append({"pitch": CLAP, "start": j(base + 1.0), "length": 0.5, "velocity": 100})
            notes.append({"pitch": CLAP, "start": j(base + 3.0), "length": 0.5, "velocity": 100})
        # hats on the grid
        steps = int(round(4 / hat_div))
        for s in range(steps):
            t = base + s * hat_div
            if drop and rng.random() < drop:
                continue
            sw = swing if (s % 2 == 1) else 0.0  # delay off-beats for swing
            vel = 70 + (18 if s % 2 == 0 else 0) + rng.randint(-6, 6)
            notes.append({"pitch": HAT, "start": j(t + sw), "length": 0.2, "velocity": max(40, min(120, vel))})
        if clutter and bar % 1 == 0:  # extra 16th hat fills
            for s in range(8):
                notes.append({"pitch": HAT, "start": j(base + s * 0.5 + 0.25), "length": 0.15, "velocity": 64})
    # keep only notes inside the window (beats)
    return [n for n in notes if n["start"] <= n_beats]


def _mel_imports(track_var: str, asset: str, dur: float, window_s: float) -> list[dict]:
    """Repeat the (native-speed) melodic clip to cover the window."""
    cmds, t = [], 0.0
    while t < window_s - 0.05:
        cmds.append({"command": "import_clip", "args": {"trackId": track_var, "file": asset, "startSeconds": round(t, 3)}})
        t += dur
    return cmds


def _program(*, tempo, mel_asset, mel_dur, keys_db, drums_db, style, seed,
             second_mel=None, second_off=0.0, window_s=WINDOW_S) -> list[dict]:
    notes = _drum_notes(tempo, window_s, seed=seed, **style)
    prog = [
        {"command": "set_tempo", "args": {"bpm": tempo}},
        {"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"D": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${D}", "start": 0, "length": window_s, "notes": notes}},
        {"command": "set_track_volume", "args": {"trackId": "${D}", "db": drums_db}},
    ]
    if mel_asset:
        prog.append({"command": "create_track", "args": {"name": "Keys", "type": "audio"}, "capture": {"K": "trackId"}})
        prog += _mel_imports("${K}", mel_asset, mel_dur, window_s)
        prog.append({"command": "set_track_volume", "args": {"trackId": "${K}", "db": keys_db}})
    if second_mel:
        prog.append({"command": "create_track", "args": {"name": "Keys2", "type": "audio"}, "capture": {"K2": "trackId"}})
        # offset start → phasing/clutter
        t = second_off
        while t < window_s - 0.05:
            prog.append({"command": "import_clip", "args": {"trackId": "${K2}", "file": second_mel, "startSeconds": round(t, 3)}})
            t += mel_dur
        prog.append({"command": "set_track_volume", "args": {"trackId": "${K2}", "db": keys_db}})
    return prog


# transform → (style overrides, keys_db, drums_db, tempo_fn, intent-tag)
def build_candidates(catalog: list[dict], offgenre: dict | None) -> list[dict]:
    cands: list[dict] = []

    def add(group, label, prog, intent):
        cands.append({"cand_id": f"{group}__{label}", "group": group, "label": label,
                      "intent": intent, "program": prog})

    n = len(catalog)
    for i, b in enumerate(catalog):
        bpm, asset, dur = b["bpm"], b["asset"], b["dur"]
        sd = (i + 1) * 1009
        # 1) tight — clearly good
        add(b["id"], "tight",
            _program(tempo=bpm, mel_asset=asset, mel_dur=dur, keys_db=-4, drums_db=0,
                     style=dict(jitter=0.0, hat_div=0.5), seed=sd), "good")
        # 2) groove_loose — good-ish (slight human jitter)
        add(b["id"], "groove_loose",
            _program(tempo=bpm, mel_asset=asset, mel_dur=dur, keys_db=-4, drums_db=0,
                     style=dict(jitter=0.06, hat_div=0.5), seed=sd + 1), "good_mid")
        # 3) groove_drunk — poor (timing destroyed)
        add(b["id"], "groove_drunk",
            _program(tempo=bpm, mel_asset=asset, mel_dur=dur, keys_db=-4, drums_db=0,
                     style=dict(jitter=0.20, swing=0.22, hat_div=0.5), seed=sd + 2), "bad_timing")
        # 4) tempo_off — poor (drums race vs native melodic → desync)
        add(b["id"], "tempo_off",
            _program(tempo=round(bpm * 1.35), mel_asset=asset, mel_dur=dur, keys_db=-4, drums_db=0,
                     style=dict(jitter=0.0, hat_div=0.5), seed=sd + 3), "bad_coherence")
        # 5) key_clash — poor (a foreign melodic loop, off-key/off-tempo)
        other = catalog[(i + 5) % n]
        add(b["id"], "key_clash",
            _program(tempo=bpm, mel_asset=other["asset"], mel_dur=other["dur"], keys_db=-3, drums_db=0,
                     style=dict(jitter=0.0, hat_div=0.5), seed=sd + 4), "bad_harmony")
        # 6) cluttered — mid-poor (16th hats + 2nd offset melody, loud)
        add(b["id"], "cluttered",
            _program(tempo=bpm, mel_asset=asset, mel_dur=dur, keys_db=1, drums_db=0,
                     style=dict(jitter=0.04, hat_div=0.25, clutter=True), seed=sd + 5,
                     second_mel=asset, second_off=round(dur / 3.0, 3)), "bad_density")
        # 7) mud_clip — poor (production surface: melodic cranked → mud/clip)
        add(b["id"], "mud_clip",
            _program(tempo=bpm, mel_asset=asset, mel_dur=dur, keys_db=11, drums_db=0,
                     style=dict(jitter=0.0, hat_div=0.5), seed=sd + 6), "bad_mix")

    # ── hand anchors ──────────────────────────────────────────────────────────
    if catalog:
        b0 = catalog[0]
        # bare tight drums, no melody (does pull like a clean bare groove?)
        add("anchor", "bare_drums_tight",
            _program(tempo=120, mel_asset=None, mel_dur=0, keys_db=0, drums_db=0,
                     style=dict(jitter=0.0, hat_div=0.5), seed=99001), "anchor")
        # bare sloppy drums
        add("anchor", "bare_drums_sloppy",
            _program(tempo=120, mel_asset=None, mel_dur=0, keys_db=0, drums_db=0,
                     style=dict(jitter=0.24, swing=0.25, hat_div=0.5), seed=99002), "anchor")
        # near silence: a couple of quiet kicks
        add("anchor", "near_silent",
            _program(tempo=120, mel_asset=None, mel_dur=0, keys_db=0, drums_db=-22,
                     style=dict(jitter=0.0, hat_div=0.5, sparse=True, drop=0.95), seed=99003), "anchor")
    if offgenre and catalog:
        # off-genre incoherence: bright brass over fast trap drums, tempo-mismatched
        add("anchor", "offgenre_brass",
            _program(tempo=150, mel_asset=offgenre["asset"], mel_dur=offgenre["dur"], keys_db=-2, drums_db=0,
                     style=dict(jitter=0.0, hat_div=0.5), seed=99004), "anchor")
    return cands


if __name__ == "__main__":
    from samples import catalog, offgenre_asset
    cat = catalog()
    cands = build_candidates(cat, offgenre_asset())
    print(f"{len(cands)} candidates from {len(cat)} bases")
    from collections import Counter
    print("by transform:", dict(Counter(c["label"] for c in cands)))
    print("by intent:", dict(Counter(c["intent"] for c in cands)))
    print("example program (tight):")
    import json
    print(json.dumps(cands[0]["program"][:5], indent=1))
