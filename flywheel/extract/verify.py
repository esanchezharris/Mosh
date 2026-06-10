"""Verifier layers L2/L3 + the graded accept policy (phase0 §8).

L2 — symbolic diff: typed frame/transcript claims vs the executed session's
CANONICAL PROJECTION (the harness returns it). Far more trustworthy than
audio similarity; tutorials with rich visible state produce gold.

L3 — audio embedding similarity, RANK-calibrated per genre on the gold
(mosh render, tutorial segment) pairs. No absolute thresholds, ever. Until
an embedder + the gold distribution exist this returns status=unavailable
and the accept policy uses the documented relaxation (L4 carries silver).

Accept (spec §8): L0 ≥ 0.8 AND L1 AND
  (L2 ≥ 0.8 → gold | (L3 pass AND L4 ≥ 4) → silver | L1-only → bronze).
Relaxation while L3 is uncalibrated: silver = L4 ≥ 4 (marked in outcome).
"""
from __future__ import annotations

import json
import re


def claims_from_transcript(transcript: list[dict]) -> list[dict]:
    """Cheap, honest claims minable from narration alone (BPM mentions).
    Frame-based claims (piano roll, knobs) need the VLM pass — fixture files
    or a future Gemini-vision call supply those."""
    claims = []
    for seg in transcript:
        for m in re.finditer(r"\b(\d{2,3})\s*(?:bpm|beats per minute)\b",
                             seg["text"], re.I):
            bpm = int(m.group(1))
            if 50 <= bpm <= 220:
                claims.append({"ts": seg["start"], "kind": "bpm",
                               "value": bpm, "confidence": 0.7,
                               "source": "transcript"})
    return claims


VISION_SYSTEM = """You read DAW tutorial screenshots (FL Studio / Ableton) and
extract ONLY what is clearly visible as typed claims. Reply with ONLY a JSON
array; each claim: {"ts": <number — the timestamp you were given for that
frame>, "kind": "bpm"|"track_count"|"notes_present"|"section_present",
"value": <number or string>, "confidence": <0..1>}.

kinds:
- bpm: the tempo display value — digit-level certainty REQUIRED: the display
  is small; read each digit distinctly (beware 4 vs 6, 0 vs 8). If you cannot
  resolve individual digits at this resolution, OMIT the claim entirely. Do
  not let genre priors or numbers spoken in the tutorial influence the read.
- track_count: count of track/channel rows visible in the rack or arrangement
- notes_present: count of MIDI notes visible in a piano roll (if partially
  scrolled, report what you can count and lower the confidence)
- section_present: a named arrangement section label that is visible

Never guess. Omit a frame entirely rather than inventing a claim."""


def claims_from_frames(frame_index: list[dict], provider: str,
                       batch_size: int = 8, max_batches: int = 6) -> list[dict]:
    """Frame-state claims via the VLM (phase0 §7.4 — the strong fidelity
    signal). Keyframes only; batched; mock provider returns []. Failures
    degrade to zero claims, never crash the pipeline."""
    import sys as _sys
    from pathlib import Path as _Path
    _sys.path.insert(0, str(_Path(__file__).resolve().parents[2] / "service"))
    from agent import llm

    frames = [f for f in frame_index if f.get("ts") is not None][: batch_size * max_batches]
    claims: list[dict] = []
    for i in range(0, len(frames), batch_size):
        batch = frames[i:i + batch_size]
        user = ("Frame timestamps, in order: "
                + ", ".join(f"{f['ts']}s" for f in batch)
                + ". Extract typed claims for each frame where state is legible.")
        try:
            raw = llm.complete_with_images(provider, VISION_SYSTEM, user,
                                           [f["file"] for f in batch])
            parsed = json.loads(raw.strip().strip("`").lstrip("json"))
            for c in parsed if isinstance(parsed, list) else []:
                if isinstance(c, dict) and c.get("kind") and "value" in c:
                    c["source"] = "frame"
                    claims.append(c)
        except Exception as e:  # noqa: BLE001 — degrade, never crash (§7.3 spirit)
            print(f"  vision batch {i // batch_size}: degraded ({e})")
    return claims


def l2_score(claims: list[dict], projection_text: str,
             duration_s: float | None = None) -> dict:
    """Diff typed claims against the canonical projection. Returns
    {score, checked, hits, misses, unchecked}, score in [0,1].

    The projection is the FINAL session state, so time-dependent claims
    (track_count, notes_present) only count when they come from the last 20%
    of the video; earlier ones are reported as unchecked, never as misses.
    bpm claims check from anywhere (tempo rarely moves mid-tutorial)."""
    if not claims:
        return {"score": None, "checked": 0, "hits": 0, "misses": [],
                "unchecked": 0, "note": "no claims — L2 unavailable for this tutorial"}
    proj = json.loads(projection_text)
    cutoff = 0.8 * duration_s if duration_s else None
    hits, misses, unchecked = 0, [], 0
    for c in claims:
        if (c.get("kind") != "bpm" and cutoff is not None
                and float(c.get("ts", 0.0)) < cutoff):
            unchecked += 1
            continue
        if _check_claim(c, proj):
            hits += 1
        else:
            misses.append(f"{c['kind']}={c['value']} not in session state")
    checked = hits + len(misses)
    if checked == 0:
        return {"score": None, "checked": 0, "hits": 0, "misses": [],
                "unchecked": unchecked, "note": "no final-state claims checkable"}
    return {"score": round(hits / checked, 3), "checked": checked,
            "hits": hits, "misses": misses, "unchecked": unchecked}


def _check_claim(c: dict, proj: dict) -> bool:
    kind, value = c.get("kind"), c.get("value")
    if kind == "bpm":
        return abs(proj.get("tempo", 0.0) - float(value)) < 0.5
    if kind == "track_count":
        return len(proj.get("tracks", [])) == int(value)
    if kind == "notes_present":
        # value = expected note count in any one clip (>= matches reality of
        # partial visibility on screen).
        for t in proj.get("tracks", []):
            for clip in t.get("clips", []):
                if len(clip.get("notes", [])) >= int(value):
                    return True
        return False
    if kind == "section_present":
        return any(s.get("name") == value for s in proj.get("sections", []))
    return False        # unknown claim kinds never count as hits


def l3_score(render_path=None, reference_path=None, genre: str = "unknown") -> dict:
    """Rank-calibrated audio similarity — UNAVAILABLE until an embedder
    (CLAP/MERT) and the gold calibration distribution exist (they arrive with
    the hand-replication sprint). Interface stable; recalibrate on library or
    model-version changes."""
    return {"status": "unavailable",
            "note": "needs CLAP/MERT + gold (render, tutorial) pairs; "
                    "accept policy uses the documented L4 relaxation"}


def grade(l0: float, l1: bool, l2: dict, l3: dict, l4_mean: float) -> dict:
    """The accept policy, applied honestly. Returns {grade|None, accepted,
    policy_notes: [...]}.    """
    notes = []
    if l0 < 0.8 or not l1:
        return {"grade": None, "accepted": False,
                "policy_notes": [f"rejected: L0={l0} (<0.8) or L1={l1}"]}
    l2s = l2.get("score")
    # Gold needs the judge too (rung-1 lesson: sparse bpm/track_count claims
    # saturate L2 — a near-empty build scored 0.958. L2 verifies what's
    # claimed; the judge notices what's MISSING).
    if l2s is not None and l2s >= 0.8 and l4_mean >= 4.0:
        return {"grade": "gold", "accepted": True, "policy_notes": notes}
    if l2s is not None and l2s >= 0.8 and l4_mean < 4.0:
        notes.append(f"L2={l2s} but judge={l4_mean} (<4): gold denied, "
                     "claims likely under-cover the build")
    l3_ok = l3.get("status") == "pass"
    if l3.get("status") == "unavailable":
        notes.append("L3 uncalibrated: silver granted on L4 alone (relaxation)")
        l3_ok = True
    if l3_ok and l4_mean >= 4.0:
        return {"grade": "silver", "accepted": True, "policy_notes": notes}
    notes.append("L1-only: bronze (op-format pretraining at low weight, never instruction-following SFT)")
    return {"grade": "bronze", "accepted": True, "policy_notes": notes}
