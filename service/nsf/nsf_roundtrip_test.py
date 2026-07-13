#!/usr/bin/env python3
"""Round-trip golden for the vendored PC-NSF-HiFiGAN vocoder (spike lane).

The mel-config fidelity guard (the research's "single highest-risk garbage-audio spot"):
feed a synthetic harmonic tone at a KNOWN F0 through get_mel -> generator(mel, f0) and prove
the vocoder (a) loads + runs, (b) produces non-silent audio of the right length, (c) is
deterministic (noise_sigma is None), and (d) RESPECTS the F0 you give it — resynth the SAME
mel at two different F0s and the output's measured period tracks the requested pitch (the
headline pitch-controllability). A wrong mel config (n_fft/hop/log-base) fails (b)/(d) loudly
instead of silently shipping garbage.

Needs the checkpoint + the nsf venv:
  service/nsf/setup-nsf.sh   (drops weights at ~/AI/pc-nsf-hifigan/ or set NSF_MODEL)
Run:  ~/Library/Mosh/venvs/nsf/bin/python3 service/nsf/nsf_roundtrip_test.py   (exit 0 = pass)
Absent weights -> SKIP (exit 0), mirroring the other real-model lanes.
"""
import math
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _model_path():
    env = os.environ.get("NSF_MODEL")
    if env and pathlib.Path(env).is_file():
        return pathlib.Path(env)
    default = (pathlib.Path.home() / "AI/pc-nsf-hifigan"
               / "pc_nsf_hifigan_44.1k_hop512_128bin_2025.02" / "model.ckpt")
    return default if default.is_file() else None


mp = _model_path()
if mp is None:
    print("[SKIP] no PC-NSF-HiFiGAN checkpoint (set NSF_MODEL or run setup-nsf.sh) — spike lane")
    sys.exit(0)

import numpy as np  # noqa: E402
import torch  # noqa: E402

import nsf_vocoder as nsf  # noqa: E402

torch.manual_seed(0)
gen, h = nsf.load_model(mp)
check("checkpoint loads with the expected config",
      h.sampling_rate == 44100 and h.num_mels == 128 and h.mini_nsf is True,
      f"sr={h.sampling_rate} mels={h.num_mels} mini={h.mini_nsf}")

SR = h.sampling_rate
stft = nsf.STFT(sr=SR, n_mels=h.num_mels, n_fft=h.n_fft, win_size=h.win_size,
                hop_length=h.hop_size, fmin=h.fmin, fmax=h.fmax)


def synth_tone(f0_hz, dur_s=1.0, n_harm=6):
    n = int(dur_s * SR)
    t = np.arange(n) / SR
    env = np.minimum(1.0, np.minimum(t / 0.02, (dur_s - t) / 0.05))  # gentle attack/release
    sig = sum((0.6 ** k) * np.sin(2 * np.pi * f0_hz * (k + 1) * t) for k in range(n_harm))
    sig = sig / (np.max(np.abs(sig)) + 1e-9) * 0.8 * env
    return sig.astype(np.float32)


def resynth(sig, f0_hz):
    y = torch.from_numpy(sig).float().unsqueeze(0)
    mel = stft.get_mel(y)                                   # [1, 128, T]
    f0 = torch.full((1, mel.shape[-1]), float(f0_hz))       # one F0 per mel frame
    with torch.no_grad():
        wav = gen(mel, f0).squeeze().cpu().numpy()
    return wav, mel


def dominant_period_s(sig):
    """Autocorrelation-estimated fundamental period (s) over 80–500 Hz."""
    x = sig - np.mean(sig)
    ac = np.correlate(x, x, mode="full")[len(x) - 1:]
    lo, hi = int(SR / 500), int(SR / 80)
    if hi >= len(ac):
        return None
    lag = lo + int(np.argmax(ac[lo:hi]))
    return lag / SR


sig200 = synth_tone(200.0)
out200, mel200 = resynth(sig200, 200.0)
check("resynth produces non-silent audio", float(np.max(np.abs(out200))) > 0.05,
      f"peak={float(np.max(np.abs(out200))):.3f}")
check("output length within one hop of upp*mel frames",
      abs(len(out200) - gen.upp * mel200.shape[-1] * int(np.prod(h.upsample_rates[2:]))) <= SR // 100
      or abs(len(out200) - len(sig200)) <= h.hop_size * 2,
      f"out={len(out200)} in={len(sig200)}")

# determinism (noise_sigma is None -> the generator is a pure function)
out200b, _ = resynth(sig200, 200.0)
check("resynth is deterministic (noise_sigma None)",
      np.array_equal(out200, out200b))

# PITCH-CONTROLLABILITY: same mel, two F0s -> the output period tracks the requested F0.
f0_lo = torch.full((1, mel200.shape[-1]), 160.0)
f0_hi = torch.full((1, mel200.shape[-1]), 260.0)
with torch.no_grad():
    lo_wav = gen(mel200, f0_lo).squeeze().cpu().numpy()
    hi_wav = gen(mel200, f0_hi).squeeze().cpu().numpy()
p_lo = dominant_period_s(lo_wav)
p_hi = dominant_period_s(hi_wav)
check("driving the SAME mel at a lower F0 lengthens the output period",
      p_lo is not None and p_hi is not None and p_lo > p_hi,
      f"period@160Hz={p_lo} > period@260Hz={p_hi}")
if p_lo and p_hi:
    check("measured period @160Hz is near 1/160 s (pitch respected)",
          abs(p_lo - 1 / 160.0) < 0.0015, f"{p_lo:.5f} vs {1/160.0:.5f}")
    check("measured period @260Hz is near 1/260 s (pitch respected)",
          abs(p_hi - 1 / 260.0) < 0.0015, f"{p_hi:.5f} vs {1/260.0:.5f}")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
