#!/usr/bin/env python3
"""Golden test for the sample-truth measure pass (measure_palette_samples.py).

Synthetic ground truth: a 40 Hz decaying sine MUST read sub-heavy (high subShare,
long subTailMs); an 8 kHz click MUST read sub-empty and fast-decaying. The open-hat
name tokenizer is pinned by table — 'hate.wav' and 'high hat.wav' must NOT match
(substring matching was the failure mode the whole-token rule exists to prevent).
Measurement is run 3× and must be bitwise-identical (goldens convention).
"""
from __future__ import annotations

import math
import os
import struct
import sys
import tempfile
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_palette_samples import is_closed_hat_name, is_open_hat_name, measure_sample  # noqa: E402

SR = 44100
CHECKS = [0]


def ok(cond, msg):
    CHECKS[0] += 1
    if not cond:
        print(f"FAIL [{CHECKS[0]}]: {msg}")
        sys.exit(1)
    print(f"  ok [{CHECKS[0]}]: {msg}")


def write_wav(path, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767))))
                               for s in samples))


def decaying_sine(freq, dur_s, tau_s):
    return [math.sin(2 * math.pi * freq * t / SR) * math.exp(-(t / SR) / tau_s)
            for t in range(int(dur_s * SR))]


def click_8k(dur_s=0.3):
    out = []
    for t in range(int(dur_s * SR)):
        env = math.exp(-(t / SR) / 0.004)          # ~4 ms decay
        out.append(math.sin(2 * math.pi * 8000 * t / SR) * env)
    return out


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        sub_path = os.path.join(td, "sub808.wav")
        write_wav(sub_path, decaying_sine(40.0, 1.5, 0.4))
        click_path = os.path.join(td, "click.wav")
        write_wav(click_path, click_8k())

        m_sub, err = measure_sample(sub_path)
        ok(err is None and m_sub is not None, "40 Hz sine measurable")
        ok(m_sub["subShare"] > 0.9, f"40 Hz sine is sub-heavy (subShare {m_sub['subShare']})")
        ok(m_sub["subTailMs"] > 250, f"40 Hz sine sub tail is long ({m_sub['subTailMs']} ms)")
        ok(m_sub["decayMs"] > 250, f"40 Hz sine broadband decay is long ({m_sub['decayMs']} ms)")
        ok(m_sub["peakDb"] > -3.0, f"peakDb sane ({m_sub['peakDb']})")

        m_click, err = measure_sample(click_path)
        ok(err is None and m_click is not None, "8 kHz click measurable")
        ok(m_click["subShare"] < 0.1, f"8 kHz click has no sub ({m_click['subShare']})")
        ok(m_click["decayMs"] < 100, f"8 kHz click decays fast ({m_click['decayMs']} ms)")
        ok(m_click["sample_measure_ver"] == 1, "version stamp present")

        # bitwise determinism, 3 runs
        for i in range(2):
            again, _ = measure_sample(sub_path)
            ok(again == m_sub, f"measurement deterministic (run {i + 2})")

        # tokenizer table: whole tokens only, on the ORIGINAL name
        table = [("open hhhh.wav", True), ("regular oh.wav", True),
                 ("OPENHAT 3.wav", True), ("kit/oh_909.wav", True),
                 ("hate.wav", False), ("high hat.wav", False),
                 ("chop.wav", False), ("Default Hat.wav", False),
                 ("john.wav", False), ("", False)]
        for name, want in table:
            ok(is_open_hat_name(name) == want, f"open-hat tokenizer: {name!r} → {want}")
        ok(is_closed_hat_name("closed hat 2.wav"), "closed-hat tokenizer positive")
        ok(not is_closed_hat_name("open hat.wav"), "closed-hat tokenizer negative")

    print(f"measure_palette_samples golden: {CHECKS[0]} checks PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
