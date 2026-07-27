"""Sitting preflight — look at the real artifact before it costs anyone an hour.

Every validity bug this program hit was caught by a human looking at output, not
by its 245 unit tests: those all ran on synthetic fixtures and verified
mechanisms in isolation. A mechanism can be perfect and the artifact still
worthless — sitting 1 was 64 correctly-minted, correctly-blinded, perfectly
deterministic pairs drawn from ONE song.

So this checks the thing actually being shipped to the human, and it is cheap
enough (milliseconds) that there is no excuse for skipping it.

BLOCKERS stop the sitting. WARNINGS are judgement calls the owner should see
before spending the time.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence

MIN_SONG_RATIO = 0.5      # distinct songs per pair
MIN_CONTEXT_BARS = 4      # below this, flow is unjudgeable (owner's finding)
MIN_DISCRIMINATING = 0.25  # share of pairs where the columns disagree
SECONDS_PER_PAIR = 30      # two ratings per pair under the I2c instrument
SECONDS_TO_PLAY = 45       # pulling the track up and finding the section
MAX_HIDDEN_SHARE = 0.45   # above this the control has eaten the sitting
MIN_ANCHOR_TRUTH = 4      # human bars the ceiling estimate rests on


def _song_of(entry: dict) -> str:
    parts = (entry.get("itemId") or "").split(":")
    return (parts[2] + ":" + parts[3]) if len(parts) > 3 else "?"


def _numeric_id(song: str) -> Optional[int]:
    tail = song.split(":")[-1]
    return int(tail) if tail.isdigit() else None


def check_sitting(pairs: Sequence[dict], key: Dict[str, dict],
                  columns: Optional[Dict[str, Dict[str, Optional[int]]]] = None,
                  corpus_id_range: Optional[tuple] = None) -> dict:
    blockers: List[str] = []
    warnings: List[str] = []
    columns = columns or {}
    distinct = {p["pairId"] for p in pairs}
    songs = [_song_of(key[p]) for p in distinct if p in key]
    n_songs = len(set(songs))

    # 1. one-song / few-song collapse
    if distinct and n_songs / max(1, len(distinct)) < MIN_SONG_RATIO:
        blockers.append(
            f"song collapse: {len(distinct)} pairs drawn from only {n_songs} "
            f"song(s) — the sitting would measure one writer, not taste")

    # 2. era front-loading. Genius ids run roughly chronological, so a draw whose
    #    ids sit in the bottom of the CORPUS range is a draw of old material.
    #    Without that reference the question is unanswerable — so we skip it
    #    rather than guess (ids 0-39 are "oldest" or "everything" depending).
    ids = [i for i in (_numeric_id(s) for s in set(songs)) if i is not None]
    if corpus_id_range and len(ids) >= 8:
        lo, hi = corpus_id_range
        span = (hi - lo) or 1
        median = sorted(ids)[len(ids) // 2]
        if (median - lo) / span < 0.15:
            warnings.append(
                f"era skew: the median drawn song id sits in the bottom "
                f"{100 * (median - lo) / span:.0f}% of the corpus range — ids "
                f"track release order, so this draw is old material")

    # 3. do the columns ever disagree? (labels that separate nothing)
    discriminating = 0
    constant_cols = []
    for name, col in columns.items():
        live = [v for v in col.values() if v is not None]
        if live and len(set(live)) < 2:
            constant_cols.append(name)
    for pid in distinct:
        vals = [columns[c].get(pid) for c in columns]
        live = [v for v in vals if v is not None]
        if len(live) >= 2 and len(set(live)) > 1:
            discriminating += 1
    if columns and distinct:
        share = discriminating / len(distinct)
        if share < MIN_DISCRIMINATING:
            blockers.append(
                f"only {discriminating}/{len(distinct)} pairs make the metrics "
                f"disagree — the rest cannot separate one column from another, "
                f"so most of the sitting buys nothing")
    for name in constant_cols:
        warnings.append(f"column '{name}' is CONSTANT — it has no skill to "
                        f"measure and will ride the base rate")

    # 4. expected label balance
    kinds: Dict[str, int] = {}
    for pid in distinct:
        kinds[key[pid].get("kind", "?")] = kinds.get(key[pid].get("kind", "?"), 0) + 1
    if kinds.get("vs_arm", 0) == 0 and kinds.get("vs_truth", 0) > 0:
        warnings.append(
            "every pair is machine-vs-human: if the arms are simply worse, the "
            "labels come back one-sided and no metric can be elected (this is "
            "what voided sitting 1)")

    # 5. flow context depth
    ctx = [len(p.get("before") or []) + len(p.get("after") or []) for p in pairs]
    if ctx:
        median = sorted(ctx)[len(ctx) // 2]
        if median < MIN_CONTEXT_BARS:
            warnings.append(
                f"thin context: median {median} surrounding bars — flow and "
                f"rhyme scheme are not inferable, so ratings will be noisy")

    # 6. can the owner actually PLAY these? (I2c) The first un-blinded mint
    #    passed every check above and was still unusable: 22 long-tail songs
    #    nobody can find, so "listen to the flow" was impossible on all of them.
    shown = sum(1 for p in pairs if not p.get("identityHidden")
                and p.get("artist"))
    n_hidden = len(pairs) - shown
    if pairs and shown == 0:
        blockers.append(
            "no pair names its song — the whole point of the un-blinded sitting "
            "is that the owner can play the track and hear the flow")
    elif pairs and n_hidden / len(pairs) > MAX_HIDDEN_SHARE:
        blockers.append(
            f"{n_hidden}/{len(pairs)} pairs hide their song — the control "
            f"stratum has eaten the sitting; lower --blind-frac")
    elif pairs and n_hidden == 0:
        warnings.append(
            "no control stratum: with every song named there is no way to tell "
            "a judge disagreement apart from the un-blinding itself")

    # 7. the ceiling's sample size. Under per-fill rating the human bar is rated
    #    on every vs_truth pair, but only the ANCHOR ones are an unbiased
    #    sample — so that count, not the total, is what the ceiling rests on.
    anchor_truth = sum(1 for pid in distinct
                       if key.get(pid, {}).get("kind") == "vs_truth"
                       and key.get(pid, {}).get("selection") == "anchor")
    if anchor_truth < MIN_ANCHOR_TRUTH:
        warnings.append(
            f"only {anchor_truth} anchor-stratum human bars — the ceiling "
            f"('how often does the real bar itself work?') will be too thin to "
            f"compare an arm against")

    return {
        "blockers": blockers, "warnings": warnings,
        "stats": {
            "pairs": len(pairs), "distinctPairs": len(distinct),
            "distinctSongs": n_songs,
            "kinds": kinds,
            "discriminatingPairs": discriminating,
            "identityShown": shown, "identityHidden": n_hidden,
            "anchorTruthPairs": anchor_truth,
            "medianContextBars": sorted(ctx)[len(ctx) // 2] if ctx else 0,
            "estMinutes": round(len(pairs) * SECONDS_PER_PAIR / 60),
            "estMinutesIfPlayed": round(
                len(pairs) * SECONDS_PER_PAIR / 60
                + n_songs * SECONDS_TO_PLAY / 60),
        },
    }


def render(report: dict) -> str:
    s = report["stats"]
    lines = ["— sitting preflight —",
             f"  {s['pairs']} pairs ({s['distinctPairs']} distinct) across "
             f"{s['distinctSongs']} songs · {s['kinds']}",
             f"  {s['discriminatingPairs']} pairs actually separate the metrics · "
             f"median {s['medianContextBars']} context bars",
             f"  {s.get('identityShown', 0)} songs named / "
             f"{s.get('identityHidden', 0)} control · "
             f"{s.get('anchorTruthPairs', 0)} anchor human bars (the ceiling)",
             f"  ≈{s['estMinutes']} min of rating, "
             f"≈{s.get('estMinutesIfPlayed', s['estMinutes'])} min if you play "
             f"every track"]
    for b in report["blockers"]:
        lines.append(f"  BLOCKER: {b}")
    for w in report["warnings"]:
        lines.append(f"  warning: {w}")
    if not report["blockers"]:
        lines.append("  → clear to run")
    return "\n".join(lines)
