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

from lyrics.bench import (arms, build_eval, calibrate, calibrate_page,  # noqa: E402
                          accept_set, canaries, contamination, norming,
                          preflight,
                          ingest, judge, llm_cache, mask, metrics, paths,
                          mixpairs, panel, pilot, runner, sampling, scoreboard,
                          scrape, torchjudge)

REPO_ROOT = os.path.dirname(SERVICE)
SCOREBOARD_MD = os.path.join(REPO_ROOT, "docs", "fms-lyrics-bench", "SCOREBOARD.md")
# Arms that call a paid API. Membership does two things: it wires up the chat
# client, and it arms the budget guard (refuse a full slice without --limit/--yes).
# An arm missing from here fails with a bare "'NoneType' object is not callable"
# AND silently escapes the spend check — both of which happened to
# prompt-rhyme-menu on its first run.
API_ARMS = ("llm-zeroshot", "llm-constrained", "prompt-rhyme-menu",
             "nbest-rerank", "fusion-rerank")

# Arms that run on LOCAL weights. Deliberately NOT in API_ARMS: they cost no
# money, so the budget guard must not fire on them. The guard they need instead
# is an interpreter check — without mlx-lm every item would return `unavailable`
# and the run would complete looking like a slice of honest zeros.
LOCAL_ARMS = ("local-unconstrained", "local-constrained-endword",
              "local-constrained-endword-fp")


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
        report = ingest.pull_genius(dataset=args.dataset, limit=args.limit,
                                    min_year=args.min_year)
    elif args.what == "scrape":
        names = [a.strip() for a in (args.artists or "").split(",") if a.strip()]
        if args.top_artists:
            # Discovery: the dump knows who was active up to its 2022 cutoff;
            # Genius has their 2023+ material, which is where current slang is.
            names += [a for a in scrape.rank_recent_artists(
                _load_corpus(), top=args.top_artists, since=args.since)
                if a not in names]
        if args.charts:
            cf = os.path.join(HERE, "fixtures", "chart_artists.json")
            with open(cf, encoding="utf-8") as f:
                names = [a for a in json.load(f)["artists"] if a not in names] + names
        if not names:
            names = list(_golden_spec().get("artists") or [])
        print(f"scraping {len(names)} artists (min_year={args.min_year}, "
              f"<= {args.max_per_artist} songs each)", flush=True)
        report = scrape.scrape_artists(names, max_per_artist=args.max_per_artist,
                                       min_year=args.min_year,
                                       workers=args.workers, sleep=args.req_interval)
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
    if args.min_views:
        # For a CALIBRATION sitting the owner has to be able to play the track —
        # a bar's rhythm only exists against the beat. The corpus is ~88%
        # long-tail, so an unfiltered draw is 22 songs nobody can find, which is
        # what the first un-blinded mint produced. Genius views are the fame
        # proxy already in the record.
        #
        # This is deliberately NOT the default: fame is the memorization
        # confound, so ARM evaluation keeps the low-fame bucket as its headline
        # (PROGRAM.md I3). Findable-first applies to calibration only.
        views = {s["songId"]: (s.get("views") or 0) for s in _load_corpus()}
        before = len(items)
        items = [i for i in items if views.get(i["songId"], 0) >= args.min_views]
        print(f"min-views {args.min_views:,}: {before:,} → {len(items):,} items "
              f"across {len({i['songId'] for i in items})} songs")
        if not items:
            print("no items clear that views floor", file=sys.stderr)
            return 2
    items = sampling.balanced(items, limit=args.limit,
                              key=lambda i: i["granularity"],
                              spread=lambda i: i["songId"],
                              max_per_spread=args.max_per_song)
    if args.limit:
        print(f"drew {len(items)} items across "
              f"{len({i['songId'] for i in items})} songs")

    needs_api = args.arm in API_ARMS or (args.arm == "product-llm"
                                         and args.product_backend == "llm")
    if needs_api and not args.limit and not args.yes:
        print(f"refusing: arm {args.arm} calls a paid API over {len(items)} items — "
              f"pass --limit N or --yes to confirm the full slice", file=sys.stderr)
        return 2

    from phonology.core import Pronouncer as _Pron
    _canary = canaries.run_canaries(items, _Pron())
    if not _canary["ok"]:
        print(f"CANARY FAILURE — {len(_canary['violations'])} degenerate fill(s) "
              f"scored as a pass. Every number from this run would be unreadable:",
              file=sys.stderr)
        for v in _canary["violations"][:6]:
            print(f"  {v['canary']}/{v['metric']} on {v['itemId']}: {v['why']}",
                  file=sys.stderr)
        return 2
    print(f"canaries ✓ ({_canary['assertionsChecked']} assertions over "
          f"{_canary['itemsSampled']} items)")

    # An arm that declines a granularity scores it as exact=0 (metrics.score_item
    # on an empty list), so a mixed draw would publish zeros the arm never earned.
    # Refuse before the loop rather than explain it afterwards.
    declines = arms.ARM_GRANULARITIES.get(args.arm)
    if declines:
        present = sorted({i["granularity"] for i in items})
        bad = [g for g in present if g not in declines]
        if bad and not args.yes:
            print(f"refusing: arm {args.arm} answers only {list(declines)} but the "
                  f"draw contains {bad}. Pass --granularity {declines[0]} "
                  f"(or --yes to score the declines as zeros).", file=sys.stderr)
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

    local_worker, local_cfg, arm_config = None, None, {}
    if args.arm in LOCAL_ARMS:
        from lyrics.bench import localgen
        py = localgen.resolve_python()
        if not py:
            print("no interpreter with mlx_lm found — cannot run local arms "
                  "(set LYRICS_BENCH_MLX_PY or run setup-lyrics-bench.sh --mlx)",
                  file=sys.stderr)
            return 2
        local_cfg = localgen.LocalConfig(model=args.local_model, mode=args.local_mode,
                                         run_seed=args.local_seed, k=args.k)
        local_worker = localgen.Worker(python=py, cfg=local_cfg)
        if not local_worker.start():
            print(f"local backend failed to start: {local_worker.error}",
                  file=sys.stderr)
            return 2
        # The worker's hello resolves what the config could only request, so the
        # recorded identity is the weights that ACTUALLY loaded.
        local_cfg.revision = local_worker.backend.get("revision") or ""
        arm_config = local_cfg.arm_config({
            "quant": local_worker.backend.get("quant") or {},
            "tokenizerSha": local_worker.backend.get("tokenizerSha") or "",
            "chatTemplateSha": local_worker.backend.get("chatTemplateSha") or "",
            "mlxLmVersion": local_worker.backend.get("mlxLmVersion") or ""})
        print(f"local backend: {local_cfg.model} @ {local_cfg.revision[:12]} "
              f"{arm_config.get('quant')} via {py}")

    from phonology.core import Pronouncer
    freq_path = os.path.join(paths.data_root(), "corpus", "freq_table.json")
    freq = {}
    if os.path.exists(freq_path):
        with open(freq_path, encoding="utf-8") as f:
            freq = json.load(f)

    ctx = arms.ArmContext(chat=chat, pron=Pronouncer(), freq=freq, k=args.k,
                          cache=llm_cache.Cache(os.path.join(paths.subdir("cache",
                                                                          "llm"))),
                          product_backend=args.product_backend,
                          local=local_worker, local_cfg=local_cfg,
                          arm_config=arm_config)
    ts = _dt.datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%S")
    out_dir = os.path.join(paths.subdir("runs"),
                           f"{ts}-{args.arm}-{args.slice}")
    try:
        res = runner.run_arm(args.arm, items, ctx, out_dir=out_dir,
                             song_index=contamination.song_index(_load_corpus()),
                             canary=_canary,
                             accept_sets=accept_set.load(args.slice),
                             items_by_id={i["itemId"]: i for i in items})
    finally:
        if local_worker is not None:
            local_worker.close()   # an 8GB MLX process must not outlive the bench
    print(json.dumps(res["summary"], indent=1, sort_keys=True))
    print(f"run dir: {out_dir}")
    return 0


def _judge_rows_path(slice_: str) -> str:
    return os.path.join(paths.subdir("judged"), f"judged-{slice_}.jsonl")


def _load_run_rows(run_dir: str) -> list:
    rows = []
    for p in sorted(glob.glob(os.path.join(run_dir, "results-*.jsonl"))):
        with open(p, encoding="utf-8") as f:
            rows += [json.loads(ln) for ln in f if ln.strip()]
    return rows


def cmd_judge(args) -> int:
    """Score one run's candidates against the held-out truth: LLM blind A/B panel
    plus the torch-backed emb / ppl columns. Judged granularities only."""
    items_path = os.path.join(paths.data_root(), "eval", f"items-{args.slice}.jsonl")
    if not os.path.exists(items_path):
        print(f"no {items_path} — run build-eval first", file=sys.stderr)
        return 2
    items = {}
    with open(items_path, encoding="utf-8") as f:
        for ln in f:
            if ln.strip():
                it = json.loads(ln)
                items[it["itemId"]] = it

    run_dir = args.run if os.path.isabs(args.run) else os.path.join(
        paths.data_root(), "runs", args.run)
    rows = _load_run_rows(run_dir)
    if not rows:
        print(f"no results in {run_dir}", file=sys.stderr)
        return 2

    keep = set(args.granularity.split(",")) if args.granularity != "all" else \
        set(judge.JUDGED_GRANULARITIES)
    todo = [r for r in rows if r["granularity"] in keep and r.get("candidates")]
    todo = sampling.balanced(todo, limit=args.limit,
                             key=lambda r: r["granularity"],
                             spread=lambda r: r["itemId"].rsplit(":", 2)[0])
    if not todo:
        print("nothing to judge (no candidates in the judged granularities)")
        return 0

    if not args.yes and len(todo) > args.confirm_over:
        print(f"refusing: judging {len(todo)} items x {len(judge.LENSES)} lenses x 2 "
              f"orders = {len(todo) * len(judge.LENSES) * 2} calls — pass --limit "
              f"or --yes", file=sys.stderr)
        return 2

    cache = llm_cache.Cache(paths.subdir("cache", "llm"))
    env = dict(os.environ)
    brain_env = env.get("MOSH_BRAIN_ENV") or os.path.expanduser("~/Mosh/ui/.env.local")
    if os.path.exists(brain_env):
        import re as _re
        with open(brain_env, encoding="utf-8") as f:
            for ln in f:
                m = _re.match(r'\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?([^"\n]*)"?', ln)
                if m:
                    env.setdefault(m.group(1), m.group(2))
    judges = panel.resolve_judges(env)
    if not judges:
        print("! no judge credentials — LLM panel skipped (emb/ppl still run)")
    else:
        print(f"panel: {len(judges)} models — "
              + ", ".join(j["model"] for j in judges), flush=True)

    # Drop unresolvable rows FIRST: emb/ppl score lists are positional, so a row
    # skipped later would shift every subsequent score onto the wrong item.
    todo = [r for r in todo if r["itemId"] in items]
    pairs = [(items[r["itemId"]], r["candidates"][0]) for r in todo]
    emb = torchjudge.score_pairs(pairs, kind="emb", cache=cache)
    ppl = torchjudge.score_pairs(pairs, kind="ppl", cache=cache)
    print(f"emb: {emb['status']} {emb.get('error') or ''}", flush=True)
    print(f"ppl: {ppl['status']} {ppl.get('error') or ''}", flush=True)

    out_rows = []
    for n, r in enumerate(todo):
        item = items[r["itemId"]]
        cand = r["candidates"][0]
        verdict = (judge.judge_pair_panel(item, cand, judges=judges, cache=cache)
                   if judges else {"win": None, "byJudge": {}})
        out_rows.append({
            "itemId": r["itemId"], "granularity": r["granularity"],
            "arm": sampling.arm_of(run_dir),
            "run": os.path.basename(run_dir),
            "candidate": cand, "truth": item["target"]["text"],
            # Kept so calibration can render the SAME completed lines the panel
            # judged — a bare span fragment is not a judgeable thing.
            "maskedLine": item["context"]["maskedLine"],
            "context": {"before": item["context"]["before"],
                        "after": item["context"]["after"]},
            "metrics": {"judge_win": verdict["win"],
                        "emb": emb["scores"][n] if emb["status"] == "ok" else None,
                        "ppl": ppl["scores"][n] if ppl["status"] == "ok" else None,
                        "panel_disagreement": verdict.get("disagreement"),
                        **{f"judge_{k}": (1 if v["verdict"] == "candidate" else
                                          0 if v["verdict"] == "truth" else None)
                           for k, v in verdict.get("byJudge", {}).items()}},
        })

    path = _judge_rows_path(args.slice)
    with open(path, "a", encoding="utf-8") as f:
        for row in out_rows:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    wins = [r["metrics"]["judge_win"] for r in out_rows
            if r["metrics"]["judge_win"] is not None]
    print(json.dumps({"judged": len(out_rows), "separated": len(wins),
                      "candidateWinRate": (sum(wins) / len(wins)) if wins else None,
                      "out": path, "cache": dict(cache.stats)}, indent=1))
    return 0


def cmd_calibrate(args) -> int:
    cal_dir = paths.subdir("calibration")
    pairs_path = os.path.join(cal_dir, "pairs.json")
    key_path = os.path.join(cal_dir, "blind-key.json")
    # I2c changed the instrument from forced choice to per-fill acceptability.
    # The two live in SEPARATE files: reconciling them would silently average two
    # different questions, and the archived forced-choice sittings are voided
    # anyway (sitting 1 for song collapse, sitting 3 abandoned mid-way).
    ratings_path = os.path.join(cal_dir, "ratings-v2.jsonl")

    if args.action == "make" and args.from_run_results:
        # Arm-vs-arm by ear, with no judge in the loop: the LLM panel exists to
        # produce columns, and "which of these two reads better" does not need
        # one. Pool comes straight from the named runs.
        items_path = os.path.join(paths.data_root(), "eval", "items-dev.jsonl")
        with open(items_path, encoding="utf-8") as f:
            items = {}
            for ln in f:
                if ln.strip():
                    it = json.loads(ln)
                    items[it["itemId"]] = it
        rows_by_arm = {}
        for name in [r.strip() for r in args.from_run_results.split(",") if r.strip()]:
            run_dir = os.path.join(paths.data_root(), "runs", name)
            res = glob.glob(os.path.join(run_dir, "results-*.jsonl"))
            if not res:
                print(f"no results in {name}", file=sys.stderr)
                return 2
            arm = sampling.arm_of(run_dir)
            with open(res[0], encoding="utf-8") as f:
                rows_by_arm[arm] = [json.loads(ln) for ln in f if ln.strip()]
        pool = mixpairs.pool_from_runs(rows_by_arm, items)
        shared = {r["itemId"] for r in pool if
                  sum(1 for x in pool if x["itemId"] == r["itemId"]) >= 2}
        print(f"pool: {len(pool)} rows from {sorted(rows_by_arm)} · "
              f"{len(shared)} items answered by every arm")
        songs = {s["songId"]: s for s in _load_corpus()}
        if args.tradeoff_only:
            # Keep only the items where the two arms' STRENGTHS actually split:
            # one wrote the artist's real word, the other wrote a perfect rhyme
            # that was not it. Items where both did well — or both badly —
            # cannot settle "which reads better", so spending a rater's minutes
            # on them buys nothing.
            #
            # NOT done via rank_by_disagreement: that ranks items where COLUMNS
            # split, and on a tradeoff item both columns read 1 (each arm wins
            # its own axis), so it would rank exactly the wrong items first.
            by_item = {}
            for arm, rws in rows_by_arm.items():
                for r in rws:
                    by_item.setdefault(r["itemId"], {})[arm] = r
            keep = set()
            for iid, per_arm in by_item.items():
                if len(per_arm) < 2:
                    continue
                fills = {(r.get("candidates") or [""])[0].lower()
                         for r in per_arm.values()}
                if len(fills) < 2:
                    continue                     # identical answers: nothing to rate
                matched = any(r.get("exact") for r in per_arm.values())
                perfect = any(r.get("rhyme_perfect") for r in per_arm.values())
                imperfect = any(not r.get("rhyme_perfect") for r in per_arm.values())
                if matched and perfect and imperfect:
                    keep.add(iid)
            before = len(pool)
            pool = [r for r in pool if r["itemId"] in keep]
            print(f"tradeoff filter: {before} → {len(pool)} rows "
                  f"({len(keep)} items where the arms' strengths split)")
        pairs, key = mixpairs.mint_mixed(
            pool, n=args.n, dupes=args.dupes, seed=args.seed,
            arm_frac=args.arm_frac, songs=songs, columns=None,
            anchor_frac=args.anchor_frac, blind_frac=args.blind_frac)
        stamp = {r["itemId"] + "|" + r["arm"]: r["metrics"] for r in pool}
        with open(pairs_path, "w", encoding="utf-8") as f:
            json.dump(pairs, f, ensure_ascii=False, indent=1)
        with open(key_path, "w", encoding="utf-8") as f:
            json.dump(key, f, ensure_ascii=False, indent=1)
        os.chmod(key_path, 0o600)
        with open(os.path.join(cal_dir, "machine_scores.json"), "w",
                  encoding="utf-8") as f:
            json.dump(stamp, f, indent=1, sort_keys=True)
        # Pair-level columns must be the REAL metrics, one lookup each. Passing
        # the same metric under several names makes every column identical, so
        # they can never disagree and preflight reports "0 pairs separate the
        # metrics" — a self-inflicted blocker.
        pair_cols = {}
        for col in ("exact", "rhyme_perfect", "multi_depth"):
            vals = {p: v for p, v in
                    mixpairs.column_predictions(key, stamp, col).items()
                    if v is not None}
            if vals:
                pair_cols[col] = vals
        report = preflight.check_sitting(pairs, key, pair_cols or None)
        print(preflight.render(report))
        return 1 if report["blockers"] else 0

    if args.action == "make":
        rows = []
        for slice_ in ("dev",):
            p = _judge_rows_path(slice_)
            if os.path.exists(p):
                with open(p, encoding="utf-8") as f:
                    rows += [json.loads(ln) for ln in f if ln.strip()]
        if not rows:
            print("no judged rows — run `judge` first", file=sys.stderr)
            return 2
        if args.runs:
            # judged-*.jsonl ACCUMULATES across sessions, so an unfiltered pool
            # silently mixes item sets from different eras of the bench — a
            # re-drawn sitting quietly re-inherited the pre-fix long-tail songs
            # it was minted to replace. Naming the runs makes the pool explicit.
            want = {r.strip() for r in args.runs.split(",") if r.strip()}
            before = len(rows)
            rows = [r for r in rows if r.get("run") in want]
            print(f"pool filtered to runs {sorted(want)}: {before} → {len(rows)} rows")
            if not rows:
                print("no judged rows from those runs", file=sys.stderr)
                return 2
        else:
            runs_seen = sorted({r.get("run") for r in rows})
            if len(runs_seen) > 2:
                print(f"! pool spans {len(runs_seen)} runs {runs_seen} — pass "
                      f"--runs to pin the sitting to one draw")
        # Dedupe (itemId, arm): a re-judged row must not double its odds.
        uniq = {}
        for r in rows:
            uniq[(r["itemId"], r["arm"])] = r
        pool = sorted(uniq.values(), key=lambda r: (r["arm"], r["itemId"]))
        # Rows judged before maskedLine was recorded: recover it from the items
        # so an old judged file still mints judgeable pairs.
        missing = [r for r in pool if "maskedLine" not in r]
        if missing:
            items_path = os.path.join(paths.data_root(), "eval", "items-dev.jsonl")
            lookup = {}
            if os.path.exists(items_path):
                with open(items_path, encoding="utf-8") as f:
                    for ln in f:
                        if ln.strip():
                            it = json.loads(ln)
                            lookup[it["itemId"]] = it["context"]["maskedLine"]
            for r in missing:
                r["maskedLine"] = lookup.get(r["itemId"])
        songs = {s["songId"]: s for s in _load_corpus()} if args.stanza else None
        # Disagreement weighting: most of the sitting buys discrimination, a
        # random anchor stratum keeps absolute accuracy unbiased.
        stamp0 = {r["itemId"] + "|" + r["arm"]: r["metrics"] for r in pool}
        item_cols = {}
        for col in ("judge_win", "emb", "ppl"):
            vals = {}
            for r in pool:
                v = r["metrics"].get(col)
                if v is None:
                    continue
                vals[r["itemId"]] = (int(v) if col == "judge_win"
                                     else (1 if (v < 0 if col == "ppl"
                                                 else v > 0.98) else 0))
            if vals:
                item_cols[col] = vals
        pairs, key = mixpairs.mint_mixed(pool, n=args.n, dupes=args.dupes,
                                         seed=args.seed, arm_frac=args.arm_frac,
                                         songs=songs, columns=item_cols or None,
                                         anchor_frac=args.anchor_frac,
                                         blind_frac=args.blind_frac)
        with open(pairs_path, "w", encoding="utf-8") as f:
            json.dump(pairs, f, ensure_ascii=False, indent=1)
        with open(key_path, "w", encoding="utf-8") as f:
            json.dump(key, f, ensure_ascii=False, indent=1)
        os.chmod(key_path, 0o600)
        # The machine's opinion is stamped BEFORE the owner rates (prequential).
        stamp = {r["itemId"] + "|" + r["arm"]: r["metrics"] for r in pool}
        with open(os.path.join(cal_dir, "machine_scores.json"), "w",
                  encoding="utf-8") as f:
            json.dump(stamp, f, indent=1, sort_keys=True)
        cells = {}
        for p in pairs:
            cells[f"{p['arm']}/{p['granularity']}"] = \
                cells.get(f"{p['arm']}/{p['granularity']}", 0) + 1
        # Preflight reads PAIR-level predictions. `item_cols` is keyed by itemId
        # and would silently score every pair as None — a false "nothing
        # discriminates" blocker — so re-derive the columns the way the report
        # will.
        pair_cols = {}
        for col in ("judge_win", "emb", "ppl"):
            vals = {p: v for p, v in
                    mixpairs.column_predictions(key, stamp, col).items()
                    if v is not None}
            if vals:
                pair_cols[col] = vals
        report = preflight.check_sitting(pairs, key, pair_cols or None)
        print(preflight.render(report))
        print(json.dumps({"pairs": len(pairs), "distinct": len(key),
                          "cells": cells, "pairsPath": pairs_path}, indent=1))
        return 1 if report["blockers"] else 0

    if args.action == "serve":
        if not os.path.exists(pairs_path):
            print("no pairs — run `calibrate make` first", file=sys.stderr)
            return 2
        with open(pairs_path, encoding="utf-8") as f:
            pairs = json.load(f)
        # A pair is finished only when BOTH bars are rated — resuming on "the
        # pairId appears" would drop every pair abandoned mid-way, losing the
        # second rating silently.
        with open(key_path, encoding="utf-8") as f:
            resume_key = json.load(f)
        rated = mixpairs.owner_ratings(
            calibrate_page.load_ratings(ratings_path), resume_key)
        done = {pid for pid, row in rated.items()
                if row.get("left") is not None and row.get("right") is not None}
        todo = [p for p in pairs if p["pairId"] not in done] if args.resume else pairs
        if not todo:
            print("every pair already rated — nothing to serve")
            return 0
        calibrate_page.serve(todo, ratings_path, port=args.port,
                             title="Mosh — bar calibration")
        return 0

    # report
    if not os.path.exists(key_path):
        print("no blind key — run `calibrate make` first", file=sys.stderr)
        return 2
    with open(key_path, encoding="utf-8") as f:
        key = json.load(f)
    with open(os.path.join(cal_dir, "machine_scores.json"), encoding="utf-8") as f:
        machine = json.load(f)
    ratings = calibrate_page.load_ratings(ratings_path)
    if not ratings:
        print("no ratings yet — run `calibrate serve` and do the sitting",
              file=sys.stderr)
        return 2
    # Two instruments answer two different questions; averaging them would be a
    # silent category error, so a mixed file is refused rather than reconciled.
    versions = {r.get("ratingsVersion", 1) for r in ratings}
    if len(versions) > 1:
        print(f"refusing: {ratings_path} mixes rating instruments {sorted(versions)} "
              f"— forced choice and per-fill acceptability are not the same "
              f"label. Split the file by version and report each separately.",
              file=sys.stderr)
        return 2
    owner = mixpairs.owner_labels(ratings, key)
    rated = mixpairs.owner_ratings(ratings, key)

    by_gran = {}
    for gran in sorted({v["granularity"] for v in key.values()}):
        pids = [p for p, v in key.items() if v["granularity"] == gran]
        sub_owner = {p: owner.get(p) for p in pids}
        sub_key = {p: key[p] for p in pids}
        columns = {}
        for col in ("judge_win", "emb", "ppl"):
            vals = {p: v for p, v in
                    mixpairs.column_predictions(sub_key, machine, col).items()
                    if v is not None}
            if vals:
                columns[col] = vals
        by_gran[gran] = calibrate.elect(sub_owner, columns, bar=args.bar)

    trusted = {g: {"metric": e["metric"], "agreement": e["agreement"]}
               for g, e in by_gran.items() if not e["halt"]}
    with open(os.path.join(cal_dir, "TRUSTED_METRICS.json"), "w",
              encoding="utf-8") as f:
        json.dump({"asOf": _dt.datetime.now(_dt.timezone.utc).date().isoformat(),
                   "labels": len([v for v in owner.values() if v is not None]),
                   "bar": args.bar, **trusted}, f, indent=1, sort_keys=True)
    md = calibrate.render_report(by_gran, {
        "labels": len([v for v in owner.values() if v is not None]),
        "selfConsistency": calibrate.self_consistency(ratings), "bar": args.bar,
        "acceptability": calibrate.acceptability(rated, key),
        "ceiling": calibrate.ceiling(rated, key),
        "conditions": calibrate.by_condition(rated, key)})
    with open(os.path.join(cal_dir, "agreement.md"), "w", encoding="utf-8") as f:
        f.write(md)
    print(md)
    return 0


def cmd_accept(args) -> int:
    """Tag non-exact fills the owner would still have kept.

    `exact` asks whether the arm reproduced the artist's word. This asks the
    question the arm is actually for. Reads a run's rows, shows only the items
    the arm got WRONG (the exact ones need no judgement), and records accept /
    reject per fill.
    """
    if args.action == "stats":
        sets = accept_set.load(args.slice)
        judged = sum(len(v["accept"]) + len(v["reject"]) for v in sets.values())
        print(json.dumps({"slice": args.slice, "itemsWithLabels": len(sets),
                          "judgements": judged,
                          "accepted": sum(len(v["accept"]) for v in sets.values()),
                          "rejected": sum(len(v["reject"]) for v in sets.values())},
                         indent=1))
        return 0

    run_dir = args.run if os.path.isabs(args.run) else os.path.join(
        paths.data_root(), "runs", args.run)
    rows = _load_run_rows(run_dir)
    if not rows:
        print(f"no scored rows under {run_dir}", file=sys.stderr)
        return 2
    items_path = os.path.join(paths.data_root(), "eval", f"items-{args.slice}.jsonl")
    wanted = {r["itemId"] for r in rows}
    items = {}
    with open(items_path, encoding="utf-8") as f:
        for ln in f:
            if not ln.strip():
                continue
            it = json.loads(ln)
            if it["itemId"] in wanted:
                items[it["itemId"]] = it
                if len(items) == len(wanted):
                    break

    existing = accept_set.load(args.slice)
    # Only WRONG answers need a judgement — an exact match is already a pass, and
    # asking about it would burn the owner's attention on settled items.
    todo = [r for r in rows
            if r.get("exact") == 0 and (r.get("candidates") or [])
            and metrics.normalize((r["candidates"] or [""])[0])
            not in (existing.get(r["itemId"], {}).get("accept", set())
                    | existing.get(r["itemId"], {}).get("reject", set()))]
    todo = todo[:args.limit] if args.limit else todo
    if not todo:
        print("nothing left to judge in this run")
        return 0

    print(f"{len(todo)} fill(s) to judge.  [a]ccept  [r]eject  [s]kip  [q]uit\n")
    n = 0
    for row in todo:
        it = items.get(row["itemId"])
        if not it:
            continue
        fill = (row["candidates"] or [""])[0]
        print("-" * 68)
        for line in (it["context"].get("before") or [])[-2:]:
            print(f"   {line}")
        print(f"   {metrics.apply_fill(it, fill)}")
        for line in (it["context"].get("after") or [])[:1]:
            print(f"   {line}")
        print(f"\n   the machine wrote: {fill!r}")
        try:
            ans = input("   keep it? [a/r/s/q] ").strip().lower()[:1]
        except (EOFError, KeyboardInterrupt):
            print("\nstopped.")
            break
        if ans == "q":
            break
        if ans in ("a", "r"):
            accept_set.record(args.slice, row["itemId"], fill,
                              "accept" if ans == "a" else "reject", source="cli")
            n += 1
    print(f"\nrecorded {n} judgement(s) -> {accept_set.log_path(args.slice)}")
    return 0


def cmd_norming(args) -> int:
    """Blind answer sheet so the HUMAN ceiling can be measured on our own items."""
    if args.action == "export":
        items_path = os.path.join(paths.data_root(), "eval",
                                  f"items-{args.slice}.jsonl")
        if not os.path.exists(items_path):
            print(f"no {items_path} — run build-eval first", file=sys.stderr)
            return 2
        items = []
        with open(items_path, encoding="utf-8") as f:
            for ln in f:
                if ln.strip():
                    it = json.loads(ln)
                    if it["granularity"] == args.granularity:
                        items.append(it)
        songs = {s["songId"]: s for s in _load_corpus()}
        out_dir = args.out or os.path.join(paths.subdir("norming"), "packet")
        answers = args.answers or os.path.join(paths.subdir("norming"),
                                               f"answers-{args.slice}.json")
        rep = norming.export(items, songs, out_dir=out_dir, answers_path=answers,
                             n=args.n, slice_=args.slice)
        print(json.dumps(rep, indent=1))
        print(f"\nGive the rater ONLY: {out_dir}")
        print(f"Answers withheld at: {answers}  (do not share)")
        return 0

    with open(args.answers, encoding="utf-8") as f:
        answers = json.load(f)["answers"]
    scores = []
    for sheet_path in args.sheets:
        with open(sheet_path, encoding="utf-8") as f:
            sheet = norming.parse_sheet(f.read())
        scores.append(norming.score(sheet, answers,
                                    rater=os.path.basename(sheet_path)))
    for s in scores:
        print(json.dumps(s, indent=1))
    print("\nPOOLED HUMAN CEILING:")
    print(json.dumps(norming.pool(scores), indent=1))
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
    p.add_argument("what", choices=["genius", "scrape", "own"])
    p.add_argument("--artists", default="",
                   help="comma-separated; defaults to golden_spec artists")
    p.add_argument("--max-per-artist", type=int, default=200)
    p.add_argument("--top-artists", type=int, default=0,
                   help="also scrape the N most recently-active corpus artists")
    p.add_argument("--charts", action="store_true",
                   help="seed from the researched current-charts artist list")
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--req-interval", type=float, default=0.12,
                   help="global seconds between requests (0.12 = ~8/s)")
    p.add_argument("--since", type=int, default=2020,
                   help="recency window used to rank those artists")
    p.add_argument("--dataset", default="cleaned", choices=["cleaned", "5m"])
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--min-year", type=int, default=0,
                   help="floor the release era (2015 = the owner's taste era)")
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
    p.add_argument("--max-per-song", type=int, default=0,
                   help="cap items drawn from any one song (0 = uncapped) — the "
                        "spread lever for calibration draws")
    p.add_argument("--min-views", type=int, default=0,
                   help="only items from songs at/above this Genius view count "
                        "— for calibration sittings, where the rater must be "
                        "able to play the track (never for arm evaluation)")
    p.add_argument("--yes", action="store_true")
    p.add_argument("--local-model", default=os.environ.get(
        "LYRICS_BENCH_LOCAL_MODEL", "mlx-community/Qwen2.5-14B-Instruct-4bit"),
        help="local arms: mlx-lm model id (recorded in the arm config, not the name)")
    p.add_argument("--local-mode", default="greedy", choices=["greedy", "sampled"])
    p.add_argument("--local-seed", type=int, default=0,
                   help="local arms: run-level seed; per-item seeds derive from it")
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("judge")
    p.add_argument("--run", required=True, help="run dir name under runs/")
    p.add_argument("--slice", default="dev", choices=["dev", "golden", "train"])
    p.add_argument("--granularity", default="all")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--confirm-over", type=int, default=120)
    p.add_argument("--yes", action="store_true")
    p.set_defaults(fn=cmd_judge)

    p = sub.add_parser("calibrate")
    p.add_argument("action", choices=["make", "serve", "report"])
    p.add_argument("--n", type=int, default=64)
    p.add_argument("--dupes", type=int, default=8)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--bar", type=float, default=0.65)
    p.add_argument("--resume", action="store_true", default=True)
    p.add_argument("--anchor-frac", type=float, default=0.25,
                   help="share kept as a RANDOM anchor stratum (unbiased accuracy)")
    p.add_argument("--arm-frac", type=float, default=0.5,
                   help="share of pairs that are arm-vs-arm (balanced labels)")
    p.add_argument("--blind-frac", type=float, default=0.25,
                   help="share whose SONG stays hidden — the un-blinding control")
    p.add_argument("--runs", default="",
                   help="comma-separated run dirs to draw the pool from; the "
                        "judged file accumulates, so this pins the sitting to "
                        "one draw instead of every era of the bench")
    p.add_argument("--tradeoff-only", action="store_true",
                   help="keep only items where the arms' strengths split (one "
                        "matched the artist, the other rhymed perfectly) — the "
                        "only items that can settle 'which reads better'")
    p.add_argument("--from-run-results", default="",
                   help="build the pool from these run dirs' RAW results "
                        "instead of the judged file — arm-vs-arm by ear, no "
                        "LLM panel needed and none paid for")
    p.add_argument("--stanza", action="store_true", default=True,
                   help="show the whole stanza around the gap (flow context)")
    p.set_defaults(fn=cmd_calibrate)

    # The taste instrument, not a measurement one: N whole verses from the SHIPPED
    # config, written plain for reading aloud. Flags live in pilot.add_arguments so
    # `pilot.py --help` and `bench_cli.py pilot --help` cannot drift apart.
    p = sub.add_parser("pilot", help="N read-aloud verse candidates (owner sitting)")
    pilot.add_arguments(p)
    p.set_defaults(fn=pilot.run)

    p = sub.add_parser("accept", help="tag non-exact fills the owner would keep")
    p.add_argument("action", choices=["mark", "stats"])
    p.add_argument("--run", default="", help="run dir name under runs/ (mark)")
    p.add_argument("--slice", default="dev", choices=["dev", "golden", "train"])
    p.add_argument("--limit", type=int, default=40)
    p.set_defaults(fn=cmd_accept)

    p = sub.add_parser("norming", help="blind packet to measure the human ceiling")
    p.add_argument("action", choices=["export", "score"])
    p.add_argument("--slice", default="dev", choices=["dev", "golden", "train"])
    p.add_argument("--granularity", default="rhyme")
    p.add_argument("-n", type=int, default=200)
    p.add_argument("--out", default="", help="packet dir (export)")
    p.add_argument("--answers", default="", help="withheld answer key path")
    p.add_argument("--sheets", nargs="*", default=[],
                   help="filled ANSWER-SHEET.txt files, one per rater (score)")
    p.set_defaults(fn=cmd_norming)

    p = sub.add_parser("scoreboard")
    p.set_defaults(fn=cmd_scoreboard)

    p = sub.add_parser("corpus-stats")
    p.set_defaults(fn=cmd_corpus_stats)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
