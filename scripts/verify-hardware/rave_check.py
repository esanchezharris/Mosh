"""Real Tier-B RAVE transform-path check (optional; needs the transform venv).

Gated like the SA3 check. Proves the REAL transform path — torch.jit.load of a RAVE
TorchScript model, encode→decode inference, WAV I/O, and the transform_adapter's real
dispatch — produces non-silent audio that differs from its input. To avoid depending
on a flaky pretrained-model download, it builds a small SYNTHETIC scripted model with
the same encode/decode shape RAVE exports; if you have a real <target>.ts in
RAVE_MODEL_DIR you can point the adapter at it the same way. Skips cleanly (counts as
pass) when service/transform/.venv is absent — run service/transform/setup-transform.sh.

Lazily imported by verify.py so the offline checks never depend on torch.
"""
import json
import math
import os
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

_BUILDER = '''
import sys, torch
class FakeRave(torch.nn.Module):
    sr: int
    def __init__(self):
        super().__init__(); self.sr = 44100
    @torch.jit.export
    def encode(self, x: torch.Tensor) -> torch.Tensor:
        return x
    @torch.jit.export
    def decode(self, z: torch.Tensor) -> torch.Tensor:
        return torch.tanh(z * 4.0)
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.decode(self.encode(x))
torch.jit.script(FakeRave()).save(sys.argv[1])
'''


def _write_sine(path, sr=44100, secs=0.5, freq=220.0, ch=2):
    n = int(secs * sr); fr = []
    for i in range(n):
        v = int(max(-32768, min(32767, round(0.5 * math.sin(2 * math.pi * freq * i / sr) * 32767))))
        fr += [v] * ch
    with wave.open(path, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(struct.pack("<%dh" % len(fr), *fr))


def _read_ints(path):
    with wave.open(path, "rb") as w:
        raw = w.readframes(w.getnframes())
    return list(struct.unpack("<%dh" % (len(raw) // 2), raw)) if raw else []


def check_rave(ctx=None):
    py = os.environ.get("TRANSFORM_PY") or str(REPO / "service/transform/.venv/bin/python")
    if not os.path.exists(py):
        return {"check": "RAVE transform (real path)", "pass": True,
                "detail": {"skipped": "transform venv absent — run service/transform/setup-transform.sh"}}

    d = tempfile.mkdtemp(); models = os.path.join(d, "models"); os.makedirs(models)
    builder = os.path.join(d, "_build.py")
    Path(builder).write_text(_BUILDER)
    model = os.path.join(models, "flute.ts")
    b = subprocess.run([py, builder, model], capture_output=True, text=True, timeout=180)
    if b.returncode != 0 or not os.path.isfile(model):
        return {"check": "RAVE transform (real path)", "pass": False,
                "detail": {"stage": "build synthetic model", "stderr": b.stderr[-400:]}}

    inp = os.path.join(d, "in.wav"); out = os.path.join(d, "out.wav"); _write_sine(inp)
    cli = str(REPO / "service/transform/transform_cli.py")
    env = dict(os.environ); env["RAVE_MODEL_DIR"] = models
    p = subprocess.run([py, cli, inp, out, "flute", "80", "1"], capture_output=True, text=True, env=env, timeout=180)
    res = {}
    if p.stdout.strip():
        try:
            res = json.loads(p.stdout.strip().splitlines()[-1])
        except json.JSONDecodeError:
            res = {}
    if not res.get("ok") or not os.path.isfile(out):
        return {"check": "RAVE transform (real path)", "pass": False,
                "detail": {"stage": "cli", "result": res, "stderr": p.stderr[-400:]}}

    a, bb = _read_ints(out), _read_ints(inp); n = min(len(a), len(bb))
    rms = (sum(x * x for x in a) / len(a)) ** 0.5 / 32768 if a else 0.0
    diff = (sum((a[i] - bb[i]) ** 2 for i in range(n)) / n) ** 0.5 / 32768 if n else 0.0
    ok = bool(res.get("backend") == "rave" and rms > 0.001 and diff > 0.001)
    return {"check": "RAVE transform (real path)", "pass": ok,
            "detail": {"backend": res.get("backend"), "model": res.get("model"),
                       "out_rms": round(rms, 4), "diff_from_input_rms": round(diff, 4),
                       "note": "synthetic scripted RAVE-shaped model (real torch.jit path)"}}
