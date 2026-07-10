#!/usr/bin/env python3
"""Forced-alignment slot builder (FMS sung-render root fix).

The blind nuclei detector OVER-SEGMENTS sustained/ornamented singing, so a held word gets
more slots than syllables and the score author had to fill them by re-articulation ("down
down"). When the words are KNOWN (extraction / calibrate truth), CTC forced alignment
(torchaudio MMS_FA) gives each word's audio span directly, so we can emit exactly its
syllable count of slots, timed from the AUDIO — no over-segmentation to paper over.

Two layers:
  - PURE (group_word_spans / slots_for_word): CTC token spans → per-word audio spans →
    syllable slots. Hermetic, deterministic, tested by align_test.py.
  - REAL (align_words): loads MMS_FA and aligns; needs torch+torchaudio+uroman in the
    skeleton venv. Returns None when unavailable so callers fall back to the skeleton path.
"""
from __future__ import annotations

import math
from typing import List, Optional


# ── PURE layer ─────────────────────────────────────────────────────────────────────────

def group_word_spans(token_spans, per_word_lengths, sec_per_frame: float) -> List[dict]:
    """Group a FLAT list of CTC token spans (frame indices, one per aligned character)
    back into per-word audio spans in SECONDS. `per_word_lengths[i]` = the number of
    tokens word i contributed (its romanized-character count)."""
    out, pos = [], 0
    for n in per_word_lengths:
        grp = token_spans[pos:pos + int(n)]
        pos += int(n)
        if not grp:
            continue
        out.append({"start": grp[0][0] * sec_per_frame, "end": grp[-1][1] * sec_per_frame})
    return out


def _median(vals: List[float]) -> Optional[float]:
    s = sorted(vals)
    n = len(s)
    if n == 0:
        return None
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def _pitch_from_f0(f0, a: float, b: float, default: int = 69) -> int:
    """Median F0 (Hz) over [a, b) → nearest MIDI note; `default` when no voiced F0 lands
    in the window (e.g. a rest or an unvoiced consonant slot)."""
    if not f0:
        return default
    hz = [float(p["hz"]) for p in f0
          if a <= float(p["t"]) < b and float(p.get("hz", 0) or 0) > 0]
    m = _median(hz)
    if not m:
        return default
    return int(round(69 + 12 * math.log2(m / 440.0)))


def clamp_span_to_voicing(start: float, end: float, env, hop_s: float, floor: float,
                          min_note: float = 0.08, min_sil_s: float = 0.15) -> float:
    """Trim a note's end so it does not SUSTAIN past where the take goes silent (the owner's
    rule: a long sustained note where the original is quiet is a bug — the last word held too
    long, a held note bleeding through a breath). The note ends at the FIRST sustained silence
    (≥ min_sil_s) after its voicing onset — NOT the last voiced frame, so an over-extended span
    that crosses a rest INTO the next word's voicing is still trimmed at the rest. `env` = the
    take's per-frame energy. No env, or the span outside env coverage, → unchanged."""
    if not env:
        return end
    i0 = max(0, int(start / hop_s))
    i1 = min(len(env), int(round(end / hop_s)))
    if i1 <= i0:
        return end
    min_sil = max(1, int(round(min_sil_s / hop_s)))
    voiced_start = next((j for j in range(i0, i1) if env[j] >= floor), None)
    if voiced_start is None:                 # covered but never voiced → minimal note
        return start + min_note
    sil_run = 0
    for j in range(voiced_start, i1):
        if env[j] < floor:
            sil_run += 1
            if sil_run >= min_sil:           # sustained silence began (j - min_sil + 1)
                return max(start + min_note, min(end, (j - min_sil + 1) * hop_s))
        else:
            sil_run = 0
    return end                               # no sustained silence → genuinely held


def slots_for_word(start: float, end: float, syl: int, f0=None) -> List[dict]:
    """Split a word's audio span [start, end] into `syl` contiguous syllable slots (min 1),
    each pitched from the take's own F0 median over its window (the validated repitch lever).
    A 1-syllable held note stays ONE slot — that is the over-segmentation fix."""
    k = max(1, int(syl))
    dur = (end - start) / k
    slots = []
    for i in range(k):
        a = start + dur * i
        b = end if i == k - 1 else start + dur * (i + 1)
        pitch = _pitch_from_f0(f0, a, b)
        slots.append({"start": a, "end": b, "velocity": 90, "kind": "gap",
                      "segments": [{"start": a, "end": b, "pitch": pitch}]})
    return slots


def enforce_min_durations(durs, mins):
    """Raise each below-minimum note to its minimum, taking the deficit PROPORTIONALLY from the
    notes that have surplus (so a crammed word becomes singable while the phrase's TOTAL span —
    and the anchored notes around it — stay put). If the phrase can't fit the minimums even by
    flattening the surplus, it EXTENDS (each note gets its min). Pure; deterministic."""
    durs = [float(d) for d in durs]
    mins = [float(m) for m in mins]
    total = sum(durs)
    if sum(mins) >= total:                    # can't fit even flattened → phrase extends
        return list(mins)
    deficit = sum(max(0.0, m - d) for d, m in zip(durs, mins))
    surplus_total = sum(d - m for d, m in zip(durs, mins) if d > m)
    out = []
    for d, m in zip(durs, mins):
        if d < m:
            out.append(m)
        elif d > m and surplus_total > 0:
            out.append(d - (d - m) * deficit / surplus_total)
        else:
            out.append(d)
    return out


def lines_from_aligned(aligned_words, line_word_counts, f0=None, bpm: float = 120.0,
                       grid: str = "1/16", algo: str = "align", bridge_gap_s: float = 0.35,
                       take_env=None, env_hop_s: float = 0.01, sil_floor=None,
                       min_syl_dur: float = 0.14) -> List[dict]:
    """Aligned words (from align_words) + per-line word counts → score-author `lines`.

    Each word gets its phonology syllable count of slots, timed within its OWN aligned span
    (so a held note is one slot, not over-segmented). LEGATO BRIDGING: a small inter-word gap
    is the sustain the CTC aligner leaves unattributed on singing, so the note is extended to
    the next word's onset; a gap ≥ bridge_gap_s is a genuine pause and stays a rest. When a
    take energy envelope is supplied, each note's END is CLAMPED to the take's voicing so no
    note sustains into take-silence (the last-word-held-too-long / held-through-a-breath bug).
    The result feeds score.author_score unchanged — the alignment-driven replacement for the
    skeleton's `lineScores`."""
    from phonology import core as ph
    pr = ph.Pronouncer()

    def _syl(w: str) -> int:
        c = "".join(ch for ch in w.lower() if ch.isalpha() or ch == "'")
        return max(1, pr.syllables(c) or 1)

    floor = None
    if take_env:
        floor = sil_floor if sil_floor is not None else 0.15 * max(take_env)

    lines, pos = [], 0
    for bar, n in enumerate(line_word_counts):
        group = aligned_words[pos:pos + int(n)]
        pos += int(n)
        if not group:
            continue
        # 1) per-word [word, start, end] after legato bridge + voicing clamp
        spans = []
        for i, w in enumerate(group):
            start, end = float(w["start"]), float(w["end"])
            if i + 1 < len(group):
                nxt = float(group[i + 1]["start"])
                if 0.0 <= nxt - end < bridge_gap_s:   # legato: absorb the unattributed sustain
                    end = nxt
            if floor is not None:                     # trim a note that sustains into take-silence
                end = clamp_span_to_voicing(start, end, take_env, env_hop_s, floor)
            spans.append([w["word"], start, max(end, start + 0.01)])

        # 2) enforce a minimum articulation time within each contiguous PHRASE-run: a crammed
        #    word (the take's fast mumble the CTC aligner captured ~0.1s) is unsingable and SoulX
        #    garbles it — raise it to min_syl_dur × syllables, taking the time from the run's long
        #    words so the run span (and the anchored down-lines) don't move. A gap breaks the run.
        i = 0
        while i < len(spans):
            j = i
            while j + 1 < len(spans) and spans[j + 1][1] - spans[j][2] <= 0.02:
                j += 1
            run = spans[i:j + 1]
            new = enforce_min_durations([s[2] - s[1] for s in run],
                                        [min_syl_dur * _syl(s[0]) for s in run])
            t = run[0][1]
            for k in range(len(run)):
                run[k][1] = t
                run[k][2] = t + new[k]
                t = run[k][2]
            i = j + 1

        # 3) slot each word from its (redistributed) span
        slots, words = [], []
        for word, start, end in spans:
            words.append(word)
            slots.extend(slots_for_word(start, end, _syl(word), f0=f0))
        lines.append({"text": " ".join(words),
                      "score": {"v": 1, "algo": algo, "bar": bar, "bpm": bpm,
                                "timeSig": [4, 4], "grid": grid, "clamped": False, "slots": slots}})
    return lines


# ── REAL layer (MMS_FA; skeleton venv) ───────────────────────────────────────────────────

def available() -> bool:
    """True when the forced-alignment stack is importable (torch/torchaudio/uroman)."""
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        import uroman  # noqa: F401
        return True
    except Exception:
        return False


def _romanize_tokens(words: List[str], dictionary: dict):
    """Romanize each word (uroman) and map its characters to MMS_FA dict token ids.
    Returns (flat_token_ids, per_word_lengths, romanized_words). Characters absent from
    the dict (spaces, stray punctuation) are dropped; a word that romanizes to nothing
    keeps a single fallback token so alignment never loses a word."""
    import uroman as _uroman
    ur = _uroman.Uroman()
    flat, lengths, roman = [], [], []
    for w in words:
        r = ur.romanize_string(w).lower().strip()
        ids = [dictionary[c] for c in r if c in dictionary]
        if not ids:  # keep the word present in the alignment even if unromanizable
            ids = [dictionary.get("a", 1)]
            r = r or w
        flat.extend(ids)
        lengths.append(len(ids))
        roman.append(r)
    return flat, lengths, roman


def align_words(audio, words: List[str]) -> Optional[List[dict]]:
    """CTC forced-align KNOWN `words` to `audio` (path or (mono_list, sr)) → per-word
    [{word, start, end, score}] in seconds. Returns None if the stack/model is unavailable
    or the audio is empty, so callers fall back to the blind skeleton path."""
    if not words or not available():
        return None
    try:
        import torch
        import torchaudio
        import torchaudio.functional as F
        from torchaudio.pipelines import MMS_FA as bundle

        if isinstance(audio, str):
            # stdlib wave (via the skeleton core) — torchaudio.load needs torchcodec/ffmpeg,
            # which the pipeline deliberately avoids (see the transform CLI).
            from skeleton import core as skcore
            r = skcore.read_pcm_mono(audio)
            if not r:
                return None
            mono, sr = r
        else:
            mono, sr = audio
        if not len(mono):
            return None
        wav = torch.tensor([list(mono)], dtype=torch.float32)
        if sr != bundle.sample_rate:
            wav = torchaudio.functional.resample(wav, sr, bundle.sample_rate)
        n_samples = wav.size(1)

        model = bundle.get_model()
        dictionary = bundle.get_dict()
        flat, lengths, _roman = _romanize_tokens(words, dictionary)
        with torch.inference_mode():
            emission, _ = model(wav)
        targets = torch.tensor([flat], dtype=torch.int32, device=emission.device)
        aligned, scores = F.forced_align(emission, targets, blank=0)
        token_spans = F.merge_tokens(aligned[0], scores[0].exp())
        n_frames = emission.size(1)
        sec_per_frame = n_samples / n_frames / bundle.sample_rate
        spans = [(int(s.start), int(s.end)) for s in token_spans]
        # merge_tokens emits one span per NON-BLANK token; that is exactly len(flat).
        word_spans = group_word_spans(spans, lengths, sec_per_frame)
        # scores per word = mean token score over the word's tokens
        out, pos = [], 0
        for w, n in zip(words, lengths):
            grp = token_spans[pos:pos + n]
            pos += n
            if not grp:
                continue
            sc = sum(float(s.score) for s in grp) / max(1, len(grp))
            ws = word_spans[len(out)]
            out.append({"word": w, "start": ws["start"], "end": ws["end"], "score": sc})
        return out
    except Exception:
        return None
