"""Session-delta scorer — the Repo2RLEnv `pr_diff` lesson applied to Mosh.

Repo2RLEnv scores a proposed edit against the oracle MERGED DIFF on format /
file-targeting / region-overlap / LLM-judge — graded similarity, never
exact-diff. Here: "repo" = session, "merged PR" = the oracle session-delta
(tutorial replication, a human edit, a corrected step), and the comparison
runs in STATE space (Stage 8 canonical projections), which makes the op-order
non-uniqueness problem vanish — different op sequences that reach the same
state have identical projections, identical deltas, score 1.0.

  delta(proj_before, proj_after) -> typed session-delta
  score(d_attempt, d_oracle, judge=None) ->
      {entity_f1, magnitude, semantic?, composite, detail}

entity_f1  — multiset F1 over typed entity tags (track_added,
             device_added:<type>, notes_changed, send_added, ...): did the
             attempt touch the same KINDS of things? (file-targeting)
magnitude  — per-dimension similarity on how MUCH changed: tempo, note
             counts, pitch-class & onset histograms, param-change counts,
             clip totals (region-overlap/magnitude)
semantic   — optional judge hook (instruction-aware), L4's seat at the table

Consumers: the replication ladder (attempt vs Claude-corrected distance),
perturbation rewards, the envgen task contract.
"""
from __future__ import annotations

import json
from collections import Counter


# ─────────────────────────────────────────────────────────────────────────────
# delta
# ─────────────────────────────────────────────────────────────────────────────
def _proj(p) -> dict:
    return json.loads(p) if isinstance(p, str) else (p or {})


def _track_sig(t: dict) -> dict:
    notes = [n for c in t.get("clips", []) for n in c.get("notes", [])]
    return {
        "name": t.get("name", ""),
        "devices": [pl.get("type") for pl in t.get("plugins", [])],
        "clips_midi": sum(1 for c in t.get("clips", []) if c.get("type") == "midi"),
        "clips_wave": sum(1 for c in t.get("clips", []) if c.get("type") == "wave"),
        "note_count": len(notes),
        "pitch_hist": Counter(n["p"] % 12 for n in notes),
        "onset_hist": Counter(round((n["s"] % 4.0) * 4) / 4 for n in notes),
        "vol": t.get("vol", 0.0), "pan": t.get("pan", 0.0),
        "mute": t.get("mute", False), "solo": t.get("solo", False),
        "route": t.get("routeTo", -1),
        "param_values": [v for pl in t.get("plugins", []) for v in pl.get("params", [])],
        "automation_lanes": sum(len(pl.get("automation", [])) for pl in t.get("plugins", [])),
    }


def delta(proj_before, proj_after) -> dict:
    """Typed session-delta between two canonical projections."""
    b, a = _proj(proj_before), _proj(proj_after)
    bt = [_track_sig(t) for t in b.get("tracks", [])]
    at = [_track_sig(t) for t in a.get("tracks", [])]

    # Missing fields in a baseline mean the canonical defaults (empty session).
    tb, ta_ = b.get("tempo", 120.0), a.get("tempo", 120.0)
    kb, ka = b.get("key", ":"), a.get("key", ":")
    sb, sa = b.get("timeSig", [4, 4]), a.get("timeSig", [4, 4])
    d: dict = {
        "tempo": [tb, ta_] if tb != ta_ else None,
        "key": [kb, ka] if kb != ka else None,
        "time_sig": [sb, sa] if sb != sa else None,
        "sections_added": [s["name"] for s in a.get("sections", [])
                           if s["name"] not in {x["name"] for x in b.get("sections", [])}],
        "tracks_added": len(at) - len(bt),
        "devices_added": [],
        "clips_added": {"midi": 0, "wave": 0},
        "notes_delta": 0,
        "pitch_hist": Counter(),
        "onset_hist": Counter(),
        "params_changed": 0,
        "automation_added": 0,
        "mixer_moves": 0,
        "routes_changed": 0,
    }

    # Structural ordinals are canonical identity (Stage 8): compare by index;
    # tracks beyond the before-count are pure additions.
    for i, ts in enumerate(at):
        bs = bt[i] if i < len(bt) else _track_sig({})
        before_devs = Counter(bs["devices"])
        for dev in ts["devices"]:
            if before_devs[dev] > 0:
                before_devs[dev] -= 1
            else:
                d["devices_added"].append(dev)
        d["clips_added"]["midi"] += max(0, ts["clips_midi"] - bs["clips_midi"])
        d["clips_added"]["wave"] += max(0, ts["clips_wave"] - bs["clips_wave"])
        d["notes_delta"] += ts["note_count"] - bs["note_count"]
        d["pitch_hist"] += ts["pitch_hist"] - bs["pitch_hist"]
        d["onset_hist"] += ts["onset_hist"] - bs["onset_hist"]
        pb, pa = bs["param_values"], ts["param_values"]
        d["params_changed"] += sum(1 for x, y in zip(pb, pa) if abs(x - y) > 1e-6) \
                               + abs(len(pa) - len(pb))
        d["automation_added"] += max(0, ts["automation_lanes"] - bs["automation_lanes"])
        d["mixer_moves"] += int(abs(ts["vol"] - bs["vol"]) > 0.01) \
                            + int(abs(ts["pan"] - bs["pan"]) > 0.01) \
                            + int(ts["mute"] != bs["mute"]) + int(ts["solo"] != bs["solo"])
        d["routes_changed"] += int(ts["route"] != bs["route"])
    return d


# ─────────────────────────────────────────────────────────────────────────────
# score
# ─────────────────────────────────────────────────────────────────────────────
def _entity_tags(d: dict) -> Counter:
    tags: Counter = Counter()
    if d.get("tempo"):
        tags["tempo_changed"] += 1
    if d.get("key"):
        tags["key_changed"] += 1
    if d.get("time_sig"):
        tags["time_sig_changed"] += 1
    tags["section_added"] += len(d.get("sections_added", []))
    tags["track_added"] += max(0, d.get("tracks_added", 0))
    for dev in d.get("devices_added", []):
        tags[f"device_added:{dev}"] += 1
    tags["clip_added:midi"] += d.get("clips_added", {}).get("midi", 0)
    tags["clip_added:wave"] += d.get("clips_added", {}).get("wave", 0)
    if d.get("notes_delta", 0) != 0:
        tags["notes_changed"] += 1
    if d.get("params_changed", 0) > 0:
        tags["params_changed"] += 1
    tags["automation_added"] += d.get("automation_added", 0)
    if d.get("mixer_moves", 0) > 0:
        tags["mixer_moved"] += 1
    if d.get("routes_changed", 0) > 0:
        tags["route_changed"] += 1
    return tags


def _ratio_sim(x: float, y: float) -> float:
    """min/max similarity, 1.0 when both zero."""
    x, y = abs(x), abs(y)
    if x < 1e-9 and y < 1e-9:
        return 1.0
    return min(x, y) / max(x, y)


def _hist_sim(h1: Counter, h2: Counter) -> float:
    """Histogram overlap (intersection over union of counts)."""
    if not h1 and not h2:
        return 1.0
    inter = sum((h1 & h2).values())
    union = sum((h1 | h2).values())
    return inter / union if union else 1.0


def score(d_attempt: dict, d_oracle: dict, judge=None,
          instruction: str | None = None) -> dict:
    """Graded similarity of two session-deltas (never exact-match)."""
    ta, to = _entity_tags(d_attempt), _entity_tags(d_oracle)
    inter = sum((ta & to).values())
    p = inter / max(1, sum(ta.values()))
    r = inter / max(1, sum(to.values()))
    entity_f1 = round(2 * p * r / (p + r), 4) if (p + r) else (1.0 if not to and not ta else 0.0)

    dims = []
    if d_oracle.get("tempo"):
        at = (d_attempt.get("tempo") or [None, None])[1]
        ot = d_oracle["tempo"][1]
        dims.append(max(0.0, 1.0 - abs((at or 0) - ot) / 30.0) if at is not None else 0.0)
    if d_oracle.get("notes_delta", 0):
        dims.append(_ratio_sim(d_attempt.get("notes_delta", 0), d_oracle["notes_delta"]))
        dims.append(_hist_sim(Counter(d_attempt.get("pitch_hist", {})),
                              Counter(d_oracle.get("pitch_hist", {}))))
        dims.append(_hist_sim(Counter(d_attempt.get("onset_hist", {})),
                              Counter(d_oracle.get("onset_hist", {}))))
    if d_oracle.get("params_changed", 0):
        dims.append(_ratio_sim(d_attempt.get("params_changed", 0), d_oracle["params_changed"]))
    if d_oracle.get("tracks_added", 0):
        dims.append(_ratio_sim(d_attempt.get("tracks_added", 0), d_oracle["tracks_added"]))
    total_clips = lambda d: sum(d.get("clips_added", {}).values())  # noqa: E731
    if total_clips(d_oracle):
        dims.append(_ratio_sim(total_clips(d_attempt), total_clips(d_oracle)))
    magnitude = round(sum(dims) / len(dims), 4) if dims else 1.0

    out = {"entity_f1": entity_f1, "magnitude": magnitude,
           "detail": {"attempt_tags": dict(ta), "oracle_tags": dict(to),
                      "magnitude_dims": [round(x, 3) for x in dims]}}
    if judge is not None and instruction:
        verdict = judge(instruction, d_attempt, d_oracle)
        out["semantic"] = float(verdict.get("mean", 0.0)) / 5.0
        out["composite"] = round(0.45 * entity_f1 + 0.35 * magnitude + 0.2 * out["semantic"], 4)
    else:
        out["composite"] = round(0.55 * entity_f1 + 0.45 * magnitude, 4)
    return out
