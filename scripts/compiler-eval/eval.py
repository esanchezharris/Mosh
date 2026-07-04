#!/usr/bin/env python3
"""eval.py — offline compiler eval + preference-data harness (L2 keystone).

Makes "is the compiler good?" MEASURABLE with NO RL. For each instruction in the eval set
it renders a small spread of compiler candidates (varying intensity) through the real
command surface (Mosh --run-script: compile_render → render), scores each rendered WAV with
the multi-objective oracle (service/compiler/oracle.py), and emits:

  • scoreboard.json — per instruction: every candidate + the best (the compiler's report card)
  • pairs.jsonl     — best-vs-worse preference pairs (training data for later SFT/DPO)
  • rewards.jsonl   — every scored candidate (the MOSH_RL_REWARD=audio seam a future GRPO reads)

Fake-pinned (backend:"fake") + deterministic. Corrective/vocal instructions are reported as
DECLINED (the honest boundary is part of the report, not a failure). Reuses verify.py's
proven run_script() + the Mosh session layout. This is offline tooling — NOT in the hermetic
--selftest/gate.

Run:  python3 scripts/compiler-eval/eval.py            # newest local build
      python3 scripts/compiler-eval/eval.py --bin <Mosh> --intensities 20 50 80
"""
import argparse
import glob
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "scripts" / "verify-hardware"))
sys.path.insert(0, str(ROOT / "service"))

from verify import run_script, find_binary, _mosh_session_base, failed_commands  # noqa: E402
from compiler import oracle  # noqa: E402

OUT = HERE / "artifacts"
DEFAULT_SET = HERE / "eval_set.json"
PORT = "8797"


def render_candidate(binary, instruction, intensity, idx):
    """Compile + render one candidate via the native command surface; return
    (compile_data, output_wav|None, input_wav|None, failed_commands)."""
    session = f"compeval-{idx}"
    cmds = [
        {"command": "create_track", "args": {"name": "E"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}, "capture": {"C": "clipId"}},
        {"command": "compile_render", "args": {"clipId": "${C}", "instruction": instruction,
                                               "intensity": intensity, "backend": "fake",
                                               "autoRender": True, "wait": True}},
    ]
    results, _ = run_script(binary, cmds, session, extra_env={"MOSH_SERVICE_PORT": PORT})
    comp = next((r for r in results if r.get("command") == "compile_render"), None)
    data = (comp or {}).get("data", {}) or {}
    outs = sorted(glob.glob(str(_mosh_session_base() / session / "renders" / "*" / "output.wav")))
    out = outs[0] if outs else None
    inp = str(Path(out).parent / "input.wav") if out else None
    return data, out, inp, failed_commands(results)


def main():
    ap = argparse.ArgumentParser(description="Offline compiler eval + preference-data harness")
    ap.add_argument("--bin", help="path to the Mosh binary (default: newest local build)")
    ap.add_argument("--set", default=str(DEFAULT_SET), help="eval-set JSON (list of {instruction})")
    ap.add_argument("--intensities", type=int, nargs="+", default=[25, 55, 85],
                    help="candidate intensities to sweep per instruction")
    args = ap.parse_args()

    binary = find_binary(args.bin)
    eval_set = json.loads(Path(args.set).read_text())
    OUT.mkdir(exist_ok=True)
    rewards_path, pairs_path, board_path = OUT / "rewards.jsonl", OUT / "pairs.jsonl", OUT / "scoreboard.json"
    for p in (rewards_path, pairs_path):
        if p.exists():
            p.unlink()

    print(f"binary: {binary}")
    print(f"eval set: {len(eval_set)} instructions × {len(args.intensities)} candidates\n")

    scoreboard, pairs, idx = [], [], 0
    for item in eval_set:
        instruction = item["instruction"]
        cands = []
        for intensity in args.intensities:
            idx += 1
            data, out, inp, fails = render_candidate(binary, instruction, intensity, idx)
            mode = data.get("mode")
            if mode == "unsupported":
                cands.append({"intensity": intensity, "mode": "unsupported",
                              "declined": True, "say": data.get("say"), "reward": None})
                continue
            if out is None or fails:
                cands.append({"intensity": intensity, "mode": mode, "reward": None,
                              "error": "render failed", "failed_commands": fails})
                continue
            env = data.get("envelope", {})
            scored = oracle.reward(out, inp, instruction, intent=mode or "reimagine")
            oracle.append_rewards_jsonl(
                str(rewards_path),
                oracle.rewards_jsonl_line(f"c{idx}", instruction, mode, env, scored))
            cands.append({"intensity": intensity, "mode": mode, "reward": scored["reward"],
                          "terms": scored["terms"], "flags": scored["flags"], "envelope": env})

        scored_cands = sorted([c for c in cands if c.get("reward") is not None],
                              key=lambda c: -c["reward"])
        declined = all(c.get("declined") for c in cands) and bool(cands)
        best = scored_cands[0] if scored_cands else None
        # preference pairs: the best candidate is chosen over each strictly-worse one.
        for w in scored_cands[1:]:
            if best["reward"] - w["reward"] > 1e-6:
                pairs.append({"instruction": instruction, "intent": best["mode"],
                              "chosen": best["envelope"], "rejected": w["envelope"],
                              "margin": round(best["reward"] - w["reward"], 4)})
        scoreboard.append({"instruction": instruction, "declined": declined,
                           "best_reward": best["reward"] if best else None,
                           "best": best, "candidates": cands})
        tag = "DECLINED" if declined else (f"best {best['reward']:.3f}" if best else "no render")
        print(f"  [{tag:>12}] {instruction}")

    board_path.write_text(json.dumps(scoreboard, indent=2) + "\n")
    with open(pairs_path, "w", encoding="utf-8") as f:
        for p in pairs:
            f.write(json.dumps(p) + "\n")

    rendered = [s for s in scoreboard if s["best_reward"] is not None]
    declined_n = sum(1 for s in scoreboard if s["declined"])
    mean_best = round(sum(s["best_reward"] for s in rendered) / len(rendered), 4) if rendered else None
    print(f"\n  instructions: {len(scoreboard)}  ·  rendered: {len(rendered)}  ·  declined: {declined_n}")
    print(f"  mean best reward: {mean_best}  ·  preference pairs: {len(pairs)}")
    print(f"  → {board_path}\n  → {pairs_path}\n  → {rewards_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
