#!/usr/bin/env python3
"""Bulk scrape → teardown → reward-label, resilient batch runner over the §3 queue.

Iterates the §3 catalog's queued CC tutorials, runs each through the orchestrator (--render) scored by
the ACTIVATED composite reward, and accumulates `rewards.jsonl` + `promptfeed.json` (the GRPO training
data). Per-video media cleanup keeps disk bounded (the teardown bottleneck is ~minutes/video, so "mass"
is wall-clock-bounded). Resilient: a per-video failure is logged and skipped, progress persists.

    source service/teardown/.teardown.env ; export MOSH_BIN=/Applications/Mosh.app/Contents/MacOS/Mosh
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/batch_scrape.py \
        --db ~/teardown-catalog.db --n 25 --out ~/grpo-bridge --index /tmp/td-reward-index --section 60 120
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.flywheel.grpo_bridge import (append_rewards_jsonl, reward_example,  # noqa: E402
                                           save_promptfeed, seed_promptfeed)

UI_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ORCH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "orchestrate", "cli.py")


def _queued_urls(db: str, n: int) -> list[dict]:
    cli = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sourcing", "cli.py")
    r = subprocess.run([sys.executable, cli, "queue", "--db", db, "--n", str(n)],
                       capture_output=True, text=True)
    try:
        return json.loads(r.stdout).get("queued", [])
    except Exception:
        print(f"  queue failed: {r.stdout[-300:]} {r.stderr[-300:]}", file=sys.stderr)
        return []


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="bulk scrape→teardown→reward-label over the §3 queue")
    ap.add_argument("--db", required=True)
    ap.add_argument("--n", type=int, default=25)
    ap.add_argument("--out", required=True, help="dir for rewards.jsonl + promptfeed.json")
    ap.add_argument("--index", default="/tmp/td-reward-index")
    ap.add_argument("--section", nargs=2, type=float, default=[60.0, 120.0])
    ap.add_argument("--max-frames", type=int, default=16)
    ap.add_argument("--work", default="/tmp/td-batch", help="transient per-video work dir (cleaned each)")
    ns = ap.parse_args(argv)

    os.makedirs(ns.out, exist_ok=True)
    rewards_path = os.path.join(ns.out, "rewards.jsonl")
    queued = _queued_urls(ns.db, ns.n)
    print(f"  batch: {len(queued)} queued URLs → {rewards_path}", flush=True)
    programs, n_ok, n_fail = [], 0, 0
    env = dict(os.environ)
    env.setdefault("MOSH_BIN", "/Applications/Mosh.app/Contents/MacOS/Mosh")
    env["PYTHONPATH"] = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    for i, q in enumerate(queued):
        url, vid = q.get("url"), q.get("video_id", str(i))
        work = os.path.join(ns.work, vid)
        shutil.rmtree(work, ignore_errors=True)
        os.makedirs(work, exist_ok=True)
        print(f"  [{i+1}/{len(queued)}] {vid}  {q.get('title','')[:60]}", flush=True)
        try:
            r = subprocess.run(
                [sys.executable, ORCH, "--url", url, "--out", work, "--index", ns.index,
                 "--section", str(ns.section[0]), str(ns.section[1]),
                 "--max-frames", str(ns.max_frames), "--no-extract", "--render"],
                capture_output=True, text=True, timeout=1200, env=env)
            res = json.loads(r.stdout)                       # orchestrator prints the result JSON
            cmds_path = os.path.join(work, vid, "commands.json")
            prog = []
            if os.path.exists(cmds_path):
                c = json.load(open(cmds_path))
                prog = c if isinstance(c, list) else c.get("commands", [])
            scores = res.get("reward") or {}
            if prog and scores:
                rec = reward_example(prog, scores, source=url)
                append_rewards_jsonl([rec], rewards_path)
                programs.append(prog)
                n_ok += 1
                print(f"      ✓ reward={rec['reward']} pull={scores.get('pull')} has_pull={scores.get('has_pull')}",
                      flush=True)
            else:
                n_fail += 1
                print(f"      ⚠ no program/reward (degraded run)", flush=True)
        except Exception as e:
            n_fail += 1
            print(f"      ✗ {type(e).__name__}: {str(e)[:160]}", flush=True)
        finally:
            shutil.rmtree(work, ignore_errors=True)          # per-video media cleanup (disk hygiene)

    if programs:
        save_promptfeed(seed_promptfeed(programs), os.path.join(ns.out, "promptfeed.json"))
    print(f"\n  BATCH DONE: {n_ok} reward-labelled, {n_fail} skipped → {rewards_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
