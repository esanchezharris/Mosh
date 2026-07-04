#!/usr/bin/env python3
"""Author a SoulX-Singer target-score JSON from a simple melody spec (KS-A input prep).

Spec format (JSON):
  {
    "name": "score1-flame", "bpm": 120, "language": "English",
    "events": [
      {"rest": 0.5},                                # beats of silence -> <SP>, pitch 0, type 1
      {"word": "they", "pitch": 57, "beats": 0.5},  # new word            -> type 2
      {"word": "flame", "pitch": 60, "beats": 2.0}, # sustained probe (long single note)
      {"word": "flame", "pitch": 62, "beats": 1.0, "cont": true}  # melisma/continuation -> type 3
    ]
  }

Emits the array-of-one-clip JSON matching SoulX's example/audio/en_target.json:
per-event tokens across `text` / `phoneme` (en_-prefixed, dash-joined ARPAbet with stress
digits) / `note_pitch` (MIDI, 0 = rest) / `note_type` (1 rest, 2 word, 3 continuation) /
`duration` (seconds) — plus `time` [0, total_ms]. No `f0` field (score mode).

Phones come from `pronouncing` (CMUdict). Words missing from the dictionary must be
supplied via {"phones": "F-L-EY1-M"} on the event.

Usage:  score_author.py spec.json -o out/score1-flame.json
"""
from __future__ import annotations

import argparse
import json


def _phones(word: str, override: str | None) -> str:
    if override:
        return override if "-" in override else "-".join(override.split())
    import pronouncing
    cand = pronouncing.phones_for_word(word.lower().strip(".,!?'\"").replace("in'", "ing"))
    if not cand:
        raise SystemExit(f"'{word}' not in CMUdict — add \"phones\": \"X-X-X\" to its event")
    return "-".join(cand[0].split())


def author(spec: dict) -> list[dict]:
    bpm = float(spec.get("bpm", 120))
    spb = 60.0 / bpm
    text, phon, pitch, ntype, dur = [], [], [], [], []
    for ev in spec["events"]:
        if "rest" in ev:
            text.append("<SP>"); phon.append("<SP>"); pitch.append(0); ntype.append(1)
            dur.append(float(ev["rest"]) * spb)
            continue
        w = ev["word"]
        text.append(w)
        phon.append("en_" + _phones(w, ev.get("phones")))
        pitch.append(int(ev["pitch"]))
        ntype.append(3 if ev.get("cont") else 2)
        dur.append(float(ev["beats"]) * spb)
    total_ms = round(sum(dur) * 1000)
    return [{
        "index": f"{spec.get('name', 'score')}_0_{total_ms}",
        "language": spec.get("language", "English"),
        "time": [0, total_ms],
        "duration": " ".join(f"{d:.2f}" for d in dur),
        "text": " ".join(text),
        "phoneme": " ".join(phon),
        "note_pitch": " ".join(str(p) for p in pitch),
        "note_type": " ".join(str(t) for t in ntype),
    }]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()
    spec = json.load(open(args.spec))
    doc = author(spec)
    with open(args.out, "w") as f:
        json.dump(doc, f, indent=2)
    c = doc[0]
    n = len(c["note_pitch"].split())
    sus = max(float(d) for d in c["duration"].split())
    print(f"{args.out}: {n} events, {c['time'][1] / 1000:.1f}s, longest note {sus:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
