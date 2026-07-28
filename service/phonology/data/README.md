# en_word_ranks.txt — general-English word frequency ranks

One word per line, **most frequent first**. Loaded by `service/phonology/freq.py`
as `{word: N - line_index}` so a higher value = more frequent and any word not in
the file scores 0. Only the ORDER is meaningful — the values are synthetic ranks,
not corpus counts (every product consumer either compares them or feeds them
through a capped log, so magnitudes are deliberately not preserved).

## Why this exists

`Pronouncer.rhyme_search` sorts (grade, syllables, alphabetical) and truncates at
`max_n` AFTER the sort, so a cap kept the alphabetically-early slice of a big rime
family — `booz`/`brack`-class CMUdict junk survived while the word a writer would
use fell off the end. Measured on the FMS lyrics bench (PROGRAM.md, 2026-07-28):
alphabetical truncation at cap 200 held **40.0%** of true answers; a
corpus-frequency tiebreak held **89.3%** of the same answers from the same
candidate set. The bench's frequency table is derived from the owner's lyrics
corpus and never ships; this file is the product-side frequency source that
exists on every user machine.

## Provenance

- Source: Peter Norvig's `count_1w.txt` (the 1/3-million most frequent English
  words with counts, derived from the Google Web Trillion Word Corpus),
  <https://norvig.com/ngrams/count_1w.txt>, published as free-to-use data files
  accompanying "Natural Language Corpus Data" (*Beautiful Data*, 2009).
- Fetched: 2026-07-28. Source sha256
  `51df159fd3de12b20e403c108f526e96dbd723d9cabdd5f17955cdc16059e690`
  (333,333 lines, strictly count-descending — verified at processing time).
- Processing (pure stdlib, no judgment calls): keep lines whose token matches
  `^[a-z]+$` (drops numerals/mixed tokens; the source is already lowercase),
  take the first 50,000, emit the words only, in source order.
- Output sha256
  `a86b609059080e04ed8655769f920c4031d59c059100a4cd7d657af7a036044d`.

The 50k cut keeps the file under 400 KB. Web-corpus junk deepens with rank
(`webalizer`, `anleitung`), but a table entry only ever matters when the word is
ALSO in the rhyme lexicon (CMUdict + palette), so deep junk is dead weight, not a
ranking hazard. Stopword filtering is deliberately NOT baked into this file —
it is consumer policy (`freq.STOP_AND_FILLER`), drift-pinned against the bench's
list by test.

Never put corpus-derived (lyrics) frequency data in this directory — the bench
table lives outside git for a reason.
