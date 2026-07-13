#!/usr/bin/env python3
"""Lyric generation loop (Finish-My-Song §6, L2) — propose → validate → retry → rank.

This is where "LLM + phonology" beats "LLM alone": a backend PROPOSES candidate lines
under the constraint spec (syllable target, rhyme group, locked words), the phonology
core VALIDATES each (syllables within tol, the rhyme group's end-words actually rhyme),
and the loop RANKS the survivors and returns top-N reviewable proposals.

L2 ships the FAKE backend: a deterministic, constraint-aware template filler that hits
the syllable target exactly and rhymes the group via the phonology dictionary — so the
whole loop, the UI, and the automatable quality FLOOR (the validator pass-rate) run with
zero LLM/venv. L3 swaps in a real LLM behind the same `propose` seam (service/brain_client),
degrading real→fake exactly like stable_audio3→fake. Stdlib + the phonology core only.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Dict, List, Optional

import brain_client
from phonology import core as phon
from lyrics import soundmatch
from lyrics import style_corpus

_P = phon.Pronouncer()  # real cmudict if importable, else a stdlib heuristic

# Mouth enforcement (mouth round, 2026-07-12) — calibrated on the Used2 back half under
# the min-normalized, base-sharpened metric: sound-alike lines score >= 0.68, mouth-blind
# lines <= 0.36. The floor sits between those bands.
MOUTH_FLOOR = 0.50        # hard gate: below this the line ignores the take's sounds
MOUTH_MIN_TARGETS = 4     # gate only with a real phrase of evidence; less still SCORES
MOUTH_MIN_DISTINCT = 3    # ... of which this many must be non-schwa: AH is the neutral
                          # mouth and any English line echoes it, so generic evidence
                          # scores but must never REJECT
MOUTH_WEIGHT = 0.20       # ranking TIEBREAK (flow-over-sounds v2, 2026-07-12) — a faint
                          # preference for sound-matched lines, never a gate. Cut from 0.35
                          # with echo_term (0.75->0.20) so the combined sound swing (<=0.40)
                          # sits below stress/rhythm (0.75) and the pass bonus (2): the
                          # mumble sets FLOW, coherence wins, the take only breaks ties.

# A flow-grounded line must not END on a dangling function word ("...I was a") — the
# exact-count corset otherwise trims lines mid-thought. Deliberate short list: pure
# determiners/prepositions/conjunctions only ("was"/"be" can legitimately end a bar).
END_STOP_WORDS = {"a", "an", "the", "of", "to", "in", "on", "at", "by", "for", "with",
                  "and", "or", "but", "nor", "so", "yet",
                  "my", "your", "our", "their", "his", "her", "its"}

# Deterministic filler vocab, indexed by syllable count, so any target is hit exactly.
_FILLER_1 = ["up", "down", "now", "back", "through", "on", "out", "high",
             "low", "cold", "hard", "fast", "gold", "real", "strong", "loud"]
_FILLER_2 = ["again", "tonight", "alone", "inside", "over", "under", "money",
             "power", "never", "rising", "burning", "focused"]
# Interjection filler (owner, 2026-07-12: "filler words are incredibly helpful
# (essential)") — the opt-in spec fillerStyle="interjection" swaps the lexical filler
# vocab for rap placeholders, so a fallback line is a natural scratch vocal ("yeah uh
# ay woah…") instead of an awkward forced-lexical rhythm. All 1-syllable by design.
_FILLER_INTERJ = ["yeah", "uh", "ay", "woah", "oh", "hey", "yo", "huh"]
_INTERJ_ENDS = ["yeah", "woah", "ay", "yo"]
_INTERJ_SET = frozenset(_FILLER_INTERJ)
FILLER_PENALTY = 2.5      # a bar of interjections ("oh oh oh yeah") is demoted below any
                          # real-word line (owner: fillers are seasoning, not a meal)


def _filler_frac(text: str) -> float:
    """Fraction of a line's words that are placeholder INTERJECTIONS (yeah/oh/uh…). Only
    interjections count — the lexical filler pool contains real words ('out', 'now')."""
    ws = re.findall(r"[A-Za-z']+", _norm_apostrophes(str(text)).lower())
    return sum(1 for w in ws if w in _INTERJ_SET) / len(ws) if ws else 0.0

# End-word pools (1-syllable, for easy assembly) when a line has no rhyme anchor.
_DEFAULT_ENDS = ["flow", "grind", "game", "time", "night", "light", "fight",
                 "line", "mind", "crown", "throne", "gold", "cold", "real", "deal"]
_TOPIC_ENDS = {
    "night": ["night", "light", "fight", "sight", "right", "bright"],
    "comeback": ["flame", "name", "game", "claim", "frame", "blame", "aim"],
    "love": ["heart", "start", "apart", "art", "part"],
}


def _norm_apostrophes(text: str) -> str:
    """LLMs write typographic apostrophes (U+2019/U+2018); the tokenizers only know
    ASCII ' — un-normalized, "I’m" splits into two 1-syllable tokens while the SoulX
    score author sings it as ONE word, smearing every following word one slot early
    (adversarial review, 2026-07-12)."""
    return text.replace("’", "'").replace("‘", "'")


def syllables(text: str) -> int:
    """Syllable count over a line (per-word, dictionary then heuristic). Every sung
    word is at least 1 syllable — the score author consumes max(1,·) slots, and the
    two graders must agree ("mm"/"hmm" would otherwise count 0 but sing 1)."""
    if not isinstance(text, str):
        return 0
    return sum(max(1, _P.syllables(w) or 1)
               for w in re.findall(r"[A-Za-z']+", _norm_apostrophes(text)))


def rhymes(a: str, b: str, strictness: str = "slant") -> bool:
    return _P.rhyme(a, b, strictness)


# ── deterministic seeded picks (no RNG → reproducible) ───────────────────────────

def _pick(seq: List[str], seed: str) -> Optional[str]:
    if not seq:
        return None
    idx = int(hashlib.sha1(seed.encode("utf-8")).hexdigest(), 16) % len(seq)
    return seq[idx]


def _filler_for(need: int, seed: str, ones_only: bool = False,
                style: Optional[str] = None) -> List[str]:
    """Filler words summing to EXACTLY `need` syllables (2s then a 1 — any need≥1).
    ``ones_only`` uses monosyllables exclusively — a 1-syllable word can never span a
    breath, keeping the fake backend a valid floor for flow-grounded (breaks) lines.
    ``style="interjection"`` draws rap placeholders (all 1-syllable) instead."""
    out: List[str] = []
    i = 0
    rem = need
    if style == "interjection" and rem >= 1:
        # DENSITY CAP (owner, 2026-07-12: "yeah can be a placeholder but it can't be every
        # word in the bar"): at most ONE interjection per fill; the rest is lexical filler,
        # so a fallback line is never "oh oh oh yeah…".
        out.append(_pick(_FILLER_INTERJ, f"{seed}|fi") or "yeah")
        rem -= 1
    while rem >= 2 and not ones_only:
        out.append(_pick(_FILLER_2, f"{seed}|f2|{i}") or "again")
        rem -= 2
        i += 1
    while rem >= 1:
        out.append(_pick(_FILLER_1, f"{seed}|f1|{i}") or "now")
        rem -= 1
        i += 1
    return out


# ── constraint spec helpers ──────────────────────────────────────────────────────

def _grid_per_bar(grid: str) -> int:
    return {"1/4": 4, "1/8": 8, "1/16": 16}.get(grid, 16)


def _target(line: dict, spec: dict) -> int:
    t = int(line.get("syllableTarget") or 0)
    return t if t > 0 else _grid_per_bar(spec.get("grid", "1/16"))


def _strictness(line: dict, spec: dict) -> str:
    return line.get("rhymeStrictness") or spec.get("rhymeStrictness") or "slant"


def _topic_ends(spec: dict) -> List[str]:
    return _TOPIC_ENDS.get(str(spec.get("topic", "")).lower(), _DEFAULT_ENDS)


def _has_gap(seed: str) -> bool:
    return bool(re.search(r"_{2,}", seed or ""))


def _tokens(seed: str):
    if not (seed or "").strip():
        return []
    return [{"w": t, "gap": bool(re.fullmatch(r"_{2,}", t))} for t in seed.split()]


def _syl_tol(line: dict) -> int:
    """The line's syllable tolerance. An EXPLICIT 0 means 0 — the old `x or 1` idiom
    turned tol 0 into tol 1 and silently voided the syllable-EXACT discipline (strict
    round, 2026-07-12: 8/17 and 13/17 shipped lines were off-count)."""
    v = line.get("syllableTol")
    return 1 if v is None else int(v)


def _fixed_end_word(line: dict) -> Optional[str]:
    """The producer's locked end word: the final text's last word, or the seed's last
    token when it's a word (not a gap). This anchors the rhyme group."""
    txt = (line.get("text") or "").strip()
    if txt:
        ws = re.findall(r"[A-Za-z']+", txt)
        return ws[-1] if ws else None
    toks = _tokens(line.get("seedText", ""))
    if toks and not toks[-1]["gap"]:
        return toks[-1]["w"]
    return None


def _fillable(line: dict) -> bool:
    txt = (line.get("text") or "").strip()
    if txt and not _has_gap(line.get("seedText", "")):
        return False   # finalized line with no gaps — it's done (still an anchor)
    return True


# ── assembly: build a line of `target` syllables, keeping the producer's words ────

def _assemble(seed_text: str, end_word: str, target: int, tol: int, seed: str,
              ones_only: bool = False, style: Optional[str] = None) -> str:
    toks = _tokens(seed_text)
    own_end = (not toks) or toks[-1]["gap"]    # we APPEND the end word (trailing gap / fresh)
    if toks and toks[-1]["gap"]:
        toks = toks[:-1]
    words = [t["w"] for t in toks if not t["gap"]]

    # Insert filler at the first interior gap, else just before the end word.
    insert_at = None
    seen_words = 0
    for t in toks:
        if t["gap"]:
            insert_at = seen_words
            break
        seen_words += 1
    if insert_at is None:
        insert_at = len(words) if own_end else max(0, len(words) - 1)

    end_syl = _P.syllables(end_word) if own_end else 0
    base_syl = sum(_P.syllables(w) for w in words) + end_syl
    need = target - base_syl
    filler = _filler_for(need, seed, ones_only, style) if need > 0 else []

    out = words[:insert_at] + filler + words[insert_at:]
    if own_end:
        out = out + [end_word]
    return " ".join(w for w in out if w)


# ── the loop: propose N → validate(phonology) → retry/repair → rank → top-N ──────

def _word_syl_map(text: str) -> List[tuple]:
    """[(word, start_syllable_index, syllable_count), ...] — the candidate's words mapped
    onto 0-based syllable positions, for break/stress/echo checks."""
    out, pos = [], 0
    for w in re.findall(r"[A-Za-z']+", _norm_apostrophes(text)):
        n = max(1, _P.syllables(w) or 1)
        out.append((w, pos, n))
        pos += n
    return out


def _evaluate(text: str, line: dict, spec: dict, anchor: Optional[str],
              target: int, tol: int, strict: str) -> dict:
    """Validate one candidate line against the constraints — the shared gate both the
    fake and the LLM backend feed into. The end word is read from the text.

    Flow-grounded lines (writer v2 — lines carrying `breaks`/`echoTargets` from
    lyrics.flowspec) get flow ENFORCED, not suggested: a word spanning a real breath
    HARD-FAILS (with a specific re-prompt reason), stress alignment against the take's
    accents and vowel-echo of demoted mumble words RANK otherwise-valid candidates.
    Lines without those fields keep the original semantics untouched."""
    fixed = _fixed_end_word(line)
    words = re.findall(r"[A-Za-z']+", text)
    end = words[-1] if words else ""
    nsyl = syllables(text)
    syl_ok = abs(nsyl - target) <= tol
    must_rhyme = anchor is not None and fixed is None
    rhyme_ok = (not must_rhyme) or (anchor is not None and rhymes(end, anchor, strict))
    # Locked words: the producer's non-gap seed words must survive in the candidate.
    seed_words = [t["w"] for t in _tokens(line.get("seedText", "")) if not t["gap"]]
    locked_ok = all(w.lower() in text.lower() for w in seed_words)

    flow_grounded = ("breaks" in line) or bool(line.get("echoTargets")) \
        or bool(line.get("mouthTargets"))
    wmap = _word_syl_map(text) if flow_grounded else []

    # HARD gate: no word may run through a real breath (the take's intra-phrase rest).
    breaks_ok, breaks_reason = True, ""
    for p in (int(b) for b in (line.get("breaks") or [])):
        bad = next((w for w, start, n in wmap if start <= p and p + 1 <= start + n - 1), None)
        if bad is not None:
            breaks_ok = False
            breaks_reason = (f"\"{bad}\" runs through the breath after syllable {p + 1} — "
                             f"end a word exactly there.")
            break

    # HARD gate: the line must ECHO the take's heard sounds (the mouth movie). Gated only
    # when a real phrase of evidence exists; short evidence still scores below.
    mtargets = line.get("mouthTargets") or []
    mouth_sim, mouth_ok = 0.0, True
    if mtargets:
        mouth_sim = soundmatch.mouth_similarity(text, mtargets)
        # arm the gate only with a real phrase of evidence that also COVERS the line
        # (4 heard syllables against a 12-slot line is too sparse to reject on) and
        # carries DISTINCTIVE mouth shapes (an all-schwa movie matches anything)
        distinct = sum(1 for t in mtargets if t.get("vowel") not in (None, "AH"))
        if (len(mtargets) >= MOUTH_MIN_TARGETS and 2 * len(mtargets) >= target
                and distinct >= MOUTH_MIN_DISTINCT):
            mouth_ok = mouth_sim >= MOUTH_FLOOR

    # HARD gate (flow-grounded): the line must actually END on its locked end word
    # (containment alone exempted the dangling-ending gate — review-confirmed), and a
    # free ending must not dangle on a function word.
    end_ok = True
    if flow_grounded:
        if fixed is not None:
            end_ok = end.lower().strip("'") == fixed.lower().strip("'")
        else:
            end_ok = end.lower() not in END_STOP_WORDS

    # LOOSENED (owner, 2026-07-12): mouth is a SOFT nudge now, NOT a gate — with the NSF
    # re-vocode making the voice natural, the mumble sets FLOW and the words are free to be
    # coherent bars. `mouth_ok` stays computed for the flow-viz but is out of `passes`; the
    # syllable-by-syllable vowel echo was forcing all-filler bars.
    passes = syl_ok and rhyme_ok and locked_ok and breaks_ok and end_ok
    grade = ("anchor" if fixed else
             (phon.rhyme_grade(_P.phones(end) or [], _P.phones(anchor) or []) if anchor else "free"))
    # Bar IQ C — reward MULTISYLLABIC rhymes: how many trailing syllables of the end word
    # rhyme with the anchor (depth 1 = a plain end-rhyme; 2+ = a skilled multi). The bonus
    # makes the ranker PREFER deeper rhymes among otherwise-valid candidates.
    depth = (phon.multisyllabic_depth(_P.phones(end) or [], _P.phones(anchor) or [])
             if (anchor and end) else 0)

    # SOFT terms (flow-grounded only): accent alignment + vowel echo of demoted words.
    stress_term = 0.0
    line_stress = str(line.get("stress") or "")
    if "breaks" in line and line_stress and wmap:
        cand = "".join(((_P.stress(w) or "x" * n)[:n]).ljust(n, "x") for w, _, n in wmap)
        xpos = [i for i, ch in enumerate(line_stress) if ch == "X" and i < len(cand)]
        if xpos:
            stress_term = 0.75 * sum(1 for i in xpos if cand[i] == "X") / len(xpos)
    echo_term = 0.0
    targets = line.get("echoTargets") or []
    if targets and wmap:
        sims = []
        for e in targets:
            p = int(e.get("pos", -1))
            word = next((w for w, start, n in wmap if start <= p < start + n), "")
            sims.append(soundmatch.similarity(word, str(e.get("word", ""))) if word else 0.0)
        echo_term = 0.20 * sum(sims) / len(sims)  # tiebreak only (flow-over-sounds v2)

    # A filler-heavy line ("oh oh oh yeah") is demoted below any real-word candidate; ~15%
    # interjection is tolerated (a placeholder here and there), beyond that it's penalized.
    filler_pen = FILLER_PENALTY * max(0.0, _filler_frac(text) - 0.15)
    score = (2 if passes else 0) + (1 if rhyme_ok else 0) + (1 if locked_ok else 0) \
        + (1.0 - min(1.0, abs(nsyl - target) / max(1, target))) \
        + 0.5 * max(0, depth - 1) + stress_term + echo_term + MOUTH_WEIGHT * mouth_sim \
        - filler_pen
    out = {"text": text, "endWord": end, "syllables": nsyl, "syllableOk": syl_ok,
           "rhymeOk": rhyme_ok, "lockedOk": locked_ok, "passes": passes,
           "grade": grade, "depth": depth, "score": round(score, 3)}
    if flow_grounded:
        out["breaksOk"] = breaks_ok
        if not breaks_ok:
            out["breaksReason"] = breaks_reason
        out["stressTerm"] = round(stress_term, 3)
        out["echoTerm"] = round(echo_term, 3)
        out["endOk"] = end_ok
        if not end_ok:
            out["endReason"] = (
                f"the line must END on the word \"{fixed}\" (it ended on \"{end}\")."
                if fixed is not None else
                f"the line ends on \"{end}\" — never end on a dangling "
                "article/preposition/conjunction; finish the thought on a content word.")
    if mtargets:
        out["mouthSim"] = round(mouth_sim, 3)
        out["mouthOk"] = mouth_ok
        if not mouth_ok:
            out["mouthReason"] = (
                f"the line drifted far from the take's mumble \"{line.get('mouthText', '')}\" "
                f"— you may lean a little toward those SOUNDs, but keep the bar coherent "
                f"first (sound match {int(round(mouth_sim * 100))}%).")
    return out


def _rank(cands: List[dict], n: int = 3) -> List[dict]:
    seen, uniq = set(), []
    for c in sorted(cands, key=lambda c: (-c["score"], c["text"])):
        if c["text"] in seen:
            continue
        seen.add(c["text"])
        uniq.append(c)
    return uniq[:n]


def _fake_propose_line(line: dict, spec: dict, anchor: Optional[str], regen: int) -> List[dict]:
    """The deterministic, constraint-aware template backend (always available)."""
    target, tol, strict = _target(line, spec), _syl_tol(line), _strictness(line, spec)
    fixed = _fixed_end_word(line)
    style = spec.get("fillerStyle")
    cands: List[dict] = []
    for v in range(3):
        seed = f"{line.get('index')}|{v}|{regen}|{spec.get('topic','')}|{spec.get('mood','')}"
        if fixed:
            end = fixed
        elif anchor:
            ends = _P.rhyme_search(anchor, strict, max_n=40, syllables=1)
            end = _pick(ends, seed) if ends else _pick(_topic_ends(spec), seed)
        else:
            # end on a REAL word even under interjection style — the one allowed filler
            # is the single interior placeholder, never the line's ending (density cap).
            end = _pick(_topic_ends(spec), seed)
        cands.append(_evaluate(_assemble(line.get("seedText", ""), end, target, tol, seed,
                                         ones_only=bool(line.get("breaks")), style=style),
                               line, spec, anchor, target, tol, strict))
    return _rank(cands)


# ── style-RAG (§7): retrieve the artist's own voice + guard against parroting it ──

def _style_query(spec: dict) -> str:
    """The 'voice' query: topic + mood + whatever's already written in the sheet."""
    parts = [str(spec.get("topic", "")), str(spec.get("mood", ""))]
    for l in spec.get("lines", []):
        parts.append(str(l.get("text", "")))
        parts.append(re.sub(r"_{2,}", " ", str(l.get("seedText", ""))))  # gaps → spaces
    return " ".join(p for p in parts if p)


def _style_corpus(spec: dict) -> List[dict]:
    """The retrieval pool when style biasing is opted in (else empty → loop unchanged).
    The persisted user corpus PLUS any inline lines the request carried (the track's own
    accepted lyrics). Gated on spec['styleBias'] so the default path is byte-identical."""
    if not spec.get("styleBias"):
        return []
    return style_corpus.load_corpus(spec.get("styleCorpus"))


def _style_exemplars(spec: dict, k: int = 3) -> List[str]:
    corpus = _style_corpus(spec)
    return style_corpus.retrieve(corpus, _style_query(spec), k=k) if corpus else []


# ── the LLM backend (L3): prompt → validate → re-prompt with the SPECIFIC failure ──

def _build_messages(line: dict, spec: dict, anchor: Optional[str], target: int,
                    tol: int, strict: str, feedback: Optional[str],
                    context: Optional[dict] = None) -> List[dict]:
    fixed = _fixed_end_word(line)
    seed_words = [t["w"] for t in _tokens(line.get("seedText", "")) if not t["gap"]]
    rules = [f"Write {3} candidate {line.get('role', 'verse')} lines.",
             f"Each line MUST be ~{target} syllables (±{tol}).",
             "Keep these words, in order: " + (", ".join(seed_words) if seed_words else "(none)") + ".",
             f"Fill the gaps (___) in: \"{line.get('seedText', '') or '(write from scratch)'}\"."]
    if fixed:
        rules.append(f"The line must END on the word \"{fixed}\".")
    elif anchor:
        rules.append(f"The line must END on a word that is a {strict} rhyme with \"{anchor}\".")
    if spec.get("topic"):
        rules.append(f"Topic: {spec['topic']}.")
    if spec.get("mood"):
        rules.append(f"Mood: {spec['mood']}.")
    # Stage B0 — COHERENCE. A mumbled back half is a wordless outline; to make it a real
    # verse (not disconnected bars) each line is generated knowing the chorus it resolves
    # into, the song's theme, and the verse SO FAR — so the story develops and lands the hook.
    if context:
        ch = context.get("chorus")
        if ch:
            rules.append(f"This is a VERSE that must resolve into the song's CHORUS: \"{ch}\". "
                         "Build toward it — the closing lines should set the hook up.")
        th = context.get("theme")
        if th:
            rules.append(f"The song's story / theme to develop coherently: {th}.")
        prior = context.get("priorLines") or []
        if prior:
            rules.append("The verse SO FAR (continue this SAME thought/story with a fresh line — "
                         "do not repeat or contradict it): " + " / ".join(f"\"{p}\"" for p in prior[-6:]) + ".")
        pos, total = context.get("position"), context.get("total")
        if pos and total:
            rules.append(f"This is line {pos} of {total} in the verse.")
    # Stage 1 (FlowSpec) — line-level FLOW grounding. When the line came from a mumbled take
    # (lyrics.flowspec), it carries the take's REAL rhythm and melody. Write TO them so the
    # words actually fit the mumble — the whole point of the harness (logic + rhythm + rhyme).
    contour = line.get("pitchContour")
    if contour:
        rules.append(f"Melody of this line: {contour}. Land the most important / rhyming word "
                     "on the highest or the held note.")
    line_stress = line.get("stress")
    if line_stress:
        rules.append(f"Rhythm — stress pattern (X=accented beat, x=unstressed): {line_stress}. "
                     "Put strong syllables on the X positions so it rides the beat.")
    hint = line.get("themeHint")
    if hint:
        rules.append(f"The take mumbled roughly \"{hint}\" here — use it ONLY as a feeling/theme "
                     "cue; do not require or quote these words.")
    # Writer v2 — ENFORCED flow. Breath points are validated (a violating candidate is
    # rejected and re-prompted); echo targets carry the mumble's SOUND where Whisper's
    # text is untrustworthy — never quote a low-trust word, echo its vowels instead.
    brks = line.get("breaks") or []
    if brks:
        pts = ", ".join(str(int(p) + 1) for p in brks)
        rules.append(f"BREATH points: a word must END exactly at syllable {pts} — never carry "
                     "one word across a breath.")
    for e in line.get("echoTargets") or []:
        v = "-".join(e.get("vowels") or []) or "?"
        w = str(e.get("word", ""))
        if float(e.get("conf") or 0) < 0.5:
            # low-trust: KEEP the junk-word prohibition (a coherence WIN — blocks Whisper's
            # misheard nonsense from being forced in), but DROP the per-syllable sound demand.
            rules.append(f"Syllable {int(e.get('pos', 0)) + 1} was mumbled as junk — "
                         f"do NOT use \"{w}\" (misheard); write whatever real word best fits "
                         f"the bar (its vowels were roughly {v} — optional flavor, not required).")
        else:
            rules.append(f"Syllable {int(e.get('pos', 0)) + 1}: the take likely said \"{w}\" "
                         "— reuse it only if it fits the bar; not required.")
    # Mouth movie (flow-over-sounds v2, 2026-07-12): the take's heard sounds are an OPTIONAL
    # flavor cue, NOT a per-syllable constraint. A hard syllable-by-syllable echo produced
    # sound-salad when the mumble was itself repetitive ("star burns star" -> "scars burn
    # scars"); the mumble's job is the FLOW (count/breath/stress/melody, already above).
    mtext = str(line.get("mouthText") or "")
    if line.get("mouthTargets") and mtext:
        rules.append(f"The take mumbled sounds like \"{mtext}\" — these are MISHEARD sounds, "
                     "NOT required words. The mumble's job is the FLOW you already have above "
                     "(syllable count, breath points, stress, melody). Write a COHERENT, "
                     "meaningful bar; if a natural word happens to echo one of those sounds "
                     "that's a small bonus, but coherence and craft come FIRST — never bend "
                     "the line toward the mumble's sounds.")
    # Bar IQ D — register. Raw is the DEFAULT (it's the artist's art): explicitly permit slang
    # / ad-libs / explicit language so the model doesn't self-censor into something neutered.
    # "clean" is the opt-in that sanitizes.
    if spec.get("explicit") == "clean":
        rules.append("Keep it clean — no profanity.")
    else:
        rules.append("Authentic register: slang, ad-libs, and explicit language are welcome — "
                     "don't self-censor or sanitize.")
    # CRAFT (owner, 2026-07-12: "provide the model some common frameworks for how to
    # approach writing a bar or using a punchline"). The mumble sets the FLOW; these teach
    # the model to fill it with a real bar, not filler.
    rules.append("CRAFT — write like a real bar, not a slot-filler: land a PUNCHLINE or "
                 "payoff on the last words (set it up early, pay it off at the end); use "
                 "CONCRETE imagery and specifics over vague abstractions; reach for WORDPLAY "
                 "/ double meaning and multisyllabic + internal rhyme; make each bar connect "
                 "to the theme and the line before it (tell a small story across the couplet).")
    # Filler LIMIT (owner: "yeah can be a placeholder but it can't be every word in the
    # bar") — REPLACES the old filler-generosity rule.
    rules.append("Filler ad-libs (yeah, uh, ay) are seasoning, not a meal: at most ONE per "
                 "bar and only on a genuinely isolated beat — never fill a bar with them.")
    # Style-RAG (§7): bias toward the artist's OWN voice with retrieved exemplars, but
    # forbid copying them verbatim — the model is steered by style, not by parroting.
    exemplars = _style_exemplars(spec)
    if exemplars:
        rules.append("Write in THIS voice (the artist's own lines) — match the phrasing, "
                     "imagery and vocabulary, but write NEW lines; do NOT copy them verbatim: "
                     + " / ".join(f"\"{e}\"" for e in exemplars) + ".")
    sys = ("You are an elite rap lyricist and ghostwriter with a real ear for flow. You "
           "write vivid, coherent bars that mean something: a clear image or story, a setup "
           "that pays off in a punchline, sharp wordplay, and multisyllabic rhymes that hit "
           "on the beat. You match a given rhythm exactly without ever padding a bar with "
           "empty filler. Reply with ONLY a JSON object "
           '{"lines": ["...", "...", "..."]} of candidate lines — your best, most quotable '
           "attempts. No commentary.")
    usr = " ".join(rules) + (f" Your previous attempt failed: {feedback} Fix it." if feedback else "")
    return [{"role": "system", "content": sys}, {"role": "user", "content": usr}]


def _parse_lines(content: str) -> List[str]:
    """Pull candidate line strings from an LLM reply (json_object), defensively.
    Text is apostrophe-normalized at the door so every consumer (graders, the SoulX
    score author, soundmatch) sees the same ASCII words."""
    content = _norm_apostrophes(content)
    out: List[str] = []
    try:
        obj = json.loads(content)
        if isinstance(obj, dict):
            v = obj.get("lines", obj.get("line"))
            if isinstance(v, list):
                out = [str(x) for x in v]
            elif isinstance(v, str):
                out = [v]
        elif isinstance(obj, list):
            out = [str(x) for x in obj]
    except (json.JSONDecodeError, ValueError, TypeError):
        out = [ln.strip(" -\t") for ln in content.splitlines()]
    return [s.strip() for s in out if s and s.strip()]


def _failure_reason(d: dict, target: int, tol: int, anchor: Optional[str], strict: str) -> str:
    if not d["syllableOk"]:
        return f"\"{d['text']}\" was {d['syllables']} syllables, need {target}±{tol}."
    if not d.get("breaksOk", True):
        return d.get("breaksReason") or "a word crosses a breath — end a word at the breath point."
    if not d.get("endOk", True):
        return d.get("endReason") or "never end the line on a dangling function word."
    if not d.get("rhymeOk", True) and anchor:
        return f"the last word \"{d['endWord']}\" must be a {strict} rhyme with \"{anchor}\"."
    if not d.get("lockedOk", True):
        return "you dropped one of the required words."
    # mouth is the LAST resort (flow-over-sounds v2): only re-prompt on sounds once every
    # real flow/rhyme/word constraint already passed, so sound feedback never preempts — or
    # reinjects salad into — a genuine flow failure.
    if not d.get("mouthOk", True):
        return d.get("mouthReason") or "the line drifted from the take's heard sounds."
    return "try again."


def _llm_propose_line(line: dict, spec: dict, anchor: Optional[str], regen: int,
                      context: Optional[dict] = None) -> List[dict]:
    target, tol, strict = _target(line, spec), _syl_tol(line), _strictness(line, spec)
    corpus = _style_corpus(spec)   # non-empty only when style biasing is opted in
    # Prefer Grok/xAI for lyrics (NSFW-tolerant; owner 2026-07-12) — resolve() falls through
    # to the configured chain when xai has no key, so this is safe when Grok isn't set up.
    provider = spec.get("llmProvider") or "xai"
    cands: List[dict] = []
    feedback: Optional[str] = None
    for _ in range(3):  # budget the retries (re-prompt with the specific phonology failure)
        resp = brain_client.chat_json(
            _build_messages(line, spec, anchor, target, tol, strict, feedback, context),
            requested=provider)
        if not resp.get("ok"):
            break
        raw = _parse_lines(resp.get("content", ""))
        # Style-RAG novelty wall: drop lines that parrot a corpus exemplar verbatim — bias
        # by style, not by copying. If that empties the batch, re-prompt for a fresh line.
        if corpus:
            kept = [t for t in raw if style_corpus.near_verbatim(t, corpus) is None]
            if not kept and raw:
                feedback = "that was almost word-for-word the reference — write a NEW line in the same voice."
                continue
            raw = kept
        fresh = [_evaluate(tx, line, spec, anchor, target, tol, strict) for tx in raw]
        cands.extend(fresh)
        if sum(1 for c in cands if c["passes"]) >= 2:
            break
        fails = [c for c in fresh if not c["passes"]]
        if not fresh or not fails:
            break
        feedback = _failure_reason(fails[0], target, tol, anchor, strict)
    if not cands:   # LLM/service unreachable mid-call → fall back to the fake for this line
        return _fake_propose_line(line, spec, anchor, regen)
    # STRICT COUNT (owner policy, 2026-07-12): an off-count line must never ship — the
    # score author would stretch/cram words to fit the slots. Keep only in-tolerance
    # candidates; if the LLM produced none, the deterministic filler (count-exact by
    # construction) ships instead, marked for re-rolling.
    exact = [c for c in cands if c.get("syllableOk")]
    if exact:
        return _rank(exact)
    filler = _fake_propose_line(line, spec, anchor, regen)
    for f in filler:
        f["fallback"] = "filler"
    return _rank(filler)


def _auto_backend() -> str:
    """Real LLM when a brain provider is configured (and not force-disabled), else fake
    — the same real→fake posture as stable_audio3 → FakeAdapter."""
    try:
        return "llm" if brain_client.available() else "fake"
    except Exception:  # noqa: BLE001
        return "fake"


def _propose_line(line: dict, spec: dict, anchor: Optional[str], regen: int, backend: str,
                  context: Optional[dict] = None) -> List[dict]:
    if backend == "llm":
        return _llm_propose_line(line, spec, anchor, regen, context)
    return _fake_propose_line(line, spec, anchor, regen)


def _run(spec: dict, indices: Optional[List[int]] = None,
         regen: Optional[Dict[int, int]] = None, backend: Optional[str] = None) -> dict:
    regen = regen or {}
    backend = backend or _auto_backend()
    by_index = sorted(spec.get("lines", []), key=lambda l: int(l.get("index", 0)))

    # Pre-scan FIXED rhyme anchors (a locked / finalized end word wins for its group).
    anchors: Dict[str, str] = {}
    for l in by_index:
        g, fe = l.get("rhymeGroup") or "", _fixed_end_word(l)
        if g and fe and g not in anchors:
            anchors[g] = fe

    out = []
    for l in by_index:
        if l.get("locked") or not _fillable(l):
            continue
        g = l.get("rhymeGroup") or ""
        anchor = anchors.get(g)
        is_anchor_line = anchor is not None and _fixed_end_word(l) == anchor
        props = _propose_line(l, spec, None if is_anchor_line else anchor,
                              int(regen.get(l["index"], 0)), backend)
        # A group with no fixed anchor takes the first generated line's end as its anchor.
        if g and g not in anchors and props:
            anchors[g] = props[0]["endWord"]
        if indices is None or l["index"] in indices:
            out.append({"index": l["index"], "proposals": props})
    return {"ok": True, "backend": backend, "lines": out}


def complete(spec: dict, regen: Optional[Dict[int, int]] = None, backend: Optional[str] = None) -> dict:
    """Fill every gap in the sheet — proposals for all fillable, non-locked lines."""
    return _run(spec, indices=None, regen=regen, backend=backend)


def complete_verse(spec: dict, chorus: str = "", theme: str = "",
                   regen: Optional[Dict[int, int]] = None, backend: Optional[str] = None) -> dict:
    """Stage B0 — COHERENT verse generation. Walk the skeleton in order, threading the
    chorus, theme, and the running verse-so-far into every line's prompt so the verse
    develops one story and resolves into the hook. Each line is still phonology-validated
    (syllables/stress/rhyme) and drawn from the vocab palette; the top proposal per line is
    committed as context for the next. Returns per-line proposals + the `chosen` verse path.

    Distinct from complete(), which generates every line independently (good for gap-fill,
    but disconnected across a whole verse)."""
    regen = regen or {}
    backend = backend or _auto_backend()
    theme = theme or spec.get("topic", "")
    by_index = sorted(spec.get("lines", []), key=lambda l: int(l.get("index", 0)))

    anchors: Dict[str, str] = {}
    for l in by_index:
        g, fe = l.get("rhymeGroup") or "", _fixed_end_word(l)
        if g and fe and g not in anchors:
            anchors[g] = fe

    fillable = [l for l in by_index if not l.get("locked") and _fillable(l)]
    total = len(fillable)
    prior: List[str] = []   # the committed verse-so-far (chosen lines + locked text), in order
    out = []
    pos = 0
    for l in by_index:
        if l.get("locked") or not _fillable(l):
            if l.get("text"):   # a locked/finalized line is still part of the story context
                prior.append(str(l["text"]))
            continue
        pos += 1
        g = l.get("rhymeGroup") or ""
        anchor = anchors.get(g)
        is_anchor_line = anchor is not None and _fixed_end_word(l) == anchor
        context = {"chorus": chorus, "theme": theme, "priorLines": list(prior), "position": pos, "total": total}
        props = _propose_line(l, spec, None if is_anchor_line else anchor,
                              int(regen.get(l["index"], 0)), backend, context)
        if g and g not in anchors and props:
            anchors[g] = props[0]["endWord"]
        chosen = props[0]["text"] if props else ""
        if chosen:
            prior.append(chosen)
        out.append({"index": l["index"], "proposals": props, "chosen": chosen})
    return {"ok": True, "backend": backend, "chorus": chorus, "theme": theme, "lines": out}


def fill_gap(spec: dict, line_index: int, regen: Optional[Dict[int, int]] = None, backend: Optional[str] = None) -> dict:
    """Fill one bounded line — proposals for just `line_index`."""
    return _run(spec, indices=[int(line_index)], regen=regen, backend=backend)


def suggest_next_line(spec: dict, after_index: int, regen: Optional[Dict[int, int]] = None, backend: Optional[str] = None) -> dict:
    """Single-bar ghost suggestion — proposals for the line after `after_index`."""
    return _run(spec, indices=[int(after_index) + 1], regen=regen, backend=backend)


# ── L1 — precise per-line ANALYSIS (the flow-visualizer feed; no LLM) ─────────────

def _group_anchors(by_index: List[dict]) -> Dict[str, str]:
    """The fixed (locked / finalized) end word that anchors each rhyme group — the same
    pre-scan the generation loop uses, so analysis and generation agree on the target."""
    anchors: Dict[str, str] = {}
    for l in by_index:
        g, fe = l.get("rhymeGroup") or "", _fixed_end_word(l)
        if g and fe and g not in anchors:
            anchors[g] = fe
    return anchors


def _analyze_line(line: dict, spec: dict, anchor: Optional[str]) -> dict:
    """Precise phonology for one line: syllables, stress contour, per-word slots, the
    rhyme grade vs the group anchor. Reuses _evaluate() so its pass marks are IDENTICAL
    to what the generation gate would accept — the visualizer never disagrees with the
    loop. Analyzes finalized text if present, else the seed's written words (gaps dropped)."""
    target = _target(line, spec)
    tol = int(line.get("syllableTol", 1) or 1)
    strict = _strictness(line, spec)
    txt = (line.get("text") or "").strip()
    seed = line.get("seedText") or ""
    has_gap = _has_gap(seed)
    if txt:
        content, analyzed = txt, "text"
    elif seed.strip():
        content, analyzed = " ".join(t["w"] for t in _tokens(seed) if not t["gap"]), "seed"
    else:
        content, analyzed = "", "empty"

    base = _evaluate(content, line, spec, anchor, target, tol, strict)
    base.pop("grade", None)   # _evaluate's grade is a generation shortcut (see below)
    words = re.findall(r"[A-Za-z']+", content)
    per_word = [{"w": w, "syllables": _P.syllables(w), "stress": _P.stress(w),
                 "inDict": _P.phones(w) is not None} for w in words]
    end = base["endWord"]

    # Analysis-specific, anchor-aware rhyme grade. _evaluate() reports "anchor" for ANY
    # line with a fixed end word (it won't grade a producer-locked line as a rhyme
    # attempt) — right for generation, but analysis must say honestly whether a FINALIZED
    # line actually rhymes with its group anchor. Only the line whose end == the anchor
    # is the anchor; the rest are graded against it.
    is_anchor = anchor is not None and end != "" and end.lower() == anchor.lower()
    if is_anchor:
        grade, rhyme_ok = "anchor", True
    elif anchor and end:
        grade = phon.rhyme_grade(_P.phones(end) or [], _P.phones(anchor) or [])
        rhyme_ok = _P.rhyme(end, anchor, strict)
    else:
        grade, rhyme_ok = "free", True
    base["rhymeOk"] = rhyme_ok
    base["passes"] = bool(base["syllableOk"] and rhyme_ok and base["lockedOk"])

    # Bar IQ C — rhyme CRAFT for the flow visualizer: how deep the end rhyme runs vs the
    # anchor (multisyllabic) + which words rhyme internally (a hallmark of skilled flow).
    rhyme_depth = (phon.multisyllabic_depth(_P.phones(end) or [], _P.phones(anchor) or [])
                   if (anchor and end and not is_anchor) else 0)
    internal = [[words[i], words[j]]
                for i, j in phon.internal_rhyme_pairs([(w, _P.phones(w)) for w in words], strict)]

    base.update({
        "target": target, "tol": tol,
        "rhymeGroup": line.get("rhymeGroup") or "",
        "rhymeAnchor": anchor or "",
        "rhymeGrade": grade,
        "rhymeDepth": rhyme_depth,
        "internalRhymes": internal,
        "stress": "".join(pw["stress"] for pw in per_word),
        "words": per_word,
        "hasGap": has_gap,
        "analyzed": analyzed,
        "complete": analyzed == "text" and not has_gap,
        "endInDict": bool(end) and _P.phones(end) is not None,
    })
    return base


def analyze(spec: dict) -> dict:
    """Precise per-line phonology for EVERY line in the sheet (locked + finalized too) —
    the flow visualizer's feed. Deterministic, no LLM; the rhyme anchor per group matches
    the generation loop's pre-scan."""
    by_index = sorted(spec.get("lines", []), key=lambda l: int(l.get("index", 0)))
    anchors = _group_anchors(by_index)
    out = [{"index": l["index"],
            "analysis": _analyze_line(l, spec, anchors.get(l.get("rhymeGroup") or ""))}
           for l in by_index]
    return {"ok": True, "lines": out}
