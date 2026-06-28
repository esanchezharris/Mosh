#!/usr/bin/env python3
"""REAL on-device F0 contour for the Phase-2 mumble->skeleton path, via FCPE.

Runs UNDER the dedicated skeleton venv (service/skeleton/.venv), invoked by server.py's
/skeleton_spec as a subprocess so torch/FCPE never touch the service interpreter. Reads the
take's audio (stdlib `wave`, so we depend only on torch + torchfcpe — NOT torchaudio's file
backend), runs FCPE pitch tracking, and emits ONE JSON line to stdout (all model chatter is
routed to stderr so it can't corrupt the result):

  {"ok": true, "backend": "fcpe", "sr": N, "f0": [{"t": <sec>, "hz": <Hz>}, ...]}

Voiced frames only (unvoiced/low-confidence frames are dropped). The server feeds this `f0`
to skeleton.core.nuclei_from_notes, which splits a sustained note at pitch re-articulations.
Notes/onsets come from Basic Pitch on the server side — this CLI only supplies F0.

Usage:  skeleton_cli.py <input.wav>
"""
import json
import os
import struct
import sys
import wave

# Route library noise to stderr; keep the real stdout for our single JSON line.
_OUT = sys.stdout
sys.stdout = sys.stderr

# FCPE's bundled model hops ~10ms (160 samples @ 16k). We resample to 16k for inference and
# stamp frame times from this hop so the contour's timestamps are in real seconds.
_FCPE_SR = 16000
_HOP = 160
_CONF_MIN = 0.5   # drop low-confidence (likely unvoiced) frames


def _fail(msg: str) -> "None":
    _OUT.write(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def _read_wav_mono(path):
    """WAV -> (mono float list, samplerate). Averages channels; handles 16/24-bit PCM."""
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
    mono = [sum(inter[i * ch:(i + 1) * ch]) / ch for i in range(frames)]
    return mono, sr


def main() -> "None":
    if len(sys.argv) < 2:
        _fail("usage: skeleton_cli.py <input.wav>")
    in_wav = sys.argv[1]
    if not os.path.isfile(in_wav):
        _fail(f"input not found: {in_wav}")

    try:
        import torch
        import torchaudio.functional as AF
        from torchfcpe import spawn_bundled_infer_model
    except Exception as e:  # noqa: BLE001
        _fail(f"torch/torchfcpe not importable: {e}")

    mono, sr = _read_wav_mono(in_wav)
    if not mono:
        _OUT.write(json.dumps({"ok": True, "backend": "fcpe", "sr": sr, "f0": []}))
        return

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    audio = torch.tensor(mono, dtype=torch.float32)
    if sr != _FCPE_SR:
        audio = AF.resample(audio.unsqueeze(0), sr, _FCPE_SR).squeeze(0)

    try:
        model = spawn_bundled_infer_model(device=device)
        x = audio.reshape(1, -1, 1).to(device)            # (batch, time, 1)
        out = model.infer(x, sr=_FCPE_SR, decoder_mode="local_argmax",
                          threshold=0.006, f0_min=80, f0_max=800, output_interp_target_length=None)
    except Exception as e:  # noqa: BLE001
        _fail(f"FCPE inference failed: {e}")

    # out is (batch, frames, 1) Hz. Stamp frame times from the hop; drop <=0 (unvoiced) frames.
    hz = out.squeeze().detach().to("cpu").tolist()
    if isinstance(hz, float):
        hz = [hz]
    hop_s = _HOP / float(_FCPE_SR)
    f0 = [{"t": round(i * hop_s, 4), "hz": round(float(v), 3)}
          for i, v in enumerate(hz) if v and float(v) >= 80.0]

    _OUT.write(json.dumps({"ok": True, "backend": "fcpe", "sr": sr, "f0": f0}))


if __name__ == "__main__":
    main()
