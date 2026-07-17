#!/usr/bin/env python3
"""FMS-Bench dataset layer — normalize a source corpus to the common item shape.

Item shape (what the benchmark runner consumes):
  {"id", "clean_vocal": wav_path, "singer", "song", "language",
   "license_tier": "eval-only"|"train-ok",
   "words": [{"word", "start", "end", "phones": [...]}, ...]}

First source: **NUS-48E** (research-only → eval-only tier, never a shipped model). Its
`<start> <end> <phone>` annotations use `sil` (silence) / `sp` (word boundary), so words are
the phone groups between those markers, WITH precise NUS timing. Word TEXT is reconstructed
by reverse-CMUdict (stress-stripped); a miss (sung vowel-reduction / OOV) keeps the joined
phones as the label — the timing is exact either way. Datasets live OUTSIDE git.
"""
from __future__ import annotations

import os

# ── registry (license-tiered, fail-closed for training) ─────────────────────────────────
REGISTRY = {
    "nus-48e": {
        "license": "NUS-48E research license (non-commercial)",
        "train_ok": False,          # eval-only — never a shipped trained model
        "language": "en",
        "default_root": os.path.expanduser("~/mosh-fms-ksb/bench/datasets/nus-48e/nus-smc-corpus_48"),
    },
}


def license_tier(dataset):
    return "train-ok" if REGISTRY.get(dataset, {}).get("train_ok") else "eval-only"


# ── NUS-48E phone-annotation parsing (pure) ─────────────────────────────────────────────

def parse_nus_txt(text):
    """`<start> <end> <phone>` lines → word groups split on sil/sp.
    Returns [{"start", "end", "phones": [...]}]."""
    groups, cur = [], []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 3:
            continue
        s, e, ph = parts
        if ph in ("sil", "sp"):
            if cur:
                groups.append(cur)
                cur = []
        else:
            cur.append((float(s), float(e), ph))
    if cur:
        groups.append(cur)
    return [{"start": g[0][0], "end": g[-1][1], "phones": [p for _, _, p in g]} for g in groups]


def word_text(phones, rev):
    """Reverse-CMUdict lookup (stress-stripped) → word, else the joined phones as a label."""
    return rev.get(tuple(p.lower() for p in phones)) or "".join(phones)


def build_reverse_cmudict():
    """{(stressless arpabet tuple): word} from cmudict; first spelling wins. Lazy/impure."""
    try:
        import cmudict
        d = cmudict.dict()
    except Exception:
        try:
            from nltk.corpus import cmudict as C
            d = C.dict()
        except Exception:
            return {}
    rev = {}
    for w, prons in d.items():
        if "'" in w or w.endswith(")"):
            continue
        for pron in prons:
            key = tuple(p.rstrip("0123456789").lower() for p in pron)
            rev.setdefault(key, w)
    return rev


def nus_item(txt_path, wav_path, rev, *, singer, song):
    groups = parse_nus_txt(open(txt_path).read())
    words = [{"word": word_text(g["phones"], rev), "start": g["start"], "end": g["end"],
              "phones": g["phones"]} for g in groups]
    return {"id": f"nus-{singer}-{song}", "clean_vocal": wav_path, "singer": singer,
            "song": song, "language": "en", "license_tier": "eval-only", "words": words}


def nus_items(root=None, *, singers=None, songs=None, limit=None, rev=None):
    """Enumerate NUS-48E sung items under `root` → normalized item dicts."""
    root = root or REGISTRY["nus-48e"]["default_root"]
    rev = build_reverse_cmudict() if rev is None else rev
    out = []
    for singer in sorted(os.listdir(root)):
        sdir = os.path.join(root, singer, "sing")
        if not os.path.isdir(sdir):
            continue
        if singers and singer not in singers:
            continue
        for f in sorted(os.listdir(sdir)):
            if not f.endswith(".txt"):
                continue
            song = f[:-4]
            if songs and song not in songs:
                continue
            wav = os.path.join(sdir, song + ".wav")
            if not os.path.isfile(wav):
                continue
            out.append(nus_item(os.path.join(sdir, f), wav, rev, singer=singer, song=song))
            if limit and len(out) >= limit:
                return out
    return out
