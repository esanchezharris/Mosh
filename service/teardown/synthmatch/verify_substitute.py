#!/usr/bin/env python3
"""REAL §8-SUBSTITUTE proof — the regime the §13 census says is core (only ~50% of
tutorials show a readable patch, so the rest must be approximated with an OWNED synth).

Construction: render a target tone with a FOREIGN synth (Vital), then drive CMA-ES over an
OWNED synth's (Serum's) audible params to approximate it in the §6 embedding space. Success
is an APPROXIMATION — distance meaningfully reduced from the owned synth's default patch,
not necessarily zero (different synths can't match exactly; that's the point of
status=substituted, confidence reduced).

Needs the binary + both Serum 2 and Vital installed. Absent either → SKIP (exit 0).

    python3 service/teardown/synthmatch/verify_substitute.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.oracle.score import EmbeddingScorer  # noqa: E402
from teardown.synthmatch.live import DEFAULT_NOTES, LiveSynthRenderer, screen_audible  # noqa: E402
from teardown.synthmatch.optimize import match_patch  # noqa: E402

BIN = os.environ.get("MOSH_BIN", "").strip() or "/Applications/Mosh.app/Contents/MacOS/Mosh"


def list_instruments() -> dict:
    """name → VST3 instrument pluginId."""
    if not os.path.isfile(BIN):
        return {}
    d = tempfile.mkdtemp(prefix="td-sub-find-")
    s = Path(d) / "s.jsonl"
    o = Path(d) / "o.jsonl"
    s.write_text(json.dumps({"command": "list_plugins", "args": {}}) + "\n")
    env = dict(os.environ, MOSH_RUN_SCRIPT=str(s), MOSH_RUN_SCRIPT_OUT=str(o), MOSH_SESSION_DIR=d)
    subprocess.run([BIN, "--run-script"], env=env, capture_output=True, timeout=120, check=False)
    out: dict = {}
    if o.exists():
        for ln in o.read_text().splitlines():
            if not ln.strip():
                continue
            r = json.loads(ln)
            if r.get("command") == "list_plugins":
                for p in (r.get("data") or {}).get("plugins", []):
                    if p.get("isInstrument") and p.get("format") == "VST3":
                        out.setdefault(p["name"], p["id"])
    return out


def main() -> int:
    if not os.path.isfile(BIN):
        print(f"  SKIP  Mosh binary not found at {BIN}")
        return 0
    insts = list_instruments()
    target_name = next((n for n in insts if n.startswith("Vital")), None)
    owned_name = next((n for n in insts if n.startswith("Serum 2") and "FX" not in n), None)
    if not target_name or not owned_name:
        print(f"  SKIP  need both Vital (target) + Serum (owned) — have {sorted(insts)}")
        return 0
    print(f"  target (foreign): {target_name}   owned (substitute): {owned_name}")

    scorer = EmbeddingScorer()
    foreign = LiveSynthRenderer(insts[target_name], name="Foreign", notes=DEFAULT_NOTES,
                                session_dir="/tmp/td-sub-foreign")
    owned = LiveSynthRenderer(insts[owned_name], name="Owned", notes=DEFAULT_NOTES,
                              session_dir="/tmp/td-sub-owned")

    # 1. the foreign target tone (Vital's default patch over the note)
    target = foreign.render({})
    print(f"  rendered foreign target tone")

    # 2. find the owned synth's audible params (one launch)
    ranked = screen_audible(owned, scorer, range(0, 20), lo=0.15, hi=0.85)
    audible = [idx for idx, d in ranked if d > 0.03][:3]
    print(f"  owned audible params: {[(i, round(d,3)) for i,d in ranked if d>0.03][:3]}")
    if not audible:
        print("  SKIP  no audible owned params to search over")
        return 0

    # 3. baseline: owned synth's default patch vs the foreign target
    d_default = scorer.score(owned.render({idx: 0.5 for idx in audible}), target)
    print(f"  owned default-patch distance to foreign target: {d_default:.4f}")

    # 4. CMA-ES: approximate the foreign tone with the owned synth
    t0 = time.time()
    res = match_patch(target, renderer=None, scorer=scorer, param_names=list(audible),
                      bounds=[(0.0, 1.0)] * len(audible), iters=12, popsize=6, seed=1,
                      batch_render=owned.render_batch)
    dt = time.time() - t0
    d_sub = res["distance"]
    improve = (d_default - d_sub) / d_default * 100 if d_default > 0 else 0.0
    print(f"  substituted patch: { {k: round(v,3) for k,v in res['params'].items()} }")
    print(f"  distance: {d_default:.4f} -> {d_sub:.4f}  ({improve:.0f}% closer to the foreign "
          f"tone)  in {dt:.0f}s")

    fails = []
    if not (d_sub < d_default):
        fails.append(f"substitution did not improve on the default patch ({d_default:.3f}->{d_sub:.3f})")
    if not (improve >= 10.0):
        fails.append(f"approximation gain < 10% ({improve:.0f}%)")
    if not all(res["history"][i] >= res["history"][i + 1] - 1e-9 for i in range(len(res["history"]) - 1)):
        fails.append("optimizer history not non-increasing")

    if fails:
        print("\n  FAIL: " + "; ".join(fails))
        return 1
    print(f"\n  PASS — owned synth ({owned_name}) approximated a foreign synth ({target_name}) "
          f"tone via render-in-the-loop ({improve:.0f}% closer). status=substituted.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
