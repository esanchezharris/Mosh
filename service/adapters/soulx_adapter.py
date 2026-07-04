"""SoulXAdapter (FMS Phase-3 Stage 2) — mode:"sing": sing the lyric sheet in the
owner's own voice, driven by the take's persisted flow (Stage 1's `lyricScore`).

FAKE-FIRST (the FakeAdapter→SA3 / transform→RAVE posture): the shipped backend is a
deterministic LEGATO-BEEP score renderer — it authors the REAL SoulX target score
(service/soulx/score.py, the KS-A-validated shape) and then renders that score audibly:
one tone per word event, pitch GLIDING across note_type-3 continuations with no
re-attack, silence for <SP> rests. What you hear is exactly what the real model will be
told to sing — score bugs are audible before any GPU is involved. Zero install, stdlib
`wave` only.

The REAL backend is SoulX-Singer on the OWNER'S PC over SSH (Stage-3 decision
2026-07-04; voice data never leaves his hardware): env-gated behind
MOSH_SOULX_SSH_HOST (+ the enrolled reference in ~/Library/Mosh/voice/), dispatched to
service/soulx/pc_render.sh. MOSH_ENABLE_SOULX=0 forces the fake even when configured —
the deterministic-selftest pin, mirroring MOSH_ENABLE_TRANSFORM. Consent wall v0:
locked-to-self — ONE enrolled voice per install; watermarking is a logged ship-gate
before any public release.
"""
from __future__ import annotations

import json
import math
import os
import struct
import subprocess
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/
import quality_readout  # noqa: E402
from soulx import score as soulx_score  # noqa: E402

SR = 44100
GLIDE_S = 0.04
AMP = 0.5


def voice_ref_path() -> str:
    """The locked-to-self enrollment reference (v0: ONE voice per install)."""
    d = os.environ.get("MOSH_VOICE_DIR", os.path.expanduser("~/Library/Mosh/voice"))
    for name in ("reference.wav", "reference-30s.wav", "reference-10s.wav"):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    return ""


def available() -> bool:
    """True when the REAL PC backend is configured: MOSH_SOULX_SSH_HOST set AND an
    enrolled voice reference exists. MOSH_ENABLE_SOULX=0 forces the fake regardless
    (the deterministic selftest pin, mirrors MOSH_ENABLE_TRANSFORM)."""
    if os.environ.get("MOSH_ENABLE_SOULX", "1") == "0":
        return False
    return bool(os.environ.get("MOSH_SOULX_SSH_HOST", "") and voice_ref_path())


def backend_name() -> str:
    return "soulx-pc" if available() else "fake-sing"


def _midi_hz(p: float) -> float:
    return 440.0 * (2.0 ** ((p - 69) / 12.0))


def _octave_lift(pitches) -> int:
    """Whole-octave lift so the FAKE beeps are audible on real speakers (the KS-B
    lesson: low-register takes render as sine rumble). Contour preserved; the real
    backend sings the un-lifted score."""
    ps = sorted(p for p in pitches if p > 0)
    if not ps:
        return 0
    med = ps[len(ps) // 2]
    return max(0, round((69 - med) / 12.0)) * 12


def _groups_from_clip(clip: dict):
    """Score tokens -> [(start_s, [(pitch, dur_s), ...]), ...] singable groups.
    A type-2 token opens a group; type-3 tokens extend it; type-1 rests advance time."""
    durs = [float(d) for d in clip["duration"].split()]
    pitches = [int(p) for p in clip["note_pitch"].split()]
    types = [int(t) for t in clip["note_type"].split()]
    groups, t = [], 0.0
    for d, p, nt in zip(durs, pitches, types):
        if nt == 2:
            groups.append((t, [(p, d)]))
        elif nt == 3 and groups:
            groups[-1][1].append((p, d))
        t += d
    return groups, t


def _render_fake(output_wav: str, clip: dict) -> None:
    """Deterministic legato-beep render of the authored score (mono 16-bit 44.1k)."""
    groups, total = _groups_from_clip(clip)
    lift = _octave_lift([p for _, segs in groups for p, _ in segs])
    n_total = int(total * SR) + SR // 4
    out = [0.0] * n_total
    for g_start, segs in groups:
        g_dur = sum(d for _, d in segs)
        s0, s1 = int(g_start * SR), min(int((g_start + g_dur) * SR), n_total)
        if s1 <= s0:
            continue
        # segment boundaries within the group (relative seconds)
        bounds, acc = [], 0.0
        for _, d in segs[:-1]:
            acc += d
            bounds.append(acc)

        def hz_at(rel: float) -> float:
            i = 0
            while i < len(bounds) and rel >= bounds[i]:
                i += 1
            f_cur = _midi_hz(segs[i][0] + lift)
            if i < len(bounds) and bounds[i] - rel < GLIDE_S:          # glide INTO the next note
                f_next = _midi_hz(segs[i + 1][0] + lift)
                return f_cur + (f_next - f_cur) * (1.0 - (bounds[i] - rel) / GLIDE_S) * 0.5
            if i > 0 and rel - bounds[i - 1] < GLIDE_S:                # glide OUT of the previous
                f_prev = _midi_hz(segs[i - 1][0] + lift)
                mid = 0.5 * (f_prev + f_cur)
                return mid + (f_cur - mid) * ((rel - bounds[i - 1]) / GLIDE_S)
            return f_cur

        fade = max(1, min(int(0.008 * SR), (s1 - s0) // 3))
        phase = 0.0
        for i in range(s0, s1):
            rel = (i - s0) / SR
            phase += 2.0 * math.pi * hz_at(rel) / SR
            env = min(1.0, (i - s0) / fade, (s1 - i) / fade)
            out[i] += AMP * env * math.sin(phase)
    os.makedirs(os.path.dirname(os.path.abspath(output_wav)), exist_ok=True)
    with wave.open(output_wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(v * 32767))))
                               for v in out))


def _render_real(output_wav: str, score_json: str) -> None:
    """Ship the score + enrolled reference to the owner's PC over SSH and pull the sung
    WAV back (service/soulx/pc_render.sh — bring-up per service/soulx/PC_RUNBOOK.md).
    Raises on failure so the job surfaces an error (no silent fake fallback once the
    real backend is CONFIGURED — a wrong-voice render must never masquerade)."""
    script = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "soulx", "pc_render.sh")
    proc = subprocess.run(
        ["/bin/bash", script, score_json, voice_ref_path(), output_wav],
        capture_output=True, text=True, timeout=int(os.environ.get("MOSH_SOULX_TIMEOUT_S", "900")),
    )
    if proc.returncode != 0 or not os.path.isfile(output_wav):
        raise RuntimeError(f"soulx pc render failed: {(proc.stderr or proc.stdout)[-400:]}")


def render(input_wav: str, output_wav: str, params: dict) -> dict:
    """mode:"sing" — author the SoulX target score from params["lines"] (text +
    Stage-1 lyricScore blobs), write it next to the output as target_score.json (a
    debuggable artifact on BOTH backends), then render: fake legato-beeps (default)
    or the PC SSH backend (env-gated). input_wav (the staged take) is part of the
    fingerprint but not consumed by the fake."""
    lines = params.get("lines") or []
    for ln in lines:                       # tolerate JSON-string score blobs
        if isinstance(ln.get("score"), str):
            try:
                ln["score"] = json.loads(ln["score"])
            except (json.JSONDecodeError, ValueError):
                ln["score"] = None
    authored = soulx_score.author_score(lines)
    if not authored.get("ok"):
        raise RuntimeError("no scored lines to sing — build a flow from a take first "
                           "(build_skeleton_from_clip), then accept/write the words")

    clip = authored["score"][0]
    score_json = os.path.join(os.path.dirname(os.path.abspath(output_wav)), "target_score.json")
    with open(score_json, "w") as f:
        json.dump(authored["score"], f, indent=1)

    real = available()
    if real:
        _render_real(output_wav, score_json)
    else:
        _render_fake(output_wav, clip)

    dur = authored.get("duration_s", 0.0)
    try:
        with wave.open(output_wav, "rb") as w:
            sr, ch, nf = w.getframerate(), w.getnchannels(), w.getnframes()
            dur = round(nf / float(sr), 3) if sr else dur
    except Exception:  # noqa: BLE001
        sr, ch = SR, 1
    pq = 0.55 if not real else 0.8         # honest stub: beeps are a placeholder, not a vocal
    flags = [] if real else ["placeholder_vocal"]
    return {
        "ok": True, "adapter": "soulx", "backend": backend_name(), "mode": "sing",
        "events": authored["events"], "words": authored["words"], "rests": authored["rests"],
        "linesUsed": authored["linesUsed"], "linesSkipped": authored["linesSkipped"],
        "voiceEnrolled": bool(voice_ref_path()),
        "pq": pq, "pq_base": 0.85, "flags": flags,
        "reasoning": quality_readout.judge_reasoning(axes={"PQ": pq * 10.0}, flags=flags),
        "duration_s": dur, "sample_rate": sr, "channels": ch,
    }
