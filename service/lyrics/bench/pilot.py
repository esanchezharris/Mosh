#!/usr/bin/env python3
"""The pilot harness (FMS WS1 / M0): N full-verse candidates, formatted to be READ ALOUD.

The bench measures single masked slots. That is the right instrument for arm
comparison and the wrong one for the only question that decides this program:
*would the owner actually rap this?* A word in isolation cannot answer it — a
verse can. So this harness drives the SHIPPED generation loop over a whole
LineSpec and writes plain text, one candidate per section, nothing else.

Deliberately NOT a new model, a new prompt, or a new arm. `lyrics.core.complete`
is called exactly as the product calls it, so the read is about the product as it
exists today. Three consequences worth stating before anyone reads the output:

  * **`llm-constrained` cannot do this.** That arm fills ONE masked slot and
    returns a list of `fills`; it has no verse-scale form. `core.complete` is the
    verse-scale analogue of the same constrained prompt (syllable target ± tol,
    keep-these-words, must-end-on-a-{strict}-rhyme-with-{anchor}) and is what the
    product ships. Naming the arm in a brief is fine; calling it here is not
    possible.

  * **`complete()` returns proposals, not a verse.** `_run` yields ranked
    proposals per fillable line and skips locked ones entirely. Assembly — taking
    proposals[0], passing locked lines through, keeping index order — is this
    module's job, not core's.

  * **There is no verse-level context in the prompt.** `_build_messages` sees one
    line's own seed/target/anchor and never the surrounding bars, and lines
    generated earlier in a `complete()` call never reach a later line's prompt.
    The ONLY cross-line coupling in the loop is the group anchor (core.py:379).
    So a candidate is N independently-written bars that agree on topic, mood and
    end-rhyme and on nothing else. Say this to the owner BEFORE the sitting, or
    structural incoherence gets read as "the lines are bad".

Replay posture, stated honestly: the provider is not seeded and this path is not
cached in the product. The harness records at the seam instead (see `Recorder`),
so a candidate is recoverable exactly from the artifact and the whole run replays
bit-for-bit under MOSH_INFILL_CACHE_ONLY=1 — but a fresh run against the live API
on another day is a NEW sample. Replay reproduces the artifact, not the provider.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
import time
from typing import Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
if SERVICE not in sys.path:
    sys.path.insert(0, SERVICE)

from lyrics.bench import llm_cache, paths  # noqa: E402

REPO_ROOT = os.path.dirname(SERVICE)

# A bar that could not be generated. Visible, reads as obviously-not-a-bar when
# spoken, and carries no bracket so the read-aloud purity check stays simple.
NO_CANDIDATE = "— no candidate —"

MAX_CANDIDATES = 8


# ── assembly: proposals + locked lines → one readable verse ──────────────────────

def _locked_text(line: dict) -> str:
    """What a non-generated line contributes. Prefer the finalized text; fall back
    to a gapless seed (a producer-typed bar that was never 'finalized')."""
    txt = (line.get("text") or "").strip()
    if txt:
        return txt
    seed = (line.get("seedText") or "").strip()
    return "" if re.search(r"_{2,}", seed) else seed


def assemble_candidate(spec: dict, result: dict) -> List[dict]:
    """One candidate verse: every line of the sheet, in index order, tagged by source.

    `_run` returns entries ONLY for fillable, non-locked lines, so the lines it
    omits are exactly the ones that pass through unchanged. Keying off that
    omission (rather than re-deriving 'is this line generated?') is what keeps
    the harness from disagreeing with the loop about which bars are the model's.
    """
    props = {int(e["index"]): e.get("proposals") or [] for e in result.get("lines", [])}
    out: List[dict] = []
    for line in sorted(spec.get("lines", []), key=lambda l: int(l.get("index", 0))):
        idx = int(line.get("index", 0))
        if idx in props:
            picks = props[idx]
            top = picks[0] if picks else None
            out.append({
                "index": idx,
                "text": (top or {}).get("text") or NO_CANDIDATE,
                "source": "generated",
                "endWord": (top or {}).get("endWord") or "",
                "syllables": (top or {}).get("syllables"),
                "proposalCount": len(picks),
            })
        else:
            out.append({"index": idx, "text": _locked_text(line), "source": "locked",
                        "endWord": "", "syllables": None, "proposalCount": 0})
    return out


# ── read-aloud rendering ─────────────────────────────────────────────────────────

def render_read_aloud(candidates: List[List[dict]], *, show_context: bool) -> str:
    """The deliverable. Plain text, one candidate per section, NOTHING else.

    No scores, no syllable counts, no provider, no per-line numbering. The file is
    read out loud over a beat; anything else on the page is a distraction that
    also leaks which bar the machine wrote.
    """
    blocks: List[str] = []
    for i, cand in enumerate(candidates, start=1):
        rows = cand if show_context else [r for r in cand if r["source"] == "generated"]
        bars = [r["text"] for r in rows if (r["text"] or "").strip()]
        body = "\n".join(bars) if bars else "(nothing generated)"
        blocks.append(f"Candidate {i}\n\n{body}")
    return "\n\n\n".join(blocks) + "\n"


# ── benchmark song → verse LineSpec ──────────────────────────────────────────────

def parse_item_id(item_id: str) -> Tuple[str, int, int]:
    """`v2:rhyme:gs:10359264:s3:l2` → ('gs:10359264', 3, 2).

    songId itself contains a colon, so this splits from BOTH ends rather than
    naively on ':' — the same class of bug `sampling.arm_of` exists to avoid.
    """
    parts = item_id.split(":")
    if len(parts) < 5 or not parts[-2].startswith("s") or not parts[-1].startswith("l"):
        raise ValueError(f"unparseable itemId {item_id!r}")
    return ":".join(parts[2:-2]), int(parts[-2][1:]), int(parts[-1][1:])


def _rhyme_groups(end_words: List[str], strictness: str) -> Dict[int, str]:
    """Recover the section's rhyme scheme from the artist's real end words.

    Greedy clustering against the FIRST member of each cluster (not pairwise
    transitive closure, which chains 'A rhymes B, B rhymes C' into one giant
    class). Singletons get no group: a bar with no rhyme partner in the section
    must not be handed a spurious anchor to satisfy.
    """
    from lyrics import core as product_core
    clusters: List[List[int]] = []
    for i, w in enumerate(end_words):
        if not w:
            continue
        placed = False
        for c in clusters:
            if product_core.rhymes(w, end_words[c[0]], strictness):
                c.append(i)
                placed = True
                break
        if not placed:
            clusters.append([i])
    groups: Dict[int, str] = {}
    letter = 0
    for c in clusters:
        if len(c) < 2:
            continue
        name = chr(ord("A") + letter % 26)
        letter += 1
        for i in c:
            groups[i] = name
    return groups


def verse_spec_from_section(song: dict, si: int, *, keep_context: int = 2,
                            syllable_tol: int = 1, topic: str = "", mood: str = "",
                            strictness: str = "slant") -> dict:
    """A LineSpec shaped like a real section: the artist's syllable counts and rhyme
    scheme, the artist's opening bars locked as context, every later bar a gap.

    NOT `arms._product_spec` — that builds a 2-3 bar window around ONE masked slot,
    which is the bench's unit and not a verse. The syllable target per gap is the
    real line's own count, so the skeleton the model writes into is the one the
    artist actually performed.
    """
    from lyrics import core as product_core
    lines_text = [ln for ln in (song["sections"][si].get("lines") or []) if (ln or "").strip()]
    if not lines_text:
        raise ValueError(f"section {si} of {song.get('songId')} has no lines")

    ends = []
    for ln in lines_text:
        words = re.findall(r"[A-Za-z']+", ln)
        ends.append(words[-1] if words else "")
    groups = _rhyme_groups(ends, strictness)

    keep = max(0, min(int(keep_context), len(lines_text)))
    out_lines: List[dict] = []
    for i, ln in enumerate(lines_text):
        entry: dict = {"index": i, "role": song["sections"][si].get("kind") or "verse"}
        if i in groups:
            entry["rhymeGroup"] = groups[i]
        if i < keep:
            entry["text"] = ln
            entry["locked"] = True
        else:
            entry["seedText"] = "____"
            entry["syllableTarget"] = product_core.syllables(ln)
            entry["syllableTol"] = int(syllable_tol)
        out_lines.append(entry)

    return {"grid": "1/16", "explicit": "allow", "rhymeStrictness": strictness,
            "topic": topic, "mood": mood, "styleBias": False, "lines": out_lines}


# ── recording seam ───────────────────────────────────────────────────────────────

class Recorder:
    """Stands in for `brain_client` at `core.brain_client` (a module attribute, so
    this needs no change to the product path).

    Two jobs. It routes every call through `llm_cache` so the run replays
    bit-for-bit, and it appends the raw exchange to a transcript so "candidate 3"
    is recoverable from the artifact without re-running anything.

    **The (draw, seq) nonce is the whole correctness story.** The product path is
    UNCACHED — `_llm_propose_line` calls the provider directly — so two calls that
    happen to send the same prompt get two independent samples. Caching them by
    prompt alone collapses that into one response wearing many hats, and the
    harness would then show duplication the product does not have.

    Both axes bite, and the second was found only by reading real output:

      * across draws — `_build_messages` ignores `regen`, so draw 2 sends draw 1's
        exact prompt (pinned by `pilot_test`'s "regen does not vary the prompt");
      * **within one draw** — `_build_messages` carries no line index either, so
        two gap lines with the same syllable target and the same rhyme anchor also
        send identical prompts. On a real 11-bar verse that was 21 calls over 15
        distinct prompts, and the read-aloud came back with bars 2/5 and 4/7
        literally repeated.

    `seq` is the call ordinal within a draw rather than a line index because the
    recorder cannot see which line core is working on. It stays replay-stable: on
    a cached replay the responses are identical, so the retry loop takes the same
    branches and the call sequence is reproduced exactly.
    """

    def __init__(self, inner, cache: Optional[llm_cache.Cache] = None,
                 transcript_path: str = ""):
        self._inner = inner
        self._cache = cache
        self._transcript_path = transcript_path
        self.draw = 0
        self.seq = 0            # call ordinal WITHIN the current draw
        self.calls = 0
        self.rows: List[dict] = []

    def start_draw(self, draw: int) -> None:
        self.draw = int(draw)
        self.seq = 0

    def available(self) -> bool:
        return bool(self._inner.available())

    def chat_json(self, messages, **kw):
        self.calls += 1
        self.seq += 1
        started = time.time()
        payload = {"pilot": 1, "draw": self.draw, "seq": self.seq,
                   "messages": messages,
                   **{k: v for k, v in sorted(kw.items())}}
        if self._cache is not None:
            resp = self._cache.cached_call(payload, lambda: self._inner.chat_json(messages, **kw))
        else:
            resp = self._inner.chat_json(messages, **kw)
        row = {"draw": self.draw, "seq": self.seq, "call": self.calls,
               "latencyMs": int((time.time() - started) * 1000),
               "messages": messages, "response": resp,
               "provider": resp.get("provider"), "model": resp.get("model")}
        self.rows.append(row)
        if self._transcript_path:
            with open(self._transcript_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        return resp


# ── budget ───────────────────────────────────────────────────────────────────────

def generated_line_count(spec: dict) -> int:
    """How many bars the loop will actually write. Uses core's own `_fillable`
    rather than a local copy: a second definition of 'is this line a gap?' would
    drift from the loop and quietly mis-estimate the spend."""
    from lyrics.core import _fillable
    return sum(1 for l in spec.get("lines", [])
               if not l.get("locked") and _fillable(l))


def estimate_calls(spec: dict, n: int) -> int:
    """Upper bound. `_llm_propose_line` budgets 3 attempts per line and breaks
    early once two candidates pass, so the real count is typically well under."""
    return generated_line_count(spec) * 3 * int(n)


# ── artifacts ────────────────────────────────────────────────────────────────────

def refuse_repo_path(path: str) -> None:
    """The data rule (corpus-derived text never enters git) enforced, not remembered."""
    resolved = os.path.realpath(os.path.abspath(path))
    repo = os.path.realpath(REPO_ROOT)
    if resolved == repo or resolved.startswith(repo + os.sep):
        raise ValueError(
            f"refusing to write inside the repo tree ({resolved}). Pilot output is "
            f"conditioned on corpus lyrics and must stay under {paths.data_root()}.")


def write_artifacts(run_dir: str, *, spec: dict, candidates: List[List[dict]],
                    manifest: dict, show_context: bool) -> Dict[str, str]:
    os.makedirs(run_dir, exist_ok=True)
    read_aloud = os.path.join(run_dir, "read-aloud.txt")
    with open(read_aloud, "w", encoding="utf-8") as f:
        f.write(render_read_aloud(candidates, show_context=show_context))
    with open(os.path.join(run_dir, "candidates.jsonl"), "w", encoding="utf-8") as f:
        for i, cand in enumerate(candidates, start=1):
            f.write(json.dumps({"draw": i, "lines": cand}, ensure_ascii=False,
                               sort_keys=True) + "\n")
    with open(os.path.join(run_dir, "spec.json"), "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, sort_keys=True, indent=1)
    with open(os.path.join(run_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, sort_keys=True, indent=1)
    return {"readAloud": read_aloud, "runDir": run_dir}


# ── orchestrator ─────────────────────────────────────────────────────────────────

def run_pilot(spec: dict, *, n: int, backend: Optional[str], run_dir: str,
              show_context: bool, cache_dir: Optional[str] = None,
              source: Optional[dict] = None, argv: Optional[List[str]] = None) -> dict:
    """N draws of `core.complete` over one spec, assembled and written out."""
    from lyrics import core as product_core

    os.makedirs(run_dir, exist_ok=True)
    transcript = os.path.join(run_dir, "transcript.jsonl")
    cache = llm_cache.Cache(cache_dir) if cache_dir else None

    real_client = product_core.brain_client
    recorder = Recorder(real_client, cache=cache, transcript_path=transcript)
    line_indices = [int(l.get("index", 0)) for l in spec.get("lines", [])]

    started = _dt.datetime.utcnow().isoformat() + "Z"
    candidates: List[List[dict]] = []
    backends: List[str] = []
    product_core.brain_client = recorder
    try:
        for draw in range(1, int(n) + 1):
            recorder.start_draw(draw)
            # `regen` is a no-op on the LLM path (_llm_propose_line ignores it —
            # core.py:310) and is threaded anyway: it is what gives the FAKE
            # backend genuine N-way variety, so the artifact format is testable
            # with no key. Removing it silently makes every fake draw identical.
            regen = {i: draw - 1 for i in line_indices}
            result = product_core.complete(spec, regen=regen, backend=backend)
            backends.append(result.get("backend", ""))
            candidates.append(assemble_candidate(spec, result))
    finally:
        product_core.brain_client = real_client

    manifest = {
        "argv": argv or [],
        "startedUtc": started,
        "finishedUtc": _dt.datetime.utcnow().isoformat() + "Z",
        "candidates": int(n),
        "backends": backends,
        "showContext": bool(show_context),
        "chatCalls": recorder.calls,
        "cacheDir": cache_dir or "",
        "cacheStats": dict(cache.stats) if cache is not None else None,
        "generatedLines": generated_line_count(spec),
        "source": source or {},
        # Stated in the artifact, not only in a doc: the provider is not seeded.
        "replayNote": ("replay reproduces the artifact, not the provider — a fresh "
                       "run against the live API is a new sample"),
    }
    paths_out = write_artifacts(run_dir, spec=spec, candidates=candidates,
                                manifest=manifest, show_context=show_context)
    return {"ok": True, "runDir": run_dir, "readAloud": paths_out["readAloud"],
            "candidates": candidates, "manifest": manifest}


# ── CLI ──────────────────────────────────────────────────────────────────────────

def add_arguments(p: argparse.ArgumentParser) -> None:
    src = p.add_argument_group("spec source (exactly one)")
    src.add_argument("--spec", default="", metavar="PATH",
                     help="a LineSpec JSON file (a hand-authored skeleton)")
    src.add_argument("--item", default="", metavar="ITEM_ID",
                     help="a bench itemId; resolves to its song+section and builds "
                          "a verse spec around it")
    src.add_argument("--slice", default="", choices=["", "dev", "golden", "train"],
                     help="draw one item deterministically from that slice "
                          "(itemId-ordered, not random)")
    src.add_argument("--granularity", default="rhyme",
                     help="filter for --slice (default: rhyme)")

    v = p.add_argument_group("verse construction (--item / --slice only)")
    v.add_argument("--keep-context", type=int, default=2, metavar="N",
                   help="opening bars of the real section kept locked as context "
                        "(default 2; 0 = generate the whole verse)")
    v.add_argument("--show-context", action="store_true",
                   help="print the locked REAL bars in read-aloud.txt too. Off by "
                        "default: when the context is another artist's real bars, "
                        "showing them means you are rating a mixture and cannot "
                        "tell which bars the machine wrote")
    v.add_argument("--topic", default="")
    v.add_argument("--mood", default="")

    g = p.add_argument_group("generation")
    g.add_argument("-n", "--candidates", type=int, default=3, metavar="N",
                   help=f"candidates to emit (default 3, max {MAX_CANDIDATES})")
    g.add_argument("--backend", default="", choices=["", "llm", "fake"],
                   help="default: auto (llm when a provider is configured)")

    o = p.add_argument_group("output")
    o.add_argument("--out", default="", metavar="DIR",
                   help="default {data_root}/pilot/{UTC}-{label}/. Paths inside the "
                        "repo tree are refused (corpus-derived text never enters git)")
    o.add_argument("--label", default="", help="run-directory suffix")
    o.add_argument("--no-cache", action="store_true",
                   help="skip the response cache (the run will not be replayable)")

    b = p.add_argument_group("determinism / budget")
    b.add_argument("--seed", type=int, default=0,
                   help="fake-backend draw ordinals + a recorded provenance field. "
                        "HAS NO EFFECT ON THE LLM PATH — the provider is not seeded "
                        "and this flag does not pretend otherwise")
    b.add_argument("--yes", action="store_true", help="confirm the API spend")
    b.add_argument("--confirm-over", type=int, default=60, metavar="N",
                   help="refuse an estimated call count above this without --yes "
                        "(default 60)")


def _load_spec(args) -> Tuple[dict, dict]:
    """Returns (spec, source-descriptor)."""
    chosen = [bool(args.spec), bool(args.item), bool(args.slice)]
    if sum(chosen) != 1:
        raise ValueError("pass exactly one of --spec / --item / --slice")

    if args.spec:
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)
        return spec, {"kind": "file", "path": os.path.abspath(args.spec)}

    from lyrics.bench import sampling

    item_id = args.item
    if args.slice:
        items_path = os.path.join(paths.data_root(), "eval", f"items-{args.slice}.jsonl")
        if not os.path.exists(items_path):
            raise ValueError(f"no {items_path} — run build-eval first")
        with open(items_path, encoding="utf-8") as f:
            items = [json.loads(ln) for ln in f if ln.strip()]
        if args.granularity != "all":
            keep = set(args.granularity.split(","))
            items = [i for i in items if i["granularity"] in keep]
        if not items:
            raise ValueError(f"no {args.granularity} items in slice {args.slice}")
        drawn = sampling.balanced(items, limit=1, key=lambda i: i["granularity"],
                                  spread=lambda i: i["songId"])
        item_id = drawn[0]["itemId"]

    song_id, si, li = parse_item_id(item_id)
    song = None
    import glob as _glob
    for shard in sorted(_glob.glob(os.path.join(paths.data_root(), "corpus", "*", "*.jsonl"))):
        with open(shard, encoding="utf-8") as f:
            for ln in f:
                if not ln.strip():
                    continue
                s = json.loads(ln)
                if s.get("songId") == song_id:
                    song = s
                    break
        if song is not None:
            break
    if song is None:
        raise ValueError(f"song {song_id} not found in the corpus shards")

    spec = verse_spec_from_section(song, si, keep_context=args.keep_context,
                                   topic=args.topic, mood=args.mood)
    return spec, {"kind": "item", "itemId": item_id, "songId": song_id,
                  "sectionIndex": si, "lineIndex": li,
                  "sectionKind": song["sections"][si].get("kind", ""),
                  "keepContext": int(args.keep_context)}


def run(args) -> int:
    n = int(args.candidates)
    if not 1 <= n <= MAX_CANDIDATES:
        print(f"--candidates must be 1..{MAX_CANDIDATES}", file=sys.stderr)
        return 2
    try:
        spec, source = _load_spec(args)
    except (ValueError, OSError, json.JSONDecodeError) as e:
        print(f"{e}", file=sys.stderr)
        return 2

    if generated_line_count(spec) == 0:
        print("spec has no fillable lines — nothing to generate", file=sys.stderr)
        return 2

    backend = args.backend or None
    if backend != "fake":
        est = estimate_calls(spec, n)
        if est > int(args.confirm_over) and not args.yes:
            print(f"refusing: up to ~{est} API calls "
                  f"({generated_line_count(spec)} bars x 3 attempts x {n} draws). "
                  f"Pass --yes, lower -n, or raise --confirm-over.", file=sys.stderr)
            return 2

    label = args.label or source.get("kind", "pilot")
    ts = _dt.datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%S")
    run_dir = args.out or os.path.join(paths.subdir("pilot"), f"{ts}-{label}")
    try:
        refuse_repo_path(run_dir)
    except ValueError as e:
        print(f"{e}", file=sys.stderr)
        return 2

    cache_dir = None if args.no_cache else paths.subdir("cache", "llm")
    res = run_pilot(spec, n=n, backend=backend, run_dir=run_dir,
                    show_context=bool(args.show_context), cache_dir=cache_dir,
                    source=source, argv=sys.argv[1:])
    print(f"wrote {res['readAloud']}")
    print(f"run dir: {res['runDir']}  "
          f"({res['manifest']['generatedLines']} bars x {n} candidates, "
          f"{res['manifest']['chatCalls']} chat calls)")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="pilot",
        description="N read-aloud verse candidates from the shipped generation config.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Replay reproduces the artifact, not the provider: re-running against "
               "the live API on another day is a new sample. MOSH_INFILL_CACHE_ONLY=1 "
               "replays a recorded run bit-for-bit.")
    add_arguments(ap)
    return run(ap.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
