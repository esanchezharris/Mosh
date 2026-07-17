#!/usr/bin/env python3
"""FCPE frame probe (mechanism-verify V0) — DENSE per-frame F0 with a tunable voicing
threshold. Unlike skeleton_cli.py (which drops unvoiced frames and pins threshold=0.006 —
the KS-B-documented "always-on" setting), this emits EVERY 10ms frame so a caller can find
voicing ONSETS, and exposes the decoder threshold for the registered sensitivity sweep.

Run under the skeleton venv:
  ~/Library/Mosh/venvs/skeleton/bin/python3 fcpe_probe.py <in.wav> [--threshold 0.006]

Output (one JSON line on stdout; library chatter routed to stderr):
  {"ok": true, "backend": "fcpe", "hop_s": 0.01, "threshold": X,
   "frames": [[t_sec, hz], ...]}          # hz == 0.0 on unvoiced/sub-80Hz frames
"""
import argparse
import json
import struct
import sys
import wave

_OUT = sys.stdout
sys.stdout = sys.stderr

_FCPE_SR = 16000
_HOP = 160


def _fail(msg: str):
    _OUT.write(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def _read_wav_mono(path):
    """WAV -> (mono float list, samplerate). Averages channels; 16/24-bit PCM."""
    with wave.open(path, "rb") as w:
        ch, sw, sr, nf = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(nf)
    if sw == 3:
        inter = []
        for k in range(0, len(raw) - 2, 3):
            v = raw[k] | (raw[k + 1] << 8) | (raw[k + 2] << 16)
            if v & 0x800000:
                v -= 0x1000000
            inter.append(v / 8388608.0)
    else:
        cnt = len(raw) // 2
        inter = [v / 32768.0 for v in struct.unpack("<%dh" % cnt, raw)] if cnt else []
    if ch <= 1:
        return inter, sr
    frames = len(inter) // ch
    return [sum(inter[i * ch:(i + 1) * ch]) / ch for i in range(frames)], sr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--threshold", type=float, default=0.006)
    args = ap.parse_args()

    try:
        import torch
        import torchaudio.functional as AF
        from torchfcpe import spawn_bundled_infer_model
    except Exception as e:  # noqa: BLE001
        _fail(f"torch/torchfcpe not importable: {e}")

    mono, sr = _read_wav_mono(args.wav)
    if not mono:
        _OUT.write(json.dumps({"ok": True, "backend": "fcpe", "hop_s": _HOP / _FCPE_SR,
                               "threshold": args.threshold, "frames": []}))
        return

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    audio = torch.tensor(mono, dtype=torch.float32)
    if sr != _FCPE_SR:
        audio = AF.resample(audio.unsqueeze(0), sr, _FCPE_SR).squeeze(0)
    try:
        model = spawn_bundled_infer_model(device=device)
        x = audio.reshape(1, -1, 1).to(device)
        out = model.infer(x, sr=_FCPE_SR, decoder_mode="local_argmax",
                          threshold=args.threshold, f0_min=80, f0_max=800,
                          output_interp_target_length=None)
    except Exception as e:  # noqa: BLE001
        _fail(f"FCPE inference failed: {e}")

    hz = out.squeeze().detach().to("cpu").tolist()
    if isinstance(hz, float):
        hz = [hz]
    hop_s = _HOP / float(_FCPE_SR)
    frames = [[round(i * hop_s, 4), round(float(v), 3) if v and float(v) >= 80.0 else 0.0]
              for i, v in enumerate(hz)]
    _OUT.write(json.dumps({"ok": True, "backend": "fcpe", "hop_s": hop_s,
                           "threshold": args.threshold, "frames": frames}))


if __name__ == "__main__":
    main()
