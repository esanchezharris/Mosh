#!/usr/bin/env python3
"""Build the BLIND rating pack for the reward-validity probe.

Generates the quality-spread candidate set (variator), renders + scores each through the real
engine with the activated §12 composite (probe_score), loudness-normalizes every clip to the
reward's own target RMS, and writes:

  <out>/clips/NNN.wav        the blind pack — randomized order, NO scores anywhere near it
  <out>/RATINGS.csv          index + blank `rating` (1..7) + blank `notes` for the owner
  <out>/AB_PAIRS.csv         ~14 A/B pairs (blank `winner`) for a pairwise sanity check
  <out>/README.txt           how to rate
  <out>/.mapping.json        PRIVATE index→{cand_id,group,label,intent, pq,clean,pull,composite}
                             (analyze.py reads this AFTER ratings return; do not peek per-clip)

The pack is loudness-normalized identically to what the reward scored (probe_score.normalize_for_
listening) so neither the owner nor the reward judges loudness. Render failures are dropped from
the pack and logged (no silent truncation). Deterministic: candidate programs + the shuffle seed
are fixed, so re-running reproduces the same pack + scores (rendering/scoring are deterministic).

  TEARDOWN_PY build_pack.py --out ~/mosh-reward-probe [--limit N] [--window-s 10]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path

import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from samples import catalog, offgenre_asset           # noqa: E402
from variator import build_candidates, WINDOW_S        # noqa: E402
import probe_score                                      # noqa: E402

SHUFFLE_SEED = 20260629  # fixed → reproducible blind order (mapping is private regardless)


def pick_ab_pairs(by_group: dict, index_of: dict, rng) -> list[dict]:
    """~14 pairs spanning quality gaps: per base, tight vs a bad variant; + a few good/good and
    bad/bad controls. Each side is the SHUFFLED pack index."""
    pairs = []
    groups = [g for g in by_group if g != "anchor"]
    rng.shuffle(groups)
    bad_labels = ["groove_drunk", "tempo_off", "key_clash", "mud_clip"]
    for g in groups[:10]:
        labels = by_group[g]
        if "tight" in labels:
            bl = next((b for b in bad_labels if b in labels), None)
            if bl:
                pairs.append({"A": index_of[(g, "tight")], "B": index_of[(g, bl)],
                              "_meta": f"{g}: tight vs {bl}"})
    # control: two different bases' tight (both good → expect a near call)
    tights = [g for g in groups if "tight" in by_group[g]]
    if len(tights) >= 4:
        pairs.append({"A": index_of[(tights[0], "tight")], "B": index_of[(tights[1], "tight")],
                      "_meta": "good vs good (control)"})
        pairs.append({"A": index_of[(tights[2], "groove_drunk")], "B": index_of[(tights[3], "mud_clip")],
                      "_meta": "bad vs bad (control)"})
    return pairs


def main():
    ap = argparse.ArgumentParser(description="Build the blind reward-validity rating pack")
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-reward-probe"))
    ap.add_argument("--limit", type=int, default=0, help="render only the first N candidates (smoke)")
    ap.add_argument("--window-s", type=float, default=WINDOW_S)
    a = ap.parse_args()

    out = Path(a.out)
    clips = out / "clips"
    clips.mkdir(parents=True, exist_ok=True)

    cat = catalog()
    cands = build_candidates(cat, offgenre_asset())
    if a.limit:
        cands = cands[: a.limit]
    print(f"[probe] {len(cands)} candidates from {len(cat)} bases; rendering…", flush=True)

    oracle, reward, info = probe_score.make_engine(range_s=a.window_s)
    print(f"[probe] reward: {info}", flush=True)

    scored = []   # {cand_id, group, label, intent, pq, clean, pull, composite, y, sr}
    fails = []
    for i, c in enumerate(cands):
        r = probe_score.render_and_score(oracle, reward, c["program"], session=f"probe_{c['cand_id']}")
        if not r.get("ok"):
            fails.append({"cand_id": c["cand_id"], "error": r.get("error")})
            print(f"  [{i+1}/{len(cands)}] {c['cand_id']:28s} FAIL {r.get('error')}", flush=True)
            continue
        scored.append({**{k: c[k] for k in ("cand_id", "group", "label", "intent")},
                       "pq": r["pq"], "clean": r["clean"], "pull": r["pull"], "composite": r["composite"],
                       "rms": r["rms"], "peak": r["peak"], "y": r["y"], "sr": r["sr"]})
        print(f"  [{i+1}/{len(cands)}] {c['cand_id']:28s} ok "
              f"comp={r['composite']:.3f} (pull={r['pull']:.3f} pq={r['pq']:.2f} clean={r['clean']:.2f})", flush=True)

    if not scored:
        print("[probe] no candidates rendered — aborting.", flush=True)
        return 1

    # ── randomize → assign blind indices → write pack + normalized clips ──
    rng = random.Random(SHUFFLE_SEED)
    order = list(range(len(scored)))
    rng.shuffle(order)
    mapping = {}            # "001" → private record
    index_of = {}           # (group,label) → "001"
    by_group: dict = {}
    for new_i, si in enumerate(order, start=1):
        s = scored[si]
        idx = f"{new_i:03d}"
        yn = probe_score.normalize_for_listening(reward, s["y"], s["sr"])
        sf.write(str(clips / f"{idx}.wav"), yn, s["sr"], subtype="PCM_16")
        mapping[idx] = {k: s[k] for k in ("cand_id", "group", "label", "intent",
                                          "pq", "clean", "pull", "composite", "rms", "peak")}
        index_of[(s["group"], s["label"])] = idx
        by_group.setdefault(s["group"], {})[s["label"]] = idx

    # ── RATINGS.csv (blank), AB_PAIRS.csv, README, private mapping ──
    rate_lines = ["index,rating,notes  # rating = 1 (worst) .. 7 (best) musical quality; notes optional"]
    rate_lines += [f"{idx},," for idx in sorted(mapping)]
    (out / "RATINGS.csv").write_text("\n".join(rate_lines) + "\n")

    ab = pick_ab_pairs(by_group, index_of, random.Random(SHUFFLE_SEED + 1))
    ab_lines = ["pair,A,B,winner  # winner = A or B (which sounds musically better); leave blank to skip"]
    ab_pub = []
    for k, p in enumerate(ab, start=1):
        ab_lines.append(f"{k},{p['A']},{p['B']},")
        ab_pub.append({"pair": k, "A": p["A"], "B": p["B"]})   # _meta withheld (it hints quality)
    (out / "AB_PAIRS.csv").write_text("\n".join(ab_lines) + "\n")

    (out / ".mapping.json").write_text(json.dumps(
        {"mapping": mapping, "ab_pairs": [{**p} for p in ab], "fails": fails,
         "reward_version": info.get("version")}, indent=1))
    # public AB (no meta) so analyze can read pairs without me seeing the quality hint inline
    (out / ".ab_public.json").write_text(json.dumps(ab_pub, indent=1))

    (out / "README.txt").write_text(
        "MOSH REWARD-VALIDITY PROBE — blind rating pack\n"
        "================================================\n\n"
        f"{len(mapping)} short (~{int(a.window_s)}s) loops in clips/ (001.wav .. {max(mapping)}.wav),\n"
        "in RANDOM order. They span deliberately good→bad musical quality. All are loudness-\n"
        "matched, so judge MUSIC (groove, timbre, coherence), not volume.\n\n"
        "1) RATINGS.csv — for every index, put a number 1 (worst) to 7 (best) in the `rating`\n"
        "   column for how good it sounds to you as music. Optional free-text in `notes`.\n"
        "2) AB_PAIRS.csv — for each pair, listen to clip A then clip B and write A or B in\n"
        "   `winner` (whichever sounds musically better). Skip any you're unsure on.\n\n"
        "Rate fast and on instinct — first impression is fine. Don't open .mapping.json\n"
        "(it holds the hidden machine scores; peeking would bias the test).\n")

    print(f"\n[probe] WROTE {len(mapping)} clips → {clips}", flush=True)
    print(f"[probe] render fails: {len(fails)}" + (f" {[f['cand_id'] for f in fails]}" if fails else ""), flush=True)
    comps = [m["composite"] for m in mapping.values()]
    pulls = [m["pull"] for m in mapping.values() if m["pull"] is not None]
    print(f"[probe] composite range {min(comps):.3f}..{max(comps):.3f} | "
          f"pull range {min(pulls):.3f}..{max(pulls):.3f} (spread {max(pulls)-min(pulls):.3f})", flush=True)
    print(f"[probe] pack: {out}  (RATINGS.csv, AB_PAIRS.csv, README.txt)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
