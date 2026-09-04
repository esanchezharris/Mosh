"""StableAudio3Adapter (05 §2, §6) — the real generative model behind the same
`render(input_wav, output_wav, params) -> manifest` contract as the FakeAdapter.

Full carve: re-imagine (audio→audio with steering) + generate (text→audio), the
ASTD-clamped colour rack, the init-latent cache, and judge-panel QA. The heavy
engine imports lazily so FakeAdapter-only runs never load MLX. Called only by the
single serialized worker thread in server.py (MLX is not concurrent).
"""
from __future__ import annotations

import os
import wave

NL_MAX_RECOGNIZABLE = 0.5   # >0.5 stops resembling the source (re-imagine guard, 05 §6)
NL_MIN = 0.01               # <0.01 is a near-identity encode round-trip → not worth a render


def clamp_nl(nl: float, lab: bool) -> float:
    """Authoritative re-imagine noise guard (05 §6). Reject a degenerate sub-NL_MIN value
    (a near-identity no-op) in BOTH modes. Normal mode clamps to NL_MAX_RECOGNIZABLE (0.5):
    above it the render stops resembling the source AND the onset prior reasserts as a
    per-window pulse in whole-clip stitch (measured 2026-07-17). Lab UNLOCKS the raw range
    (no upper clamp): nl=1.0 == generate-from-scratch (the engine blends
    `init_lat*(1-nl) + noise*nl`, so at 1.0 the source is fully gone); nl>1.0 is degenerate
    but the user's call. Kept in lockstep with ui/src/ui/reimagineAmount.ts (NL_MIN/NL_MAX)."""
    nlv = float(nl)
    if nlv < NL_MIN:
        raise ValueError(f"nl={nlv} below {NL_MIN}: degenerate (no audible change)")
    return nlv if lab else min(nlv, NL_MAX_RECOGNIZABLE)


def _wav_meta(path):
    with wave.open(path, "rb") as w:
        return w.getframerate(), w.getnchannels(), w.getnframes()


def available() -> bool:
    from sa3 import engine as E
    if E.engine_available():
        return True

    try:
        from adapters import stable_audio3_cuda as cuda
        return cuda.available()
    except Exception:
        return False


def backend_name() -> str:
    from sa3 import engine as E
    if E.engine_available():
        return "mlx"

    try:
        from adapters import stable_audio3_cuda as cuda
        if cuda.available():
            return "cuda"
    except Exception:
        pass
    return "unavailable"


def render(input_wav: str, output_wav: str, params: dict) -> dict:
    # Lazy heavy imports (only when an SA3 job actually runs).
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/
    from sa3 import engine as E
    from sa3 import init_cache, qa
    from colors import runtime as CR

    if not E.engine_available():
        try:
            from adapters import stable_audio3_cuda as cuda
            if cuda.available():
                return cuda.render(input_wav, output_wav, params)
        except Exception:
            raise
        raise RuntimeError("stable_audio3 unavailable (no MLX or Windows CUDA backend found)")

    import clip_coverage   # whole-clip tile/stitch (service/ is on sys.path from the insert above)

    output_wav = os.path.abspath(output_wav)
    os.makedirs(os.path.dirname(output_wav), exist_ok=True)   # clean success on a fresh dest dir
    input_wav = os.path.abspath(input_wav) if input_wav else input_wav

    prompt = params.get("prompt") or ""
    seed = int(params.get("seed", 0))
    colors = params.get("colors") or []
    lab = bool(params.get("lab", False))
    # MOSH_COLOR_ORTHO (experiment, default OFF ⇒ byte-identical): de-correlate same-layer
    # colour stacks. Owner-gated by ear via the A/B harness before it can become a default;
    # promoting it to a real toggle later MUST fold the flag into the cache fingerprint.
    ortho_on = os.environ.get("MOSH_COLOR_ORTHO", "").strip().lower() not in ("", "0", "false", "no", "off")
    steers = CR.resolve_steers(colors, lab=lab, orthogonalize=ortho_on, with_envelopes=True)   # 4-tuples: (L, α, vec, envelope)

    eng = E.get_engine()                                    # singleton; first call loads the model

    # LoRA rack: apply the selection to the DiT weights at RUNTIME (in-memory, no
    # disk bake, no reload) — idempotent on the selection key; empty == stock.
    # The key folds in each file's sha12 so a retrained same-name adapter never
    # reuses a stale in-memory application mid-session.
    import time as _time
    from loras import registry as LR
    lora_sel = LR.resolve(params.get("loras") or [], lab=lab)
    lora_recs = {r["name"]: r for r in LR.list_loras()}
    loras_key = "|".join(f"{n}@{s}@{lora_recs.get(n, {}).get('sha12', '')}"
                         for n, _f, s in lora_sel)                # "" == stock
    _t0 = _time.perf_counter()
    eng.apply_loras(lora_sel, loras_key)
    apply_ms = round((_time.perf_counter() - _t0) * 1000.0, 1)

    # Trigger auto-inject (owner's progressive-disclosure call): each active
    # adapter's trigger token joins the prompt server-side, in rack order,
    # deduplicated — surfaced only in the UI tooltip, never typed by the user.
    triggers = []
    for n, _f, _s in lora_sel:
        t = (lora_recs.get(n, {}).get("trigger") or "").strip()
        if t and t not in triggers and t.lower() not in prompt.lower():
            triggers.append(t)
    if triggers:
        prompt = ", ".join(triggers + ([prompt] if prompt else []))

    has_src = bool(input_wav) and os.path.exists(input_wav)

    def _render_window(in_wav, out_wav, p):
        # ONE SA3 window (<= eng.SECONDS). Re-imagine when this window has a source + nl, else
        # generate. The coverage orchestrator slices a long clip into windows / one loop cycle.
        win_src = bool(in_wav) and os.path.exists(in_wav)
        nl = p.get("nl", None)
        init_status = "n/a"
        if win_src and nl is not None:
            nlv = clamp_nl(nl, lab)     # 0.5 cap in normal mode, uncapped in Lab
            init_lat, init_status = init_cache.get_or_encode(eng, in_wav)
            eng.reimagine(prompt, seed, init_lat, init_noise_level=nlv, steers=steers, out_wav=out_wav)
            mode = "audio_to_audio"
        else:
            eng.generate(prompt, seed, steers=steers, out_wav=out_wav)
            mode = "text_to_audio"
        sr, ch, nframes = _wav_meta(out_wav)
        return {
            "ok": True, "adapter": "stable_audio3", "mode": mode,
            "duration_s": round(nframes / float(sr), 3),
            "sample_rate": sr, "channels": ch,
            "seconds_pinned": eng.SECONDS,
            "init_cache": init_status,
            "steers": [{"layer": t[0], "alpha": round(t[1], 4),
                        "scheduled": len(t) > 3 and t[3] is not None} for t in steers],
            "loras": [{"name": n, "strength": s,
                       "sha12": lora_recs.get(n, {}).get("sha12", "")}
                      for (n, _f, s) in lora_sel],
            "loras_applied": bool(lora_sel),
            "triggers_injected": triggers,
            "lora_apply": "runtime",
            "apply_ms": apply_ms,
            "pq": None, "pq_base": None, "flags": [],
        }

    # Contiguous-first: retarget the engine to the clip's OWN length (capped at MAX_CONTIGUOUS)
    # so it renders in ONE smooth pass with no windowing seams. clip_coverage.render then takes the
    # single-pass path whenever the clip fits, and only stitches for clips past the ceiling. The
    # retarget is a cheap in-place reconfigure (no weight reload) — see engine.set_seconds.
    target_len = float(params.get("duration_s") or 0.0)
    if target_len <= 0.0 and has_src:
        import stitch
        target_len = stitch.wav_duration(input_wav)
    if target_len > 0.0:
        eng.set_seconds(target_len)

    manifest = clip_coverage.render(_render_window, input_wav, output_wav, params, float(eng.SECONDS))
    # Best-effort QA on the FINAL (tiled/stitched) output (judges venv); never fails the render.
    qa.augment_manifest(manifest, output_wav, source_wav=input_wav if has_src else None)
    return manifest
