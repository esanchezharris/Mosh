#!/usr/bin/env python3
"""Rung-2 audio reward — batch render+score CLI (the warm Python side of the seam).

Reads a batch of render programs (one per non-deferred policy rollout), renders each
through the native engine (`teardown.oracle.Oracle` → `Mosh --run-script`), scores the
WAV with the teardown `Reward`, and writes `{sampleId,reward,deferred,feedback}` — the
EXACT schema the GRPO trainer consumes, so swapping it for the symbolic scorer is a
one-line change in grpo.py. The TS side (scoreRolloutsAudio.mts) builds the programs
(id-remap + export_audio) and handles deferrals; this side owns the heavy render+score.

Warm by construction: the Reward (and, for the musical reward, MERT) load ONCE for the
whole batch — never per rollout (the load-per-process trap that balloons the run). A
pre-render fingerprint cache (sha256 of the canonical program, minus the export path)
skips the binary entirely for duplicate programs — the dominant feasibility lever as the
policy converges and re-samples identical completions.

  TEARDOWN_PY score_audio_cli.py --batch batch.jsonl --out rewards.jsonl \
     [--reward floor|musical] [--cache render_cache.json] [--range-s 10]

  batch.jsonl : {"sampleId","program":[{command,args[,capture]}],"wav":"/abs.wav"[,"warnings":[]]}
  rewards.jsonl: {"sampleId","reward":0..1,"deferred":false,"feedback":"..."}

Env: MOSH_BIN (else /Applications/Mosh.app), PYTHONPATH must include service/.
Floor-only (default) needs NO torch; --reward musical loads MERT + reward_head.json.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO / "service") not in sys.path:
    sys.path.insert(0, str(REPO / "service"))
# OPTIONAL: use the ACTIVATED composite reward (the sleepy-euler teardown with CompositeRewardHead
# + composite_reward.pt). Its teardown.* must WIN on the path → insert FIRST. Env-gated, so without
# MOSH_ACTIVATED_TEARDOWN this trainer's default behavior is byte-unchanged.
_act = os.environ.get("MOSH_ACTIVATED_TEARDOWN")
if _act and _act not in sys.path:
    sys.path.insert(0, _act)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def program_fingerprint(program: list) -> str:
    """sha256 over the canonical program with the export target stripped, so identical
    programs rendering to different WAV paths share one cache entry."""
    canon = []
    for c in program:
        if c.get("command") == "export_audio":
            canon.append({"command": "export_audio"})  # drop the per-sample file path
        else:
            canon.append(c)
    return hashlib.sha256(json.dumps(canon, sort_keys=True).encode()).hexdigest()


def build_reward(mode: str):
    """Floor-only → pull=None (no torch). Musical → MERT head if available, else fall
    back to floor with a loud warning (the run is then honestly floor-only)."""
    from teardown.flywheel.reward import Reward
    if mode == "musical":
        # PREFER the ACTIVATED composite reward (raw-MuQ timbre + learned timing) when available —
        # the validated head (beats raw CLAP on every axis). make_reward() is the §12 seam.
        try:
            from teardown.flywheel.grpo_bridge import make_reward
            rw, info = make_reward()
            if info.get("has_pull"):
                log(f"  ✓ ACTIVATED composite reward: {info}")
                return rw
            log(f"  ⚠ composite pull inactive ({info}) → trying MERT head")
        except Exception as e:
            log(f"  ⚠ composite reward unavailable ({type(e).__name__}: {e}) → trying MERT head")
        try:
            from teardown.flywheel.reward_encoder import TrainedRewardHead
            if TrainedRewardHead.available():
                head = TrainedRewardHead()
                # NOTE: exemplars must be attached by the caller's run setup (global anchors);
                # with none, pull is a constant 0.5 → effectively floor-only. Surfaced below.
                if not getattr(head, "_exemplars", []):
                    log("  ⚠ musical reward: no exemplars attached → pull is constant 0.5 (floor-dominated)")
                return Reward(pull=head.pull, version="reward-musical-v0")
            log("  ⚠ musical reward requested but reward_head.json absent → falling back to floor-only")
        except Exception as e:  # pragma: no cover - torch/model env dependent
            log(f"  ⚠ musical reward unavailable ({e}) → floor-only")
    return Reward(version="reward-floor-v0")


def main():
    ap = argparse.ArgumentParser(description="Rung-2 audio reward — batch render+score")
    ap.add_argument("--batch", required=True, help="jsonl: {sampleId, program, wav}")
    ap.add_argument("--out", required=True, help="jsonl: {sampleId, reward, deferred, feedback}")
    ap.add_argument("--reward", default="floor", choices=["floor", "musical"])
    ap.add_argument("--cache", default="", help="persistent fingerprint cache json (optional)")
    ap.add_argument("--range-s", type=float, default=10.0, help="render window seconds")
    ap.add_argument("--timeout-s", type=int, default=120)
    ap.add_argument("--delta", action="store_true",
                    help="reward = composite(seed+edit) − composite(seed); each item must carry seedProgram. "
                         "Banking the seed → ~0; only a genuine improvement (or breakage) moves the reward.")
    a = ap.parse_args()

    from teardown.oracle.render import Oracle

    reward = build_reward(a.reward)            # load ONCE (warm)
    oracle = Oracle(scorer=object(), range_s=a.range_s, timeout_s=a.timeout_s)  # dummy scorer — we score via Reward
    if not oracle.available():
        log(f"  ✖ Mosh binary not found at {oracle.bin} (set MOSH_BIN) — every render fails")

    cache: dict = {}
    cache_path = Path(a.cache) if a.cache else None
    if cache_path and cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text())
        except Exception:
            cache = {}

    stats = {"renders": 0, "hits": 0, "fails": 0}

    def score_program(program, session):
        """Render+score one program → (composite|None, feedback). Uses the fingerprint cache (so an
        identical program — e.g. a shared seed across a prompt's rollouts — renders once). None = render failed."""
        fp = program_fingerprint(program)
        if fp in cache:
            stats["hits"] += 1
            c = cache[fp]
            return c["reward"], c.get("feedback", "cache")
        os.environ["MOSH_SELFTEST_SESSION"] = session  # unique session so rollouts never share engine state
        try:
            y, sr = oracle.render([dict(c) for c in program])  # program carries its own export_audio target
            scores = reward.score_audio(y, sr)
            r = reward.composite(scores)
            stats["renders"] += 1
            fb = "ok " + ",".join(f"{k}={round(v, 2)}" for k, v in scores.items())
            cache[fp] = {"reward": r, "feedback": fb}
            return r, fb
        except Exception as e:
            stats["fails"] += 1
            return None, f"render_fail: {str(e)[:140]}"

    items = [json.loads(l) for l in Path(a.batch).read_text().splitlines() if l.strip()]
    out_lines = []
    for it in items:
        sid = it["sampleId"]
        full_r, full_fb = score_program(it["program"], f"rl_{sid}")
        if not a.delta:
            # absolute composite: a render failure (policy acted but produced no/broken audio) = reward 0.
            out_lines.append({"sampleId": sid, "reward": full_r if full_r is not None else 0.0,
                              "deferred": False, "feedback": full_fb})
            continue
        # delta = composite(seed+edit) − composite(seed): banking the seed → ~0, improvement → +, breakage → −
        seed_prog = it.get("seedProgram")
        if not seed_prog:
            out_lines.append({"sampleId": sid, "reward": full_r if full_r is not None else 0.0,
                              "deferred": False, "feedback": f"delta_no_seed → absolute; {full_fb}"})
            continue
        seed_r, seed_fb = score_program(seed_prog, f"rl_{sid}_seed")
        if seed_r is None:
            # the seed itself didn't render (broken startCommands) → delta undefined; fall back to absolute
            out_lines.append({"sampleId": sid, "reward": full_r if full_r is not None else 0.0,
                              "deferred": False, "feedback": f"seed_render_fail({seed_fb[:60]}) → absolute; {full_fb}"})
        elif full_r is None:
            # the EDIT broke a working seed (no/broken audio) → strong negative: 0 − seed
            out_lines.append({"sampleId": sid, "reward": round(-seed_r, 4), "deferred": False,
                              "feedback": f"delta edit-broke: 0−{round(seed_r,3)}; {full_fb}"})
        else:
            out_lines.append({"sampleId": sid, "reward": round(full_r - seed_r, 4), "deferred": False,
                              "feedback": f"delta {round(full_r,3)}−{round(seed_r,3)}={round(full_r-seed_r,4)}"})

    Path(a.out).write_text("\n".join(json.dumps(o) for o in out_lines) + "\n")
    if cache_path:
        cache_path.write_text(json.dumps(cache))
    log(f"  audio-reward{'(delta)' if a.delta else ''}: {len(items)} rollouts | "
        f"{stats['renders']} rendered, {stats['hits']} cache-hit, {stats['fails']} render-fail → {a.out}")


if __name__ == "__main__":
    main()
