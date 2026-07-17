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
import subprocess
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/
import quality_readout  # noqa: E402
from audio_io import write_wav  # noqa: E402
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


_NSF_CLI = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "nsf", "nsf_cli.py")


def _nsf_py() -> str:
    """The isolated NSF venv python (torch/librosa/soundfile). Overridable for tests."""
    return os.environ.get("MOSH_NSF_PY") \
        or os.path.expanduser("~/Library/Mosh/venvs/nsf/bin/python3")


def _nsf_model() -> str:
    return os.environ.get("NSF_MODEL") or os.path.expanduser(
        "~/AI/pc-nsf-hifigan/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02/model.ckpt")


def nsf_available() -> bool:
    """The PC-NSF-HiFiGAN re-vocode post-step (recipe step 6 — natural dynamics + clean
    pitch). SHIPPED OFF: the OpenVPI weights are CC BY-NC-SA (non-commercial), so
    MOSH_ENABLE_NSF=1 is an explicit owner opt-in and a public release needs a self-trained
    MIT checkpoint. Also requires the isolated nsf venv python + the checkpoint on disk."""
    if os.environ.get("MOSH_ENABLE_NSF", "0") != "1":
        return False
    cli = os.environ.get("MOSH_NSF_CLI", _NSF_CLI)
    return os.path.isfile(_nsf_py()) and os.path.isfile(_nsf_model()) and os.path.isfile(cli)


def _nsf_revocode(output_wav: str) -> bool:
    """Re-vocode the (snapped) render through PC-NSF-HiFiGAN for natural dynamics + clean
    pitch. Subprocess under the nsf venv — importing nsf_cli in-process poisons
    numba/librosa (documented). True on a successful swap; on any failure the original
    output is untouched (the caller flags nsf_failed)."""
    cli = os.environ.get("MOSH_NSF_CLI", _NSF_CLI)
    tmp = output_wav + ".nsf.wav"
    proc = subprocess.run([_nsf_py(), cli, output_wav, tmp, "revoice"],
                          capture_output=True, text=True,
                          timeout=int(os.environ.get("MOSH_NSF_TIMEOUT_S", "300")))
    ok = proc.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 44
    if not ok:
        if os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False
    os.replace(tmp, output_wav)
    return True


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
    write_wav(output_wav, out, 1, SR)


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


def _snap_output_to_take(output_wav: str, take_path: str, clip: dict):
    """Timing-snap the rendered output onto the take (the certified recipe's step 5, now
    in the product path): PHRASE-level alignment via soulx.perform, derived from the
    authored `clip` (the per-word stage was removed after mechanism-verify V3 — see
    perform.snap_render_to_take). Best-effort — any unreadable/empty input returns
    (False, None) and leaves the output untouched. Returns (timing_snapped: bool,
    syl_snap_median_ms: float) where the median is the MEASURED residual word-event lag
    after phrase alignment — observability, not an enforced target."""
    import statistics

    from skeleton.core import read_pcm_mono
    from soulx import perform
    rt, ro = read_pcm_mono(take_path), read_pcm_mono(output_wav)
    if not rt or not ro or not rt[0] or not ro[0]:
        return False, None
    take, sr_t = rt
    rend, sr_r = ro
    rend = perform.resample_linear(rend, sr_r, sr_t)
    snapped = perform.snap_render_to_take(take, rend, sr_t, clip)
    events = soulx_score.word_event_spans(clip)
    lags = perform.event_lags(take, snapped, sr_t, events) if events else []
    write_wav(output_wav, snapped, 1, sr_t)
    med = round(statistics.median(sorted(abs(x) * 1000.0 for x in lags)), 1) if lags else 0.0
    return True, med


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
        if authored.get("error") == "no_asserted_scored_lines":
            raise RuntimeError("no asserted words to sing — assert the lyric line first")
        if authored.get("error") == "line_overflow":
            raise RuntimeError(
                f"line has more words than flow slots ({authored.get('words')} words / "
                f"{authored.get('slots')} slots): \"{authored.get('lineText', '')}\" — "
                "shorten the line or re-confirm the flow grid")
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

    # Timing-snap (certified recipe step 5): align the render onto the take's clock when a
    # readable take is present; otherwise a clean skip that never touches the render.
    timing_snapped, syl_snap_ms, snap_skipped = False, None, False
    if input_wav and os.path.isfile(input_wav):
        try:
            timing_snapped, syl_snap_ms = _snap_output_to_take(output_wav, input_wav, clip)
        except Exception:  # noqa: BLE001 — snap is best-effort; never corrupt/lose the render
            timing_snapped = False
        snap_skipped = not timing_snapped

    # NSF re-vocode (certified recipe step 6) — SHIPPED OFF (CC-BY-NC-SA weights). Runs on
    # the snapped output; best-effort (keeps the snapped render on any failure).
    nsf_resynth, nsf_failed = False, False
    if nsf_available():
        try:
            nsf_resynth = _nsf_revocode(output_wav)
        except Exception:  # noqa: BLE001 — best-effort; never fail the render on NSF trouble
            nsf_resynth = False
        nsf_failed = not nsf_resynth

    dur = authored.get("duration_s", 0.0)
    probe_ok = True
    try:
        with wave.open(output_wav, "rb") as w:
            sr, ch, nf = w.getframerate(), w.getnchannels(), w.getnframes()
            dur = round(nf / float(sr), 3) if sr else dur
            probe_ok = nf > 0
    except Exception:  # noqa: BLE001
        sr, ch = SR, 1
        probe_ok = False
    pq = 0.55 if not real else 0.8         # honest stub: beeps are a placeholder, not a vocal
    flags = [] if real else ["placeholder_vocal"]
    if not probe_ok:
        # An unreadable/empty output (e.g. a partial scp pull) must not present as a
        # healthy render — the owner's accept/reject gate needs the honesty signal.
        pq = min(pq, 0.2)
        flags = [*flags, "output_unverified"]
    if snap_skipped:
        # A take was supplied but couldn't drive the snap (unreadable/empty) — surface it
        # so the render isn't mistaken for take-aligned.
        flags = [*flags, "snap_skipped"]
    if nsf_failed:
        flags = [*flags, "nsf_failed"]
    return {
        # backend label from the SAME gate evaluation that picked the code path —
        # backend_name() would re-evaluate available() (TOCTOU vs mid-render env changes).
        "ok": True, "adapter": "soulx", "backend": "soulx-pc" if real else "fake-sing", "mode": "sing",
        "events": authored["events"], "words": authored["words"], "rests": authored["rests"],
        "linesUsed": authored["linesUsed"], "linesSkipped": authored["linesSkipped"],
        "voiceEnrolled": bool(voice_ref_path()),
        "timingSnapped": timing_snapped, "sylSnapMedianMs": syl_snap_ms,
        "nsfResynth": nsf_resynth,
        "pq": pq, "pq_base": 0.85, "flags": flags,
        "reasoning": quality_readout.judge_reasoning(axes={"PQ": pq * 10.0}, flags=flags),
        "duration_s": dur, "sample_rate": sr, "channels": ch,
    }
