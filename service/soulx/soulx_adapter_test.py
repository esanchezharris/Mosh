#!/usr/bin/env python3
"""Golden tests for the SoulX sing adapter's FAKE backend (Stage 2, fake-first).

The fake renders the AUTHORED target score as legato beeps — deterministic, stdlib-only —
so these pin: gating (fake unless the PC backend is fully configured; MOSH_ENABLE_SOULX=0
force-pins fake), the score artifact, the audible semantics (silence in rests, tone in
words, no re-attack across continuations), and 3x byte-identical output.

Run:  python3 service/soulx/soulx_adapter_test.py     (exit 0 = all pass)
"""
import hashlib
import json
import os
import struct
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

# Pin the gate env BEFORE import so module state can't leak from the machine's config.
os.environ.pop("MOSH_SOULX_SSH_HOST", None)
os.environ.pop("MOSH_ENABLE_SOULX", None)
_EMPTY_VOICE = tempfile.mkdtemp(prefix="soulx-novoice-")
os.environ["MOSH_VOICE_DIR"] = _EMPTY_VOICE

from adapters import soulx_adapter as A  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SLOT(a, b, *pitches):
    segs, n = [], len(pitches)
    for i, p in enumerate(pitches):
        segs.append({"start": a + (b - a) * i / n, "end": a + (b - a) * (i + 1) / n, "pitch": p})
    return {"start": a, "end": b, "velocity": 90, "kind": "gap", "segments": segs}


LINES = [{"text": "hold the flame", "asserted": True,
          "score": {"v": 1, "algo": "v3", "bar": 0, "bpm": 120.0, "timeSig": [4, 4],
                    "grid": "1/16", "clamped": False,
                    "slots": [SLOT(0.5, 1.0, 57), SLOT(1.0, 1.5, 59), SLOT(1.5, 2.2, 60, 64)]}}]

# ── 1. Gating: fake unless the PC backend is FULLY configured ──────────────────────────
check("no ssh host + no voice -> fake", not A.available() and A.backend_name() == "fake-sing")
os.environ["MOSH_SOULX_SSH_HOST"] = "gamer-pc"
check("ssh host but NO enrolled voice -> still fake (locked-to-self wall)", not A.available())
ref = os.path.join(_EMPTY_VOICE, "reference.wav")
with wave.open(ref, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
    w.writeframes(struct.pack("<8h", *([1000] * 8)))
check("ssh host + enrolled voice -> real backend", A.available() and A.backend_name() == "soulx-pc")
os.environ["MOSH_ENABLE_SOULX"] = "0"
check("MOSH_ENABLE_SOULX=0 force-pins the fake (selftest hermeticity)", not A.available())
os.environ.pop("MOSH_SOULX_SSH_HOST", None)
os.environ.pop("MOSH_ENABLE_SOULX", None)
os.remove(ref)

# ── 2. Fake render: deterministic, score-faithful, honestly audible ────────────────────
td = tempfile.mkdtemp(prefix="soulx-render-")
digests = []
for i in range(3):
    out = os.path.join(td, f"out{i}.wav")
    m = A.render("", out, {"lines": json.loads(json.dumps(LINES))})
    digests.append(hashlib.sha256(open(out, "rb").read()).hexdigest())
check("3x byte-identical output", len(set(digests)) == 1, str([d[:10] for d in digests]))
check("manifest: adapter/backend/mode", m["adapter"] == "soulx" and m["backend"] == "fake-sing"
      and m["mode"] == "sing" and m["ok"], str({k: m[k] for k in ("adapter", "backend", "mode")}))
check("manifest: honest placeholder flag + counts",
      "placeholder_vocal" in m["flags"] and m["words"] == 3 and m["linesUsed"] == 1, str(m["flags"]))
score_path = os.path.join(td, "target_score.json")
score = json.load(open(score_path))
check("target_score.json written next to the output (both backends' contract)",
      isinstance(score, list) and score[0]["note_type"].split()[0] == "1", str(score[0]["text"]))

with wave.open(os.path.join(td, "out0.wav"), "rb") as w:
    sr, nf = w.getframerate(), w.getnframes()
    raw = struct.unpack("<%dh" % nf, w.readframes(nf))
check("output duration covers the score", nf / sr >= 2.2, f"{nf / sr:.2f}s")
lead = raw[: int(0.45 * sr)]
check("leading <SP> rest is SILENT", max(abs(v) for v in lead) == 0, str(max(abs(v) for v in lead)))
word = raw[int(0.6 * sr): int(0.9 * sr)]
check("word region is a tone", max(abs(v) for v in word) > 8000, str(max(abs(v) for v in word)))
# the melisma continuation (57->... slot3 has segments 60,64 = type 2 + type 3): the glide
# boundary at ~1.85s must stay CONTINUOUS — no silence dip (no re-attack between segments).
boundary = raw[int(1.82 * sr): int(1.88 * sr)]
window = 64
floors = [max(abs(v) for v in boundary[k: k + window]) for k in range(0, len(boundary) - window, window)]
check("no re-attack across the melisma continuation (envelope never collapses)",
      min(floors) > 4000, str(min(floors)))

# ── 3. No scored lines -> a clear job error, never a silent render ─────────────────────
try:
    A.render("", os.path.join(td, "err.wav"), {"lines": [{"text": "typed only", "score": None}]})
    check("scoreless sheet raises", False)
except RuntimeError as e:
    check("scoreless sheet raises a helpful error", "build a flow" in str(e) or "assert the lyric line" in str(e), str(e)[:60])

# ── 4. JSON-string score blobs tolerated (native sends parsed; belt for strings) ───────
as_str = [{"text": "hold", "asserted": True, "score": json.dumps(LINES[0]["score"])}]
m2 = A.render("", os.path.join(td, "str.wav"), {"lines": as_str})
check("string score blob parses and renders", m2["ok"] and m2["linesUsed"] == 1)

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
