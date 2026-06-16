#!/usr/bin/env python3
"""Score one or more WAVs and print a JSON array (one object per wav).

  hygiene    -> service/quality_readout.py  (clipping/loudness/dynamics/spectral; always on)
  perceptual -> service/sa3/qa.py            (Audiobox Aesthetics PQ via the judges venv; best-effort)

Batched on purpose: the perceptual judge loads its model once and scores every path
in a single sidecar round-trip, so pass ALL the arena's wavs in one call.

  score_wav.py out_R0.wav out_R1.wav ...
"""
import sys, os, json

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)
sys.path.insert(0, os.path.join(SERVICE, "sa3"))

import quality_readout as qr  # noqa: E402

paths = [p for p in sys.argv[1:] if p]

hygiene = {}
for p in paths:
    try:
        hygiene[p] = qr.analyze_wav(p)
    except Exception as e:  # noqa: BLE001
        hygiene[p] = {"error": f"hygiene_failed: {e}"}

# Perceptual is optional — degrade cleanly if the judges venv / model is absent.
perceptual = {}
perc_err = None
try:
    import qa  # service/sa3/qa.py
    perceptual = qa._pq(paths) or {}
except Exception as e:  # noqa: BLE001
    perc_err = str(e)

# Brief-adherence (CLAP) — "does this sound like the brief?", which hygiene + perceptual
# CANNOT measure (a clean sine scores great but is wrong). Best-effort: only when
# MOSH_BRIEF is set and the CLAP checkpoint exists. Loads the model once for all wavs.
clap = {}
brief = os.environ.get("MOSH_BRIEF", "").strip()
ckpt = os.path.expanduser(os.environ.get("MOSH_CLAP_CKPT", "~/AI/clap_ckpt/630k-audioset-best.pt"))
if brief and os.path.exists(ckpt):
    try:
        import contextlib, io as _io, numpy as _np, soundfile as _sf, librosa as _lr, laion_clap
        _m = laion_clap.CLAP_Module(enable_fusion=False)
        with contextlib.redirect_stdout(_io.StringIO()):
            _m.load_ckpt(ckpt)
        def _n(a):
            return a / (_np.linalg.norm(a, axis=1, keepdims=True) + 1e-9)
        _te = _n(_m.get_text_embedding([brief, "a pure sine wave test tone"], use_tensor=False))
        for p in paths:
            try:
                x, sr = _sf.read(p)
                if getattr(x, "ndim", 1) > 1:
                    x = x.mean(1)
                x = x.astype("float32")
                if sr != 48000:
                    x = _lr.resample(x, orig_sr=sr, target_sr=48000)
                ae = _n(_m.get_audio_embedding_from_data(x=x.reshape(1, -1), use_tensor=False))[0]
                clap[p] = {"brief": round(float(ae @ _te[0]), 3), "sine": round(float(ae @ _te[1]), 3)}
            except Exception as ee:  # noqa: BLE001
                clap[p] = {"error": str(ee)[:80]}
    except Exception as e:  # noqa: BLE001
        clap = {"__error__": str(e)[:120]}

out = []
for p in paths:
    h = hygiene.get(p, {})
    flags = list(h.get("flags", []))
    pq_perc = perceptual.get(p) if isinstance(perceptual, dict) else None
    if pq_perc is None:
        flags.append("perceptual_unavailable" + (f": {perc_err}" if perc_err else ""))
    if "error" in h:
        flags.append(h["error"])
    cb = clap.get(p) if isinstance(clap, dict) else None
    clap_brief = (cb or {}).get("brief")
    clap_sine = (cb or {}).get("sine")
    # off-brief: matches a plain sine tone MORE than the brief (caught the sine renders)
    if clap_brief is not None and clap_sine is not None and clap_sine > clap_brief:
        flags.append(f"off_brief: matches 'sine tone' ({clap_sine:.2f}) > the brief ({clap_brief:.2f})")
    out.append({
        "file": p,
        "pq_hygiene": h.get("pq"),
        "pq_perceptual": pq_perc,
        "clap_brief": clap_brief,
        "clap_sine": clap_sine,
        "metrics": h.get("metrics"),
        "flags": flags,
    })

print(json.dumps(out))
