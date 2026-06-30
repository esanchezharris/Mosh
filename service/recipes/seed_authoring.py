#!/usr/bin/env python3
"""§0.3 seed-recipe authoring harness — write the first hand-verified recipe library.

The restart needs a small library of REAL, musically-coherent trap / melodic-trap recipes
for the generator (§0.5) to retrieve + recombine. These are stored as PURE MUSIC: per-element
role + inline notes (beats) + the 808 bass sub-model + meta (tempo/key). They carry NO sample
paths — the generator binds a palette one-shot per role at assembly time, so a recipe is
portable, owner-private-path-free, and committable.

HONESTY: these are careful transcriptions of *canonical* trap patterns (the kind a beginner
beat tutorial teaches) — a bootstrap to prove the generation machinery. The real corpus comes
from mining real tutorials (Phase 1) or the owner's picks; Gate A (fidelity vs. source audio)
and Gate C (blind A/B) are what validate "start from knowing." Each recipe records its basis
in source.title.

    python3 service/recipes/seed_authoring.py            # writes service/recipes/library/*.json
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(_HERE)
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown import recipe as R  # noqa: E402

LIB = os.path.join(_HERE, "library")

# pitch-class of a tonic name (for documenting + the generator's transposition reference)
PC = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6,
      "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}


def ne(pitch, start, dur, vel=100):
    return R.NoteEvent(pitch=pitch, start_beats=start, duration_beats=dur, velocity=vel)


def drum(role, pitch, onsets, vel=104, dur=0.22, grid="16th"):
    """A single-pad drum element: every hit at the pad pitch, rhythm in `onsets` (beats)."""
    notes = [ne(pitch, s, dur, vel) for s in onsets]
    return R.Element(element_id=role, role=role, label=role.capitalize(),
                     midi=R.Midi(status="extracted", note_count=len(notes), notes=notes),
                     motif=R.Motif(bars=4.0, onset_grid=grid, density=len(notes) / 4.0,
                                   register_band="perc"))


def bass808(notes, root_el="chords", grid="syncopated"):
    durs = [n.duration_beats for n in notes]
    # inter-onset intervals for a crude sustain_ratio (mean dur / mean gap)
    starts = sorted(n.start_beats for n in notes)
    gaps = [b - a for a, b in zip(starts, starts[1:])] or [1.0]
    sr = min(1.0, (sum(durs) / len(durs)) / max(0.25, (sum(gaps) / len(gaps))))
    return R.Element(element_id="b808", role="808", label="808",
                     midi=R.Midi(status="extracted", note_count=len(notes), notes=notes),
                     motif=R.Motif(bars=4.0, onset_grid=grid, density=len(notes) / 4.0,
                                   register_band="sub", harmonic_function="root-following"),
                     bass=R.Bass(sustain_ratio=round(sr, 3), root_follows=True,
                                 kick_alignment=0.5, root_element_id=root_el))


def chords(notes, role="pad", label="Chords"):
    return R.Element(element_id="chords", role=role, label=label,
                     midi=R.Midi(status="extracted", note_count=len(notes), notes=notes),
                     motif=R.Motif(bars=4.0, onset_grid="whole", register_band="mid",
                                   harmonic_function="progression"))


def lead(notes):
    return R.Element(element_id="lead", role="lead", label="Lead",
                     midi=R.Midi(status="extracted", note_count=len(notes), notes=notes),
                     motif=R.Motif(bars=4.0, onset_grid="8th", register_band="high",
                                   contour=[1 if b.pitch > a.pitch else (-1 if b.pitch < a.pitch else 0)
                                            for a, b in zip(notes, notes[1:])]))


def recipe(slug, title, tempo, key, mood, elements):
    r = R.Recipe(
        source=R.Source(platform="seed", video_id=slug, title=title, license="unknown"),
        meta=R.Meta(tempo_bpm=R.MetaField(value=tempo, confidence=1.0),
                    key=R.MetaField(value=key, confidence=1.0),
                    time_signature=R.MetaField(value="4/4", confidence=1.0)),
        arrangement=R.Arrangement(sections=[R.Section(name="loop", start_s=0.0,
                                                      end_s=4.0 * 60.0 / tempo * 2, confidence=1.0)]),
        elements=elements,
        reconstruction_class="deterministic",
    )
    r.meta.daw = R.MetaField(value="seed")
    # stash the mood tag where retrieval can read it (in the section name list is awkward;
    # use the source.channel slot as a free 'mood' carrier — documented convention).
    r.source.channel = mood
    return r


# ───────────────────────── the seed recipes (5, varied) ─────────────────────────
# All drum rhythms in 16ths over 2 bars (8 beats). Hats deliberately DENSE/even; the 808
# deliberately SPARSE + SUSTAINED + off the hat grid — the structural anti-"808-as-hi-hat".

def r_dark_trap():
    K = [0.0, 1.5, 4.0, 5.5]                      # booming, syncopated kick
    S = [1.0, 3.0, 5.0, 7.0]                      # backbeat
    H = [i * 0.5 for i in range(16)]              # straight 8ths (even) — the contrast voice
    # F minor: F1=29. i(F)-VI(Db)-III(Ab)-VII(Eb). 808 follows roots, sustained.
    B = [ne(29, 0.0, 1.5, 116), ne(29, 2.5, 0.5, 92), ne(25, 3.0, 1.0, 108),
         ne(32, 4.5, 1.5, 110), ne(27, 6.0, 2.0, 112)]
    C = [ne(41, 0.0, 2.0, 70), ne(37, 2.0, 1.0, 66), ne(44, 4.0, 2.0, 70), ne(39, 6.0, 2.0, 66)]
    return recipe("seed_dark_trap", "Dark trap loop (canonical) — booming sparse 808, even hats",
                  140, "F minor", "dark", [drum("kick", 36, K, 118), drum("snare", 38, S, 110),
                  drum("hat", 42, H, 74, dur=0.18, grid="8th"), bass808(B), chords(C)])


def r_melodic_trap():
    K = [0.0, 2.5, 4.0, 6.5]
    S = [2.0, 6.0]                                 # half-time backbeat (melodic-trap feel)
    H = [i * 0.25 for i in range(32)]              # rolling 16ths
    # C# minor: C#1=25. i(C#)-VI(A)-VII(B)-v(G#). emotional, rolling 808
    B = [ne(25, 0.0, 2.0, 110), ne(21, 2.0, 1.5, 104), ne(23, 4.0, 2.0, 108), ne(20, 6.0, 2.0, 106)]
    C = [ne(49, 0.0, 2.0, 64), ne(45, 2.0, 2.0, 62), ne(47, 4.0, 2.0, 64), ne(44, 6.0, 2.0, 62)]
    L = [ne(73, 0.0, 0.5, 86), ne(76, 0.5, 0.5, 80), ne(75, 1.0, 1.0, 84), ne(71, 2.0, 1.0, 82),
         ne(73, 4.0, 0.5, 86), ne(80, 4.5, 1.5, 88), ne(76, 6.0, 2.0, 80)]
    return recipe("seed_melodic_trap", "Melodic trap (canonical) — emotional pad+lead, rolling 16th hats",
                  146, "C# minor", "emotional", [drum("kick", 36, K, 112), drum("snare", 38, S, 106),
                  drum("hat", 42, H, 70, dur=0.1, grid="16th"), bass808(B), chords(C), lead(L)])


def r_drill():
    K = [0.0, 0.75, 3.0, 4.0, 4.75, 7.0]           # drill-style skippy kick
    S = [2.0, 6.0]
    H = [i * 0.5 for i in range(16)]
    # G minor: G1=31. sliding 808 (glides) — i(G)-VI(Eb)-VII(F)-v(D)
    B = [ne(31, 0.0, 1.5, 114), ne(27, 1.75, 1.0, 100), ne(29, 3.0, 1.5, 108),
         ne(26, 4.5, 1.5, 110), ne(31, 6.0, 2.0, 112)]
    C = [ne(43, 0.0, 2.0, 66), ne(39, 2.0, 2.0, 64), ne(41, 4.0, 2.0, 66), ne(38, 6.0, 2.0, 64)]
    b = bass808(B)
    b.bass.glides = [0, 3]                          # slide into notes 1 and 4 (drill signature)
    return recipe("seed_drill", "Drill (canonical) — sliding 808 with glides, skippy kick",
                  142, "G minor", "menacing", [drum("kick", 36, K, 116), drum("snare", 38, S, 108),
                  drum("hat", 42, H, 72, dur=0.18, grid="8th"), b, chords(C)])


def r_lofi_trap():
    K = [0.0, 2.0, 4.0, 6.0]                        # simple, laid-back
    S = [1.0, 3.0, 5.0, 7.0]
    H = [i * 0.5 for i in range(16)]
    # A minor: A1=33. gentle i(A)-VI(F)-III(C)-VII(G), longer sustains
    B = [ne(33, 0.0, 2.0, 96), ne(29, 2.0, 2.0, 92), ne(36, 4.0, 2.0, 94), ne(31, 6.0, 2.0, 90)]
    C = [ne(45, 0.0, 2.0, 60), ne(41, 2.0, 2.0, 58), ne(48, 4.0, 2.0, 60), ne(43, 6.0, 2.0, 58)]
    return recipe("seed_lofi_trap", "Lo-fi trap (canonical) — relaxed, long 808 sustains",
                  132, "A minor", "chill", [drum("kick", 36, K, 100), drum("snare", 38, S, 92),
                  drum("hat", 42, H, 64, dur=0.2, grid="8th"), bass808(B), chords(C)])


def r_hard_trap():
    K = [0.0, 1.0, 2.5, 4.0, 5.0, 6.5]              # aggressive, frequent
    S = [1.0, 3.0, 5.0, 7.0]
    H = [i * 0.25 for i in range(32)]               # busy 16ths with rolls
    # D minor: D1=26. punchy i(D)-VII(C)-VI(Bb)-v(A)
    B = [ne(26, 0.0, 1.0, 118), ne(26, 1.5, 0.5, 100), ne(24, 2.5, 1.0, 110),
         ne(22, 4.0, 1.5, 114), ne(21, 6.0, 2.0, 112)]
    C = [ne(38, 0.0, 2.0, 72), ne(36, 2.0, 2.0, 70), ne(34, 4.0, 2.0, 72), ne(33, 6.0, 2.0, 70)]
    return recipe("seed_hard_trap", "Hard trap (canonical) — punchy frequent 808, busy hats",
                  150, "D minor", "aggressive", [drum("kick", 36, K, 120), drum("snare", 38, S, 112),
                  drum("hat", 42, H, 78, dur=0.1, grid="16th"), bass808(B), chords(C)])


SEEDS = [r_dark_trap, r_melodic_trap, r_drill, r_lofi_trap, r_hard_trap]


def main():
    os.makedirs(LIB, exist_ok=True)
    written = []
    for fn in SEEDS:
        r = fn()
        path = os.path.join(LIB, f"{r.source.video_id}.json")
        with open(path, "w") as f:
            f.write(R.to_json(r))
        # sanity: re-validate what we wrote
        R.from_json(open(path).read())
        n_notes = sum(len(e.midi.notes) for e in r.elements)
        roles = ",".join(e.role.value for e in r.elements)
        written.append(path)
        print(f"  wrote {os.path.basename(path):28s} {r.meta.tempo_bpm.value}bpm {r.meta.key.value:10s} "
              f"[{roles}] {n_notes} notes")
    print(f"\n{len(written)} seed recipes → {LIB}")


if __name__ == "__main__":
    main()
