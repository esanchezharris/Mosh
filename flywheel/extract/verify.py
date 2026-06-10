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


def l2_score(claims: list[dict], projection_text: str) -> dict:
    """Diff typed claims against the canonical projection. Returns
    {score, checked, hits, misses: [...]}, score in [0,1]."""
    if not claims:
        return {"score": None, "checked": 0, "hits": 0, "misses": [],
                "note": "no claims — L2 unavailable for this tutorial"}
    proj = json.loads(projection_text)
    hits, misses = 0, []
    for c in claims:
        ok = _check_claim(c, proj)
        if ok:
            hits += 1
        else:
            misses.append(f"{c['kind']}={c['value']} not in session state")
    return {"score": round(hits / len(claims), 3), "checked": len(claims),
            "hits": hits, "misses": misses}


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
    if l2s is not None and l2s >= 0.8:
        return {"grade": "gold", "accepted": True, "policy_notes": notes}
    l3_ok = l3.get("status") == "pass"
    if l3.get("status") == "unavailable":
        notes.append("L3 uncalibrated: silver granted on L4 alone (relaxation)")
        l3_ok = True
    if l3_ok and l4_mean >= 4.0:
        return {"grade": "silver", "accepted": True, "policy_notes": notes}
    notes.append("L1-only: bronze (op-format pretraining at low weight, never instruction-following SFT)")
    return {"grade": "bronze", "accepted": True, "policy_notes": notes}
