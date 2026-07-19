#!/usr/bin/env python3
"""Word-campaign round driver — every instrument on a round dir + the registered verdict.

Runs the take-calibrated ASR word gate (on the PRODUCT arm, pipeline+snap — what the
owner hears at the milestone; raw-pipeline fallback), conformance, lineup, consonants,
and the note-floor leak scan, then computes the registered keep/revert verdict vs the
round-0 baseline (spec: docs/superpowers/specs/2026-07-18-fms-word-campaign-design.md):

  KEEP iff  wordDefects strictly < baseline
        AND within-1st mean regress <= 10% relative
        AND rhythm-median mean regress <= 10% relative
        AND floorLeaks == 0

CLI:  bench_wc_round.py --run <dir> [--baseline <dir>] [--no-cache]
"""
import argparse
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

GUARD_BAND = 0.10          # registered: max relative regression on either guard
NOTE_FLOOR_S = 0.15
FLOOR_TOL = 2e-4


def floor_leaks(run_dir):
    """Sung tokens (type 2/3) below the note floor across every authored score."""
    leaks = 0
    for sj in sorted(glob.glob(os.path.join(run_dir, "*_pipeline_score.json"))):
        clips = json.load(open(sj))
        for clip in clips if isinstance(clips, list) else [clips]:
            durs = [float(d) for d in str(clip["duration"]).split()]
            types = [int(t) for t in str(clip["note_type"]).split()]
            leaks += sum(1 for d, t in zip(durs, types) if t != 1 and d < NOTE_FLOOR_S - FLOOR_TOL)
    return leaks


def word_defects(gate_report):
    """The round's word score: every missing word + every syllable-deficit gap."""
    n = 0
    for s in gate_report["songs"].values():
        if "error" in s:
            continue
        n += len(s["missing"]) + len(s["sylDeficits"])
    return n


def guard_means(conf_report):
    """(mean within-1st fraction, mean rhythm |median| ms) across songs."""
    w1 = [s["summary"]["notes"]["within_1_st"] for s in conf_report.values()
          if isinstance(s, dict) and "summary" in s]
    rm = [s["summary"]["rhythm"]["abs_median_ms"] for s in conf_report.values()
          if isinstance(s, dict) and "summary" in s]
    return (sum(w1) / len(w1) if w1 else None, sum(rm) / len(rm) if rm else None)


def round_verdict(cur, base, band=GUARD_BAND):
    """The registered keep/revert rule. `cur`/`base` = {wordDefects, within1, rhythmMs,
    floorLeaks}; base=None -> this IS the baseline. Pure."""
    if cur["floorLeaks"] != 0:
        return {"keep": False, "why": f"floorLeaks={cur['floorLeaks']}"}
    if base is None:
        return {"keep": None, "why": "baseline"}
    if cur["wordDefects"] >= base["wordDefects"]:
        return {"keep": False,
                "why": f"wordDefects {cur['wordDefects']} !< {base['wordDefects']}"}
    if (cur["within1"] is not None and base["within1"]
            and cur["within1"] < base["within1"] * (1 - band)):
        return {"keep": False, "why": f"within1 guard {cur['within1']:.3f} < "
                                      f"{base['within1']:.3f} -{band:.0%}"}
    if (cur["rhythmMs"] is not None and base["rhythmMs"]
            and cur["rhythmMs"] > base["rhythmMs"] * (1 + band)):
        return {"keep": False, "why": f"rhythm guard {cur['rhythmMs']:.1f} > "
                                      f"{base['rhythmMs']:.1f} +{band:.0%}"}
    return {"keep": True, "why": "wordDefects down, guards hold"}


def _cli(mod, run_json, arm, out):
    r = subprocess.run([sys.executable, os.path.join(HERE, mod),
                        "--run", run_json, "--arm", arm, "--out", out],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{mod} failed: {r.stderr[-300:] or r.stdout[-300:]}")
    return json.load(open(out))


def run_round(run_dir, baseline_dir=None, cache=True):
    import bench_words_gate as bwg
    run_json = os.path.join(run_dir, "own_run.json")

    # the word gate judges the PRODUCT arm; fall back to the raw render if snap missing
    arm = "pipeline+snap"
    if not glob.glob(os.path.join(run_dir, "*_pipeline_snap.wav")):
        arm = "pipeline"
    gate = bwg.gate_run(run_dir, arm=("pipeline_snap" if arm == "pipeline+snap" else arm),
                        cache=cache)
    json.dump(gate, open(os.path.join(run_dir, "words_gate.json"), "w"), indent=1)

    conf = _cli("bench_target_conformance.py", run_json, "pipeline+snap",
                os.path.join(run_dir, "conformance.json"))
    _cli("bench_lineup.py", run_json, "pipeline+snap", os.path.join(run_dir, "lineup.json"))
    _cli("bench_consonants.py", run_json, "pipeline", os.path.join(run_dir, "consonants.json"))

    w1, rm = guard_means(conf)
    cur = {"wordDefects": word_defects(gate), "within1": w1, "rhythmMs": rm,
           "floorLeaks": floor_leaks(run_dir), "gateArm": arm, "gatePass": gate["pass"]}
    base = None
    if baseline_dir:
        bv = json.load(open(os.path.join(baseline_dir, "wc_verdict.json")))
        base = bv["cur"]
    verdict = {"cur": cur, "base": base, **round_verdict(cur, base)}
    json.dump(verdict, open(os.path.join(run_dir, "wc_verdict.json"), "w"), indent=1)
    return verdict


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--baseline", default=None)
    ap.add_argument("--no-cache", action="store_true")
    a = ap.parse_args()
    v = run_round(a.run, a.baseline, cache=not a.no_cache)
    c = v["cur"]
    print(f"wordDefects={c['wordDefects']} gate={'GREEN' if c['gatePass'] else 'RED'} "
          f"within1={c['within1']} rhythmMs={c['rhythmMs']} floorLeaks={c['floorLeaks']}")
    print(f"VERDICT: {v['keep']} — {v['why']}")


if __name__ == "__main__":
    main()
