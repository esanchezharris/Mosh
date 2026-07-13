"""FlowSpec — a rhythm/pitch-GROUNDED LineSpec for Finish-My-Song (Stage 1).

A mumbled take is a *specification*, not noise: the skeleton's `lineScores` carry every
syllable's real onset, duration, velocity and MIDI pitch (see service/skeleton/core.py).
The lyric brain, though, was only ever fed a bare syllable count — and an arbitrary
"collapse 32 fragments into 8-syllable bars" step then severed the `lineScores` link, so
no generated word was tied to the time or pitch it must land on. Of course it couldn't
fit the mumble.

FlowSpec is the fix — it turns a skeleton into a LineSpec the generator (lyrics.core) and
the SoulX score author (soulx.score) both consume, WITHOUT throwing away the take:

  * group_by_rest — merge the mumble's fragments into writable PHRASE-lines, split only on
    the take's REAL rests (a gap ≥ ``gap_s`` between consecutive slots). Each phrase keeps
    its true slots verbatim, at their ABSOLUTE times, so author_score places the words back
    on the mumble's grid (the render lands where the mumble actually sang).
  * build_flow_spec — per phrase, derive the exact syllable count, a velocity-stress
    contour, a compact pitch contour (so the brain lands rhyme/payoff words on the sung
    high/held notes), a theme hint from the mumble's OWN ASR (inspiration, never required
    words), and an end-rhyme scheme. The phrase's slots ride along as an author_score-ready
    `score` blob.

Pure stdlib, deterministic. This module derives context; it never mutates the skeleton.
"""
from __future__ import annotations

import re
from typing import List, Optional

from phonology import core as _ph

_pronouncer: Optional[_ph.Pronouncer] = None


def _pron() -> _ph.Pronouncer:
    global _pronouncer
    if _pronouncer is None:
        _pronouncer = _ph.Pronouncer()
    return _pronouncer

# Trust tiers for kept mumble words (owner: "echo the sound, not the text"). A run of
# adjacent kept words stays VERBATIM only when the ASR plausibly heard a real phrase;
# otherwise the words demote to echo targets (their vowel skeleton is evidence, the text
# is not — "berry balls" is Whisper confidently mishearing the mumble).
# Mirrors lyrics.core.END_STOP_WORDS (the enforcer side) — kept local to avoid the
# heavyweight core import; both are pinned by goldens.
TRAIL_STOP_WORDS = {"a", "an", "the", "of", "to", "in", "on", "at", "by", "for", "with",
                    "and", "or", "but", "nor", "so", "yet",
                    "my", "your", "our", "their", "his", "her", "its"}

TRUST_RUN_MEAN = 0.7      # a multi-word run needs this mean confidence ...
TRUST_RUN_MAX = 0.8       # ... and at least one word this confident
TRUST_LONE = 0.9          # a lone kept word must be near-certain
TRUST_MEMBER = 0.55       # a word below this demotes even inside a trusted run
                          # (writer-round finding: "berry" 0.45 rode "feel like" 0.9+)

# Filler interjections are exempt from trust demotion (owner, 2026-07-12: "be very
# generous with placeholder rap words like yeah and huh … filler words are incredibly
# helpful (essential)") — a heard "yeah" can't be a mishearing worth demoting; it IS the
# sound, and keeping it spares the writer an awkward lexical invention on that slot.
FILLER_WORDS = {"yeah", "yea", "yuh", "huh", "uh", "uhh", "um", "oh", "ooh", "ah", "aw",
                "woah", "whoa", "hey", "yo", "ay", "aye", "ayy", "la", "na", "mm", "hmm",
                "woo", "brr"}


# ── grouping ──────────────────────────────────────────────────────────────────────────

def _merge_into(dst: dict, src: dict) -> None:
    """Fold src's slots/bars/span into dst, keeping slots in absolute-time order."""
    dst["slots"] = sorted(dst["slots"] + src["slots"], key=lambda s: float(s.get("start", 0.0)))
    for b in src["bars"]:
        if b not in dst["bars"]:
            dst["bars"].append(b)
    dst["bars"].sort()
    dst["start"] = min(dst["start"], src["start"])
    dst["end"] = max(dst["end"], src["end"])


def group_by_rest(line_scores: List[dict], gap_s: float = 0.35, min_syllables: int = 1) -> List[dict]:
    """Flatten the skeleton's per-bar slots onto one time-ordered line and split into
    phrase groups wherever the silence between consecutive slots (prev.end → next.start)
    is at least ``gap_s`` — the take's real breaths/rests, the unit a listener hears as a
    line. Slots ride through verbatim (absolute times, segments/pitch intact).

    ``min_syllables`` (>1) then absorbs any phrase shorter than that into its NEAREST
    neighbor (by inter-phrase gap) — a 1-note mumble fragment can't be a standalone
    rhyming line (the brain crams a whole line onto one note), so it belongs with the
    phrase it's closest to. Default 1 = no merge.

    Returns ``[{"slots": [...], "bars": [barIndex, ...], "start": float, "end": float}]``.
    None entries and slot-less bars are skipped.
    """
    flat: List[tuple] = []  # (bar, slot)
    for ls in line_scores or []:
        if not isinstance(ls, dict):
            continue
        bar = ls.get("bar")
        for s in ls.get("slots") or []:
            flat.append((bar, s))
    flat.sort(key=lambda bs: float(bs[1].get("start", 0.0)))

    phrases: List[dict] = []
    cur: Optional[dict] = None
    prev_end: Optional[float] = None
    prev_pid = None
    for bar, s in flat:
        st = float(s.get("start", 0.0))
        en = float(s.get("end", st))
        # An explicit `phrase` id (the annotator window the owner confirmed) is a hard
        # boundary: legato tails can bridge perceptual phrases at voice-level energy, so
        # a silence gate alone can't recover them — the owner's membership can.
        pid = s.get("phrase")
        id_break = pid is not None and prev_pid is not None and pid != prev_pid
        if cur is None or id_break or (prev_end is not None and st - prev_end >= gap_s):
            cur = {"slots": [], "bars": [], "start": st, "end": en}
            phrases.append(cur)
        cur["slots"].append(s)
        if bar is not None and bar not in cur["bars"]:
            cur["bars"].append(bar)
        cur["end"] = max(cur["end"], en)
        prev_end = en
        prev_pid = pid

    # Absorb un-writable short phrases into the temporally nearest neighbor (repeat until
    # none remain or only one phrase is left). Deterministic: leftmost short phrase first.
    # A fragment carrying an owner phrase id prefers a SAME-id neighbor — it must never
    # leak across an owner boundary just because the foreign side is temporally closer.
    while min_syllables > 1 and len(phrases) > 1:
        i = next((k for k, p in enumerate(phrases) if len(p["slots"]) < min_syllables), None)
        if i is None:
            break
        gap_prev = (phrases[i]["start"] - phrases[i - 1]["end"]) if i > 0 else float("inf")
        gap_next = (phrases[i + 1]["start"] - phrases[i]["end"]) if i < len(phrases) - 1 else float("inf")
        sid = phrases[i]["slots"][0].get("phrase")
        if sid is not None:
            if i > 0 and phrases[i - 1]["slots"][-1].get("phrase") != sid:
                gap_prev = float("inf")
            if i < len(phrases) - 1 and phrases[i + 1]["slots"][0].get("phrase") != sid:
                gap_next = float("inf")
            if gap_prev == float("inf") and gap_next == float("inf"):
                # no same-id neighbor: fall back to the plain nearest (never strand)
                gap_prev = (phrases[i]["start"] - phrases[i - 1]["end"]) if i > 0 else float("inf")
                gap_next = (phrases[i + 1]["start"] - phrases[i]["end"]) if i < len(phrases) - 1 else float("inf")
        _merge_into(phrases[i - 1] if gap_prev <= gap_next else phrases[i + 1], phrases[i])
        phrases.pop(i)
    return phrases


# ── per-phrase derivations ────────────────────────────────────────────────────────────

def _slot_pitch(slot: dict) -> float:
    """Representative pitch of a slot = median of its (voiced) segment pitches."""
    ps = sorted(float(seg.get("pitch", 0)) for seg in (slot.get("segments") or [])
                if float(seg.get("pitch", 0)) > 0)
    if not ps:
        return 0.0
    n = len(ps)
    return ps[n // 2] if n % 2 else (ps[n // 2 - 1] + ps[n // 2]) / 2.0


def _stress_from_velocity(slots: List[dict]) -> str:
    """'X' where a slot is at/above the phrase's mean velocity (a stressed/accented
    syllable), 'x' below — the rhythmic emphasis the brain should honor."""
    vels = [float(s.get("velocity", 0.0)) for s in slots]
    if not vels:
        return ""
    mean = sum(vels) / len(vels)
    return "".join("X" if v >= mean else "x" for v in vels)


def _pitch_contour(slots: List[dict]) -> str:
    """A compact, human description of the phrase's sung shape so the brain can land the
    rhyme/payoff word on the high or held note. Deterministic."""
    reps = [_slot_pitch(s) for s in slots]
    if not reps:
        return ""
    durs = [float(s.get("end", 0.0)) - float(s.get("start", 0.0)) for s in slots]
    peak = max(range(len(reps)), key=lambda i: reps[i])            # first-max syllable
    held = max(range(len(durs)), key=lambda i: durs[i])            # longest note
    if reps[-1] - reps[0] > 0.5:
        direction = "rises"
    elif reps[0] - reps[-1] > 0.5:
        direction = "falls"
    else:
        direction = "level"
    span = int(round(max(reps) - min(p for p in reps if p > 0))) if any(p > 0 for p in reps) else 0
    return (f"{direction} contour; highest pitch on syllable {peak + 1}; "
            f"held note on syllable {held + 1}; {span} semitone range")


def _theme_hint(bars: List[int], line_heard: List[Optional[dict]]) -> str:
    """The mumble's OWN words for this phrase (Whisper-kept, time-ordered) — a vibe seed
    for the brain, NEVER required words. Empty when the take had no confident words."""
    barset = set(bars)
    words: List[str] = []
    for lh in line_heard or []:
        if not isinstance(lh, dict) or lh.get("bar") not in barset:
            continue
        for w in lh.get("words") or []:
            if w.get("kept") and w.get("word"):
                tok = str(w["word"]).strip().lower()
                if tok and tok not in words:
                    words.append(tok)
    return " ".join(words)


def _rhyme_group(index: int, scheme: str = "AABB") -> str:
    """End-rhyme scheme across phrases. AABB (couplets) is the rap default — adjacent
    lines rhyme; the mumble doesn't dictate rhyme, so we impose a singable one."""
    if scheme == "ABAB":
        return chr(ord("A") + index % 2)
    return chr(ord("A") + (index // 2) % 26)   # AABB couplets


def _clean_tok(word: str) -> str:
    return re.sub(r"[^a-z']", "", str(word or "").lower())


def _word_by_slot_id(skeleton: dict) -> dict:
    """Map each lineScores slot (by object id) to {"tok", "conf"} — the KEPT mumble word at
    that position (from the skeleton's per-line `seedText`: extract.py's confident words →
    mumble.py anchors, `___` for filler) plus its ASR confidence from `lineHeard` (slot
    match first, then word match; None when no heard data exists — back-compat)."""
    line_by_index = {l.get("index"): l for l in (skeleton.get("lines") or [])}
    heard_by_bar: dict = {}
    for lh in skeleton.get("lineHeard") or []:
        if isinstance(lh, dict):
            heard_by_bar[lh.get("bar")] = [w for w in lh.get("words") or [] if w.get("kept")]
    out: dict = {}
    for ls in skeleton.get("lineScores") or []:
        if not isinstance(ls, dict):
            continue
        bar = ls.get("bar")
        tokens = str((line_by_index.get(bar) or {}).get("seedText", "") or "").split()
        heard = list(heard_by_bar.get(bar) or [])
        for i, s in enumerate(ls.get("slots") or []):
            tok = tokens[i] if i < len(tokens) else "___"
            conf = None
            if tok != "___" and heard:
                match = next((j for j, w in enumerate(heard)
                              if w.get("slot") == i and _clean_tok(w.get("word")) == _clean_tok(tok)),
                             None)
                if match is None:
                    match = next((j for j, w in enumerate(heard)
                                  if _clean_tok(w.get("word")) == _clean_tok(tok)), None)
                if match is not None:
                    conf = float(heard.pop(match).get("conf", 0) or 0)
            out[id(s)] = {"tok": tok, "conf": conf}
    return out


def _tier_phrase(infos: List[dict]) -> List[str]:
    """Split a phrase's per-slot (tok, conf) into verbatim seed tokens (kept trusted words +
    `___` gaps for the rest). Runs of adjacent kept words tier TOGETHER (a mid-conf word rides
    its trusted phrase); a run without heard confidence stays verbatim (back-compat). Untrusted
    words are demoted to gaps (the writer invents there) — the take's SOUNDS no longer steer
    the words (flow-over-sounds: rhythm from the take, coherent words from the writer)."""
    runs, cur = [], []
    for i, inf in enumerate(infos):
        if inf["tok"] != "___":
            cur.append(i)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    def _filler(i: int) -> bool:
        return _clean_tok(infos[i]["tok"]) in FILLER_WORDS

    demote: set = set()
    for run in runs:
        confs = [infos[i]["conf"] for i in run]
        if any(c is None for c in confs):
            continue
        if len(run) >= 2 and sum(confs) / len(confs) >= TRUST_RUN_MEAN and max(confs) >= TRUST_RUN_MAX:
            # a trusted run still sheds its low-conf members (junk must not ride the phrase)
            demote.update(i for i in run if infos[i]["conf"] < TRUST_MEMBER and not _filler(i))
            continue
        if len(run) == 1 and confs[0] >= TRUST_LONE:
            continue
        demote.update(i for i in run if not _filler(i))

    # FEASIBILITY (tol=0): kept words' syllables + remaining gaps must fit the slot count —
    # a multi-syllable kept word on one slot otherwise makes every candidate fail the exact
    # count. Demote the lowest-conf kept words until the seed is writable.
    def _syl(w: str) -> int:
        return max(1, _pron().syllables(_clean_tok(w)) or 1)

    def _load() -> int:
        kept = [i for i in range(len(infos)) if infos[i]["tok"] != "___" and i not in demote]
        return sum(_syl(infos[i]["tok"]) for i in kept) + (len(infos) - len(kept))

    # (back-compat: without heard confidences there's nothing sane to rank demotions by —
    # skip, exactly like the tiering above.)
    has_conf = any(inf["conf"] is not None for inf in infos if inf["tok"] != "___")
    while has_conf and _load() > len(infos):
        kept = [i for i in range(len(infos)) if infos[i]["tok"] != "___" and i not in demote]
        if not kept:
            break
        # Demoting a 1-syllable word never reduces the load (its slot becomes a 1-syllable
        # gap) — only multi-syllable words are real offenders; fillers ride out feasibility.
        offenders = [i for i in kept if _syl(infos[i]["tok"]) > 1] or kept
        demote.add(min(offenders, key=lambda i: (infos[i]["conf"] if infos[i]["conf"] is not None else 1.0, i)))

    # A TRAILING kept stop word must never survive as the line's locked END (it forces a
    # dangling "...i'm the" ending the end-gate then exempts) — demote it to an echo.
    while True:
        last = next((i for i in range(len(infos) - 1, -1, -1)
                     if infos[i]["tok"] != "___" and i not in demote), None)
        if last is None or _clean_tok(infos[last]["tok"]) not in TRAIL_STOP_WORDS:
            break
        demote.add(last)

    return [("___" if i in demote else infos[i]["tok"]) for i in range(len(infos))]


def build_flow_spec(skeleton: dict, *, gap_s: float = 0.35, min_syllables: int = 1,
                    preserve_words: bool = False, chorus: str = "", theme: str = "",
                    mood: str = "", grid: str = "1/16", rhymeStrictness: str = "slant",
                    rhyme_scheme: str = "AABB") -> dict:
    """Turn a mumble skeleton into a rhythm/pitch-grounded LineSpec. Each line carries the
    exact syllable count, velocity-stress, pitch contour, and a theme hint derived from the
    real take, plus its true slots as an author_score-ready `score` blob. Shaped like the
    lyric engine's spec so lyrics.core.complete_verse can consume it directly.

    ``preserve_words``: carry the take's KEPT words into each phrase's `seedText` (words at
    their real slots, `___` for filler gaps) so the generator keeps your actual bars and
    invents only the gaps. Default False = blank seed (invent every line freely)."""
    line_scores = skeleton.get("lineScores") or []
    line_heard = skeleton.get("lineHeard") or []
    slot_word = _word_by_slot_id(skeleton) if preserve_words else {}
    bpm = 138.0
    for ls in line_scores:
        if isinstance(ls, dict) and ls.get("bpm"):
            bpm = float(ls["bpm"])
            break

    phrases = group_by_rest(line_scores, gap_s=gap_s, min_syllables=min_syllables)
    lines: List[dict] = []
    for i, ph in enumerate(phrases):
        slots = ph["slots"]
        if preserve_words:
            infos = [slot_word.get(id(s), {"tok": "___", "conf": None}) for s in slots]
            seed = " ".join(_tier_phrase(infos))
        else:
            seed = ""
        # Break map: an intra-phrase gap >= 70ms is a real micro-breath — a word must END
        # at that syllable (enforced by lyrics.core._evaluate, not just prompted).
        breaks = [j for j in range(len(slots) - 1)
                  if float(slots[j + 1].get("start", 0.0)) - float(slots[j].get("end", 0.0)) >= 0.07]
        lines.append({
            "index": i,
            "role": "verse",
            "seedText": seed,                        # TRUSTED kept words + gaps, or blank (invent)
            "breaks": breaks,                        # required word boundaries (real breaths)
            "syllableTarget": len(slots),
            # EXACT count — the hand-fit discipline the owner certified by ear (demo d5,
            # 2026-07-11): one syllable per measured note; ±1 slack re-introduces squeeze/hold.
            "syllableTol": 0,
            "stress": _stress_from_velocity(slots),
            "pitchContour": _pitch_contour(slots),
            "themeHint": _theme_hint(ph["bars"], line_heard),
            # Rhyme-free: a mumble-derived grid didn't necessarily rhyme AABB, so let the
            # writer rhyme where natural (the craft prompt encourages it) rather than force
            # a scheme onto the take (matches the certified T1/T2 recipe). Re-enable an
            # imposed scheme here — `_rhyme_group(i, rhyme_scheme)` — if tighter rhyming wins.
            "rhymeGroup": "",
            "score": {"v": 1, "algo": "flow", "bar": (ph["bars"][0] if ph["bars"] else 0),
                      "bpm": bpm, "timeSig": [4, 4], "grid": grid, "clamped": False,
                      "slots": slots},
            "startS": round(float(ph["start"]), 3),
            "endS": round(float(ph["end"]), 3),
        })
    return {"ok": True, "grid": grid, "topic": theme, "mood": mood,
            "rhymeStrictness": rhymeStrictness, "lines": lines,
            "source": "flowspec", "chorus": chorus, "theme": theme}
