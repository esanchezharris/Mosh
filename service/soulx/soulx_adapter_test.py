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
os.environ.pop("MOSH_ENABLE_NSF", None)          # NSF ships OFF; never let a host config leak in
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

# ── 5. Timing-snap wiring (Phase A): a take present -> the render is snapped to it ──────
# input_wav="" (every test above) skips snap -> those outputs stay byte-identical. With a
# real take on disk the adapter derives windows/events from the authored clip and snaps.
noin = A.render("", os.path.join(td, "noin.wav"), {"lines": json.loads(json.dumps(LINES))})
check("no input_wav -> timingSnapped false, clean skip (no snap flags)",
      noin.get("timingSnapped") is False and "snap_skipped" not in noin.get("flags", []),
      str({"ts": noin.get("timingSnapped"), "flags": noin.get("flags")}))

take_wav = os.path.join(td, "take.wav")                          # a take to snap against
A.render("", take_wav, {"lines": json.loads(json.dumps(LINES))})
ms = A.render(take_wav, os.path.join(td, "snapped.wav"), {"lines": json.loads(json.dumps(LINES))})
check("input_wav present -> timingSnapped true", ms.get("timingSnapped") is True, str(ms.get("timingSnapped")))
check("sylSnapMedianMs reported (small on an aligned take)",
      isinstance(ms.get("sylSnapMedianMs"), (int, float)) and ms["sylSnapMedianMs"] <= 40,
      str(ms.get("sylSnapMedianMs")))
with wave.open(os.path.join(td, "snapped.wav"), "rb") as w:
    check("snapped output is a valid wav covering the score", w.getnframes() / w.getframerate() >= 2.0, "")

# take path present but UNREADABLE -> snap skipped, render STILL produced + honestly flagged
bad = os.path.join(td, "bad.wav")
open(bad, "wb").write(b"not a wav at all")
badm = A.render(bad, os.path.join(td, "badsnap.wav"), {"lines": json.loads(json.dumps(LINES))})
check("unreadable take -> snap skipped, render still ok + snap_skipped flag",
      badm["ok"] and badm.get("timingSnapped") is False and "snap_skipped" in badm.get("flags", []),
      str(badm.get("flags")))
check("unreadable take still writes a real render", os.path.getsize(os.path.join(td, "badsnap.wav")) > 1000)

# ── 6. NSF re-vocode post-step (Phase B): shipped OFF; opt-in subprocess wiring ────────
# The PC-NSF-HiFiGAN weights are CC BY-NC-SA -> MOSH_ENABLE_NSF=1 is an explicit opt-in and
# a public release needs a self-trained MIT checkpoint. Default path must be untouched.
check("nsf_available() False by default (ship-gate off)", not A.nsf_available())
default_m = A.render("", os.path.join(td, "nonsf.wav"), {"lines": json.loads(json.dumps(LINES))})
check("default render: nsfResynth false, no nsf flags",
      default_m.get("nsfResynth") is False and "nsf_failed" not in default_m.get("flags", []),
      str({"nsf": default_m.get("nsfResynth"), "flags": default_m.get("flags")}))

# Prove the subprocess wiring with a STUB nsf CLI (no torch/weights). The adapter invokes
# <nsf_py> <nsf_cli> <in> <out> revoice and swaps the CLI's output into output_wav.
import textwrap  # noqa: E402
stub = os.path.join(td, "nsf_stub.py")
open(stub, "w").write(textwrap.dedent('''
    import sys, wave, struct
    with wave.open(sys.argv[2], "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
        w.writeframes(struct.pack("<8h", *([12345] * 8)))   # a distinctive marker render
'''))
model = os.path.join(td, "model.ckpt"); open(model, "wb").write(b"x")
os.environ["MOSH_ENABLE_NSF"] = "1"
os.environ["MOSH_NSF_PY"] = sys.executable
os.environ["MOSH_NSF_CLI"] = stub
os.environ["NSF_MODEL"] = model
check("nsf_available() True when opted-in + cli/py/model present", A.nsf_available())
nm = A.render("", os.path.join(td, "nsfout.wav"), {"lines": json.loads(json.dumps(LINES))})
check("nsfResynth true when the NSF step runs", nm.get("nsfResynth") is True, str(nm.get("nsfResynth")))
with wave.open(os.path.join(td, "nsfout.wav"), "rb") as w:
    nsf_raw = struct.unpack("<%dh" % w.getnframes(), w.readframes(w.getnframes()))
check("output IS the NSF CLI's render (swapped in)", set(nsf_raw) == {12345}, str(nsf_raw[:4]))

# a FAILING nsf CLI -> keep the pre-NSF render + nsf_failed flag (best-effort, never fails)
open(os.path.join(td, "nsf_fail.py"), "w").write("import sys; sys.exit(3)")
os.environ["MOSH_NSF_CLI"] = os.path.join(td, "nsf_fail.py")
fm = A.render("", os.path.join(td, "nsffail.wav"), {"lines": json.loads(json.dumps(LINES))})
check("failing nsf cli -> nsf_failed flag, render still ok",
      fm.get("nsfResynth") is False and "nsf_failed" in fm.get("flags", []) and fm["ok"], str(fm.get("flags")))
with wave.open(os.path.join(td, "nsffail.wav"), "rb") as w:
    fail_raw = struct.unpack("<%dh" % min(w.getnframes(), 8), w.readframes(min(w.getnframes(), 8)))
check("failed nsf keeps the fake render (not the 12345 marker)", set(fail_raw) != {12345}, str(fail_raw))
for _k in ("MOSH_ENABLE_NSF", "MOSH_NSF_PY", "MOSH_NSF_CLI", "NSF_MODEL"):
    os.environ.pop(_k, None)

# ── 7. durations passthrough (B1-lite): params flow to the author, mode observable ─────
dv = A.render("", os.path.join(td, "durv.wav"), {"lines": json.loads(json.dumps(LINES))})
check("default manifest reports durations=verbatim", dv.get("durations") == "verbatim",
      str(dv.get("durations")))
dd = A.render("", os.path.join(td, "durd.wav"),
              {"lines": json.loads(json.dumps(LINES)), "durations": "derived"})
check("derived manifest reports durations=derived", dd.get("durations") == "derived",
      str(dd.get("durations")))
from soulx import score as sxs  # noqa: E402
with open(os.path.join(td, "target_score.json")) as _f:
    _sc_d = json.load(_f)[0]
_r_v = sxs.author_score(json.loads(json.dumps(LINES)))["score"][0]
check("derived target_score keeps non-duration fields",
      all(_sc_d[k] == _r_v[k] for k in ("text", "phoneme", "note_pitch", "note_type")))
check("derived target_score durations differ from verbatim",
      _sc_d["duration"] != _r_v["duration"])

# ── 8. sing-viz QA hook: opt-in, default-off + hermetic; stub CLI proves the wiring ─────
check("sing_viz_available() False by default (hermetic)", not A.sing_viz_available())
dflt = A.render(take_wav, os.path.join(td, "noviz.wav"), {"lines": json.loads(json.dumps(LINES))})
check("default render: singViz False", dflt.get("singViz") is False, str(dflt.get("singViz")))
viz_stub = os.path.join(td, "viz_stub.py")
open(viz_stub, "w").write(
    "import sys\n"
    "open(sys.argv[3], 'wb').write(b'\\x89PNG stub')\n")   # argv: take render out_png ...
os.environ["MOSH_SING_VIZ"] = "1"
os.environ["MOSH_VIZ_PY"] = sys.executable
os.environ["MOSH_VIZ_CLI"] = viz_stub
check("sing_viz_available() True when opted-in + cli/py present", A.sing_viz_available())
vm = A.render(take_wav, os.path.join(td, "vizout.wav"), {"lines": json.loads(json.dumps(LINES))})
check("singViz reports the panel filename when the hook runs",
      vm.get("singViz") == "sing_viz.png", str(vm.get("singViz")))
check("panel PNG written next to the render",
      os.path.isfile(os.path.join(td, "sing_viz.png")))
# a failing viz CLI must NOT break the render (observability only)
open(os.path.join(td, "viz_fail.py"), "w").write("import sys; sys.exit(2)")
os.environ["MOSH_VIZ_CLI"] = os.path.join(td, "viz_fail.py")
fv = A.render(take_wav, os.path.join(td, "vizfail.wav"), {"lines": json.loads(json.dumps(LINES))})
check("failing viz cli -> singViz False, render still ok", fv.get("singViz") is False and fv["ok"])
# no take -> no viz even when opted-in
os.environ["MOSH_VIZ_CLI"] = viz_stub
nov = A.render("", os.path.join(td, "vnotk.wav"), {"lines": json.loads(json.dumps(LINES))})
check("no take -> singViz False even opted-in", nov.get("singViz") is False)
for _k in ("MOSH_SING_VIZ", "MOSH_VIZ_PY", "MOSH_VIZ_CLI"):
    os.environ.pop(_k, None)

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
