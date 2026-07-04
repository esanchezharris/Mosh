#!/usr/bin/env python3
"""REAL Tier-B timbre transfer via a RAVE TorchScript model.

Runs UNDER the dedicated transform venv (~/Library/Mosh/venvs/transform), invoked by
service/adapters/transform_adapter.py as a subprocess so torch never touches the
service interpreter. Loads RAVE_MODEL_DIR/<target>.ts, runs encode→decode timbre
transfer, wet-mixes by `strength`, writes output.wav. Emits ONE JSON line to stdout
(all torch/JIT chatter is routed to stderr so it can't corrupt the result):

  {"ok": true, "model": "<target>", "backend": "rave", "sr": N}

WAV I/O is stdlib `wave` (decode/encode 16/24-bit ourselves) so we depend ONLY on
torch + torchaudio.functional (pure-torch resample) — NOT torchaudio's file backend
(torchcodec/ffmpeg). RAVE inference is the only torch work.

Usage:  transform_cli.py <input.wav> <output.wav> <target> <strength 0..100> <seed>
"""
import json
import os
import re
import struct
import sys
import wave

# Route library noise to stderr; keep the real stdout for our single JSON line.
_OUT = sys.stdout
sys.stdout = sys.stderr


def _fail(msg: str) -> "None":
    _OUT.write(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")


def _read_wav(path):
    """WAV → (float list interleaved, n_channels, samplerate)."""
    with wave.open(path, "rb") as w:
        ch, sw, sr, nf = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(nf)
    if sw == 3:
        out = []
        for k in range(0, len(raw) - 2, 3):
            v = raw[k] | (raw[k + 1] << 8) | (raw[k + 2] << 16)
            if v & 0x800000:
                v -= 0x1000000
            out.append(v / 8388608.0)
        samples = out
    else:  # 16-bit (or fall back)
        cnt = len(raw) // 2
        samples = [v / 32768.0 for v in struct.unpack("<%dh" % cnt, raw)] if cnt else []
    return samples, ch, sr


def _write_wav(path, interleaved, ch, sr):
    clamped = [int(max(-32768, min(32767, round(s * 32767.0)))) for s in interleaved]
    body = struct.pack("<%dh" % len(clamped), *clamped) if clamped else b""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(body)


def main() -> "None":
    if len(sys.argv) < 6:
        _fail("usage: transform_cli.py <input.wav> <output.wav> <target> <strength> <seed>")
    in_wav, out_wav, target, strength_s, seed_s = sys.argv[1:6]
    strength = max(0.0, min(1.0, float(strength_s) / 100.0))
    seed = int(float(seed_s))

    model_dir = os.environ.get("RAVE_MODEL_DIR", "")
    if not model_dir:
        _fail("RAVE_MODEL_DIR not set")
    cand = os.path.join(model_dir, f"{target}.ts")
    if not os.path.isfile(cand):
        slug = _slug(target)
        matches = [f for f in os.listdir(model_dir) if f.endswith(".ts") and _slug(f[:-3]) == slug]
        if not matches:
            _fail(f"no RAVE model for target '{target}' in {model_dir}")
        cand = os.path.join(model_dir, matches[0])

    try:
        import torch
        import torchaudio.functional as AF
    except Exception as e:  # noqa: BLE001
        _fail(f"torch not importable: {e}")

    torch.manual_seed(seed)
    try:
        model = torch.jit.load(cand, map_location="cpu")
        model.eval()
    except Exception as e:  # noqa: BLE001
        _fail(f"could not load model {cand}: {e}")
    model_sr = int(getattr(model, "sr", 0) or getattr(model, "sampling_rate", 0) or 44100)

    samples, in_ch, in_sr = _read_wav(in_wav)
    if not samples:
        _write_wav(out_wav, [], in_ch, in_sr)
        _OUT.write(json.dumps({"ok": True, "model": os.path.basename(cand)[:-3], "backend": "rave", "sr": in_sr}))
        return

    # Interleaved → mono tensor (RAVE models are mono-in).
    frames = len(samples) // in_ch
    mono = torch.tensor(samples, dtype=torch.float32).reshape(frames, in_ch).mean(dim=1)  # (frames,)
    if in_sr != model_sr:
        mono = AF.resample(mono.unsqueeze(0), in_sr, model_sr).squeeze(0)

    x = mono.reshape(1, 1, -1)                          # (batch, channel, time)
    try:
        with torch.no_grad():
            if hasattr(model, "encode") and hasattr(model, "decode"):
                y = model.decode(model.encode(x))
            else:
                y = model(x)
    except Exception as e:  # noqa: BLE001
        _fail(f"RAVE inference failed: {e}")

    y = y.reshape(-1)
    n = min(mono.shape[-1], y.shape[-1])
    wet = (1.0 - strength) * mono[:n] + strength * y[:n]   # dry/wet (timbre amount)
    if model_sr != in_sr:
        wet = AF.resample(wet.unsqueeze(0), model_sr, in_sr).squeeze(0)
    wet = torch.clamp(wet, -1.0, 1.0)

    # Re-spread mono → the input channel count, interleave, write.
    mono_out = wet.tolist()
    interleaved = []
    for s in mono_out:
        for _ in range(in_ch):
            interleaved.append(s)
    _write_wav(out_wav, interleaved, in_ch, in_sr)

    _OUT.write(json.dumps({"ok": True, "model": os.path.basename(cand)[:-3],
                           "backend": "rave", "sr": in_sr}))


if __name__ == "__main__":
    main()
