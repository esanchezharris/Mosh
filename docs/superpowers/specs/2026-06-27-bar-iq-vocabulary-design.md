# Bar IQ — vocabulary + rhyme-craft coverage (design)

## Context

The Finish-My-Song lyric system (PR #174) is built on a phonology core that uses **cmudict**
— a formal dictionary with almost no slang, coined words, ad-libs, or profanity. For any
out-of-vocabulary word, rhyme falls back to a crude spelling-tail heuristic, so fresh/slang
words *scan* but rhyme poorly; generation leans clean and bland. The producer's ask:
**give the system the best "bar IQ" possible** — make it smart about sound, rhyme craft,
vocabulary, and register — *without* cloning specific artists.

The key reframe: **"the data" is a vocabulary, not lyrics.** A word + its pronunciation +
its rhyme family + its register is a *fact*, not protected expression, so we can gather it
freely from open sources and the producer's own writing. Reference artists are *taste
inputs* that tell us which vocabulary/register to support — never a stored lyric corpus.
This keeps the whole feature copyright-clean while opening up the vocabulary.

Approved approach: **grow the existing phonology core into a layered "bar engine"** — the
only option that keeps the phonology *validator* in the loop (so suggestions stay checkable,
not slop) while broadening coverage. Build order **A → B → C → D**; A is the foundation
everything else depends on.

Non-goals: voice/style cloning of specific artists (the §7 corpus already handles the
producer's *own* voice); scraping or storing third-party lyrics; on-demand generation of
multi-word rhyming phrases (deferred — see below).

---

## A — Layered pronouncer (the foundation)

`Pronouncer.phones(word)` becomes a fallback chain, first hit wins:

1. **User lexicon** — words the producer added or corrected (highest priority; their ear overrides the machine).
2. **cmudict** — authoritative for standard English.
3. **g2p (grapheme→phoneme)** — pronounces *anything*, returning **ARPAbet** (same format as cmudict, zero conversion). This is what gives slang / coined / NSFW words real phonemes.
4. **Vowel-group heuristic** — existing last resort when the phonology venv is absent.

- **Engine (VERIFY at build):** candidate `g2p-en` (MIT, numpy+nltk, ARPAbet output). Before committing, confirm it installs arm64-light and emits ARPAbet; if heavy/awkward, fall back to a rule-based G2P or `phonemizer` (espeak→IPA→ARPAbet conversion). The *layer* is the design; the engine is verified.
- Lives in the existing phonology venv (`setup-phonology.sh` adds it). Absent venv ⇒ degrades to the heuristic (the established real→fake posture).
- g2p results are **memoized per-word** (deterministic → goldens stay stable).
- Effect: `rhyme()` runs the real phoneme-based `rhyme_grade` for almost any word instead of the spelling-tail fallback; the generation **validator** can now verify slang rhymes.

**Tests:** OOV slang words return phonemes and rhyme/scan correctly; user-override beats cmudict; determinism 3×; graceful degrade when the venv is absent.

---

## B — Vocabulary palette (passive-leaning)

A tagged word bank the system draws from and searches:
`{ word, phones (optional — the pronouncer fills it), register: clean|slang|profanity|adlib, tags: [money, flex, place, …], rhymeFamily }` (`rhymeFamily` precomputed from the rime so search is fast).

**Three sources, layered (passive-leaning — minimal manual effort):**
1. **Open seed** — license-clean word lists (open slang/profanity/ad-lib lexicons), curated once into a bundled JSONL. Word lists are not protected expression.
2. **Auto-harvest from the §7 corpus** — the producer's accepted lines are already accumulating (`style_corpus.jsonl`); their content words fold into the palette automatically (register inferred). The flywheel feeds the vocabulary for free.
3. **Manual add (occasional, thin)** — a small "add words" path: words (+ optional register), tokenized + pronounced (via the pronouncer) + deduped into the user lexicon/palette. Words are facts → copyright-clean.

**Two consumers:**
- **Rhyme search** (`get_rhymes` / the rhyme tool): the search corpus expands from cmudict-only to cmudict + palette, so slang/coined words *surface* as rhyme candidates.
- **Generation**: the fake backend draws register-appropriate end-words/filler from the palette (instead of "up/down/now"); the LLM backend gets a register *permission* + a few exemplar words (not a dump).

**Storage:** a JSONL palette keyed by `MOSH_LYRIC_CORPUS_DIR` (alongside `style_corpus.jsonl`), managed backend-only like the corpus (`stats()` = counts only). The user lexicon (A's overrides) and the palette can share this store.

**Tests:** palette load + rhyme_search includes palette words; harvest extracts content words from corpus lines; manual-add round-trip; determinism.

---

## C — Rhyme craft

Bar IQ is mostly **multisyllabic** and **internal** rhyme — "had to plan" / "Ramadan", or rhymes landing mid-line — which single-end-word grading can't see. All algorithmic over phonemes (works on any word now that A covers them).

- **Multisyllabic tail grading** — compare the last *k* syllables across word boundaries, not just the final word; report rhyme *depth* (how many trailing syllables align) + a grade.
- **Internal-rhyme detection** — find rhyming word pairs within a line.
- **Assonance** — extend the existing per-rime vowel(slant) matching across the tail.

**Where it plugs in:**
- **`analyze_lyrics`** reports rhyme depth + internal rhymes → the flow visualizer shows skill, not just pass/fail.
- **The generation ranker** rewards depth → proposals that rhyme 2–3 syllables deep beat shallow ones; the loop starts *preferring* skilled bars.

**Scope:** ship the *grading + ranking* side (deterministic, easy goldens, immediately improves the visualizer + generation). **Defer** on-demand generation of multi-word rhyming *phrases* (a harder phrase-search problem).

**Tests:** multisyllabic depth goldens ("made a man" / "Pakistan" → depth ≥2); internal-rhyme detection; ranker prefers deeper rhymes; determinism.

---

## D — Register (falls out of B)

Because every palette word carries a `register` tag, the same palette powers **both** raw-by-default **and** a real "clean version" (filter the profanity-tagged words). Concretely:
- Default the sheet/generation register to **raw** (the existing `explicit` field already defaults to `"allow"` — confirm the prompt + fake filler aren't prudish; let the palette supply slang/profanity).
- "Clean" stays an opt-in that filters profanity-tagged palette words and instructs the LLM.

No new subsystem — a default posture + a filter over B's tags.

**Tests:** raw default surfaces profanity-tagged words; clean mode filters them.

---

## Data flow

```
open seed JSONL  ─┐
§7 corpus harvest ┼─→  vocabulary palette (JSONL, MOSH_LYRIC_CORPUS_DIR)  ─┬─→ rhyme search (get_rhymes / rhyme tool)
manual add       ─┘         ↑ phones via layered Pronouncer (A)            └─→ generation (fake filler + LLM register/exemplars)
                                                                                  ↑ ranker rewards multisyllabic depth (C)
analyze_lyrics ──→ rhyme depth + internal rhymes (C) ──→ flow visualizer
```

All of it runs through the phonology venv (precise) or degrades to the heuristic (absent
venv). Deterministic throughout (memoized g2p, sorted dict ops, fixed seeds) so goldens are
stable. Service-spawning paths stay **out of `--selftest`** (proven by Python goldens + HTTP
smokes + `--run-script`); `--selftest` must hold at its current count.

## Components & files

| Layer | Files |
|---|---|
| Pronouncer (A) | `service/phonology/core.py` (layered `phones()` + g2p layer + memoize), `service/phonology/setup-phonology.sh` (add g2p), `service/phonology/phonology_core_test.py` |
| Palette (B) | `service/lyrics/vocab.py` (new — palette store/load/harvest/tagging, on `style_corpus.py`'s pattern), `service/server.py` (`/vocab` add/stats; rhyme-search corpus expansion), goldens `service/lyrics/vocab_test.py` |
| Rhyme craft (C) | `service/phonology/core.py` (`multisyllabic_grade`, `internal_rhymes`, tail helpers), `service/lyrics/core.py` (ranker rewards depth), `service/lyrics/analyze`-path, goldens |
| Register (D) | `service/lyrics/core.py` (raw default in the prompt/filler), palette register filter |
| Native (thin) | a manual `add_vocabulary` path mirroring `styleCorpusAdd` (non-spawning, best-effort) if the manual-add surface is wired; otherwise B is fully service-side + harvest-driven |
| UI (thin) | rhyme tool already surfaces `get_rhymes`; a small "add word" affordance + (optional) a register toggle reusing the existing `explicit` control |

## Testing & verification

- **Python goldens (3× deterministic, `*_test.py`):** layered pronouncer (OOV rhyme), vocab palette (harvest + search + register filter), rhyme craft (multisyllabic depth + internal). Run via `gate.sh`.
- **HTTP smokes:** `/get_rhymes` surfacing palette/slang words; `/vocab` add→stats; generation with the palette.
- **`--run-script` end-to-end:** harvest from an accepted line → that word becomes a rhyme candidate; a multisyllabic-rich proposal ranks above a shallow one.
- **C++ / `--selftest`:** unchanged count (the new paths spawn the service → out of selftest; any native add is additive + non-spawning). Catch2 unaffected.
- **UI:** `tsc` clean; vitest for any mock; e2e against an **isolated `vite --port 5191 --strictPort`** with the camera fake-media flags (NOT the shared `:5173` owned by a concurrent worktree session).
- **VERIFY before relying:** g2p-en is arm64-light + ARPAbet (else swap the engine behind the same layer).

## Deferred (named, not lost)

On-demand generation of multi-word rhyming *phrases*; real phoneme embeddings for rhyme search (the lexical path is the seam); a full active-curation UI (passive-leaning ships first); cross-language phonology; learned register/tag classification (seed + heuristic first).
