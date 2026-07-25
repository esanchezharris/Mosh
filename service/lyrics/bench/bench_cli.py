#!/usr/bin/env python3
"""FMS lyrics-bench CLI (I1). Thin over the tested modules.

  ingest genius [--dataset cleaned|5m] [--limit N]   (needs the lyrics-bench venv)
  ingest own
  build-eval [--dev-frac 0.1]
  run --arm NAME --slice dev|golden|train [--granularity g1,g2] [--limit N]
      [--k 5] [--product-backend llm|fake] [--yes]
  scoreboard
  corpus-stats

Data root: ~/Library/Mosh/lyrics-bench (MOSH_LYRICS_BENCH_DIR). Real-API arms
refuse to run without --limit unless --yes: the budget guard, not a formality —
the program's API ceiling is $50 and every response is cached.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import (arms, build_eval, ingest, llm_cache, mask,  # noqa: E402
                          paths, runner, scoreboard)

REPO_ROOT = os.path.dirname(SERVICE)
SCOREBOARD_MD = os.path.join(REPO_ROOT, "docs", "fms-lyrics-bench", "SCOREBOARD.md")
API_ARMS = ("llm-zeroshot", "llm-constrained")


def _load_corpus() -> list:
    songs = []
    for shard in sorted(glob.glob(os.path.join(paths.data_root(), "corpus", "*",
                                               "*.jsonl"))):
        with open(shard, encoding="utf-8") as f:
            for ln in f:
                if ln.strip():
                    songs.append(json.loads(ln))
    return songs


def _salt() -> str:
    p = os.path.join(paths.subdir("eval"), "salt.txt")
    if not os.path.exists(p):
        with open(p, "w", encoding="utf-8") as f:
            f.write(os.urandom(24).hex())
        os.chmod(p, 0o600)
    with open(p, encoding="utf-8") as f:
        return f.read().strip()


def _golden_spec() -> dict:
    p = os.path.join(paths.data_root(), "golden_spec.json")
    if not os.path.exists(p):
        print(f"! no golden_spec.json at {p} — golden split will be EMPTY "
              f"(copy fixtures/golden_spec.example.json there and edit)")
        return {"version": 1, "artists": [], "songs": [], "ownSources": [],
                "notes": "missing"}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def cmd_ingest(args) -> int:
    if args.what == "genius":
        report = ingest.pull_genius(dataset=args.dataset, limit=args.limit)
    elif args.what == "own":
        report = ingest.pull_own()
    else:
        print(f"unknown ingest target {args.what}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=1, sort_keys=True))
    return 0


def cmd_build_eval(args) -> int:
    from phonology.core import Pronouncer
    songs = _load_corpus()
    if not songs:
        print("no corpus shards — run `ingest` first", file=sys.stderr)
        return 2
    spec, salt = _golden_spec(), _salt()
    splits, report = build_eval.assign_splits(songs, spec, salt=salt,
                                              dev_frac=args.dev_frac)
    freq = mask.build_freq_table([s for s in songs
                                  if splits.get(s["songId"]) == "train"])
    with open(os.path.join(paths.subdir("corpus"), "freq_table.json"), "w",
              encoding="utf-8") as f:
        json.dump(freq, f, sort_keys=True)
    items, manifest = build_eval.build_items(songs, splits, Pronouncer(),
                                             golden_spec=spec, salt=salt, freq=freq)
    eval_dir = paths.subdir("eval")
    # A vanished split (e.g. golden after a spec edit) must not leave a stale
    # items file behind for `run` to silently serve.
    for stale in glob.glob(os.path.join(eval_dir, "items-*.jsonl")):
        os.remove(stale)
    handles = {}
    try:
        for item in items:
            sp = item["split"]
            if sp not in handles:
                handles[sp] = open(os.path.join(eval_dir, f"items-{sp}.jsonl"), "w",
                                   encoding="utf-8")
            handles[sp].write(json.dumps(item, ensure_ascii=False, sort_keys=True)
                              + "\n")
    finally:
        for h in handles.values():
            h.close()
    manifest["splitReport"] = report
    with open(os.path.join(eval_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
    for k in ("unmatchedArtists", "unmatchedSongs", "unmatchedOwnSources"):
        if report.get(k):
            print(f"!! golden_spec entries with NO match: {k}={report[k]}")
    print(json.dumps({"counts": report["counts"], "items": manifest["items"],
                      "quarantined": len(report["quarantined"])}, indent=1))
    return 0


def cmd_run(args) -> int:
    items_path = os.path.join(paths.data_root(), "eval", f"items-{args.slice}.jsonl")
    if not os.path.exists(items_path):
        print(f"no {items_path} — run build-eval first", file=sys.stderr)
        return 2
    with open(items_path, encoding="utf-8") as f:
        items = [json.loads(ln) for ln in f if ln.strip()]
    if args.granularity != "all":
        keep = set(args.granularity.split(","))
        items = [i for i in items if i["granularity"] in keep]
    items.sort(key=lambda i: i["itemId"])
    if args.limit:
        # Round-robin across granularities — a plain prefix of the itemId-sorted
        # list would be all "line:" items (alphabetical bias).
        by_gran = {}
        for i in items:
            by_gran.setdefault(i["granularity"], []).append(i)
        grans = sorted(by_gran)
        picked, n = [], 0
        while len(picked) < args.limit and any(by_gran.values()):
            g = grans[n % len(grans)]
            if by_gran[g]:
                picked.append(by_gran[g].pop(0))
            n += 1
        items = sorted(picked, key=lambda i: i["itemId"])

    needs_api = args.arm in API_ARMS or (args.arm == "product-llm"
                                         and args.product_backend == "llm")
    if needs_api and not args.limit and not args.yes:
        print(f"refusing: arm {args.arm} calls a paid API over {len(items)} items — "
              f"pass --limit N or --yes to confirm the full slice", file=sys.stderr)
        return 2

    chat = None
    if needs_api:
        import brain_client
        if not brain_client.available():
            print("no brain provider configured (keys) — cannot run API arms",
                  file=sys.stderr)
            return 2
        chat = brain_client.chat_json
    elif args.arm in API_ARMS:
        chat = None

    from phonology.core import Pronouncer
    freq_path = os.path.join(paths.data_root(), "corpus", "freq_table.json")
    freq = {}
    if os.path.exists(freq_path):
        with open(freq_path, encoding="utf-8") as f:
            freq = json.load(f)

    ctx = arms.ArmContext(chat=chat, pron=Pronouncer(), freq=freq, k=args.k,
                          cache=llm_cache.Cache(os.path.join(paths.subdir("cache",
                                                                          "llm"))),
                          product_backend=args.product_backend)
    ts = _dt.datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%S")
    out_dir = os.path.join(paths.subdir("runs"),
                           f"{ts}-{args.arm}-{args.slice}")
    res = runner.run_arm(args.arm, items, ctx, out_dir=out_dir)
    print(json.dumps(res["summary"], indent=1, sort_keys=True))
    print(f"run dir: {out_dir}")
    return 0


def cmd_scoreboard(_args) -> int:
    entries = []
    for summ_path in sorted(glob.glob(os.path.join(paths.data_root(), "runs", "*",
                                                   "summary-*.json"))):
        run_dir = os.path.basename(os.path.dirname(summ_path))
        slice_ = run_dir.rsplit("-", 1)[-1]
        with open(summ_path, encoding="utf-8") as f:
            entries.append({"slice": slice_, "runDir": run_dir,
                            "summary": json.load(f)})
    trusted = None
    tm = os.path.join(paths.data_root(), "calibration", "TRUSTED_METRICS.json")
    if os.path.exists(tm):
        with open(tm, encoding="utf-8") as f:
            trusted = {k: v for k, v in json.load(f).items()
                       if isinstance(v, dict)}
    md = scoreboard.render(entries, trusted)
    os.makedirs(os.path.dirname(SCOREBOARD_MD), exist_ok=True)
    with open(SCOREBOARD_MD, "w", encoding="utf-8") as f:
        f.write(md)
    print(f"wrote {SCOREBOARD_MD} ({len(entries)} runs)")
    return 0


def cmd_corpus_stats(_args) -> int:
    songs = _load_corpus()
    by_source, lines = {}, 0
    for s in songs:
        by_source[s["source"]] = by_source.get(s["source"], 0) + 1
        lines += sum(len(sec["lines"]) for sec in s["sections"])
    print(json.dumps({"songs": len(songs), "lines": lines,
                      "bySource": by_source}, indent=1, sort_keys=True))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="bench_cli")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ingest")
    p.add_argument("what", choices=["genius", "own"])
    p.add_argument("--dataset", default="cleaned", choices=["cleaned", "5m"])
    p.add_argument("--limit", type=int, default=0)
    p.set_defaults(fn=cmd_ingest)

    p = sub.add_parser("build-eval")
    p.add_argument("--dev-frac", type=float, default=0.1)
    p.set_defaults(fn=cmd_build_eval)

    p = sub.add_parser("run")
    p.add_argument("--arm", required=True)
    p.add_argument("--slice", default="dev", choices=["dev", "golden", "train"])
    p.add_argument("--granularity", default="all")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--k", type=int, default=5)
    p.add_argument("--product-backend", default="llm", choices=["llm", "fake"])
    p.add_argument("--yes", action="store_true")
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("scoreboard")
    p.set_defaults(fn=cmd_scoreboard)

    p = sub.add_parser("corpus-stats")
    p.set_defaults(fn=cmd_corpus_stats)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
