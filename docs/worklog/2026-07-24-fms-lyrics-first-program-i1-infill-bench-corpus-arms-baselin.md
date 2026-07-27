# FMS lyrics-first program — I1: infill bench (corpus + masks + metrics + arms + baselines) (2026-07-24)

- **FMS lyrics-first program — I1 LANDED: the masked-word infill bench (2026-07-24).** The owner
  pivoted the finish-my-song quality push to LYRICS-FIRST (design:
  `docs/superpowers/specs/2026-07-24-fms-lyrics-infill-bench-design.md`; charter/ledger:
  `docs/fms-lyrics-bench/PROGRAM.md`): collect known-good lyrics, mask words, score systems on
  guessing the fill — a verifiable cloze benchmark matching the product moment (user types part
  of a bar, system fills the blank). New lab `service/lyrics/bench/` (gate-discovered tests;
  stdlib+phonology core only — heavy deps live in a NEW venv `~/Library/Mosh/venvs/lyrics-bench`
  via `setup-lyrics-bench.sh`, subprocess-only). **Corpus**: `Dr3dre/Genius-song-lyrics-cleaned`
  streamed → 20k rap/en songs normalized (`segment.py` strips `[Verse]` headers / `…Embed` /
  "You might also like"; ZERO register filtering — raw register is the point) into
  `~/Library/Mosh/lyrics-bench/` (never git, never ~/Documents); owner catalog lane =
  `inbox/*.txt` (style_corpus.jsonl is ~empty — the taste-archive-is-empty class again).
  **Masking** (`mask.py`): 4 seeded policies — word (low-df content token, in-line-unique, never
  line-final), rhyme (line-end, ONLY when a ≥slant partner exists in ±3 lines → partner recorded
  as the constraint), span (2–4 tokens), line (≥2 before/≥1 after, syllable target) — pinned by a
  byte-identical frozen golden (`fixtures/expected_items_v1.jsonl`, 133 items over an invented
  fixture corpus). **Splits** (`build_eval.py`): near-dup clusters via shingle containment vs the
  GOLDEN pool (covers/remixes quarantined — the fixture remix leak-check is RED-proven), salted-
  hash train/dev, golden from the owner-edited local `golden_spec.json` (unmatched entries
  reported loudly; synthetic sources can never be golden; salt never leaves the data dir).
  **Metrics** (`metrics.py`): exact/topk (normalized), syl_fit, rhyme_fit (phones-required, else
  honestly None — love/move slant pinned), rhyme_perfect, multi_depth, stress_fit,
  constrained_fit. **Runner** (`runner.py` + `llm_cache.py`): replay-deterministic — every LLM
  response cached by prompt hash, `MOSH_INFILL_CACHE_ONLY=1` = bit-for-bit replay; summaries
  timestamp-free; cache telemetry deliberately EXCLUDED from determinism comparisons (miss-vs-hit
  counts are the honesty signal). **Arms** (`arms.py`): brackets `oracle` (ceiling + future
  judge-sanity probe) / `freq-floor`, baselines `llm-zeroshot` / `llm-constrained` (rhyme menu
  NOT yet — that's I3), and `product-llm` = the SHIPPED `lyrics.core.fill_gap` loop rebuilt
  around each item (context lines as locked anchors; invisible rhyme partner carried as a
  minimal anchor line) — the bar every arm must clear. Per-item answer-blindness pinned
  token-exact (substring would false-hit "rain" in "train"). **GOTCHAS caught by the tests:**
  (1) a word target duplicated in its own line stays visible after masking → in-line uniqueness
  is an eligibility rule; (2) `--limit` over an itemId-sorted list is 100% line-items
  (alphabetical bias) → round-robin across granularities; (3) fills arriving as "Cent," must be
  tokenized before pronouncing or scoring diverges from "cent". 9 hermetic suites (~120 checks),
  each import-RED + key guards sabotage-RED-proven, 3× deterministic. Baselines + scoreboard:
  `docs/fms-lyrics-bench/SCOREBOARD.md` (UNCALIBRATED banner until I2's owner blind-calibration
  sitting — the HALT gate; bars in PROGRAM.md stay DRAFT until then). NEXT: I2 judge stack
  (blind A/B panel, embedding sim, ppl) + calibration page + sitting 1; owner asks: golden_spec
  + inbox songs (see PROGRAM.md owner runbook).
- **Adversarial review (18-agent find→verify): 14 confirmed, 0 refuted — all fixed pre-PR.** The
  blocker: `product-llm`'s `_extract_fill` was DEAD CODE — blanks were located via `tokenize()`,
  whose word regex silently drops underscore tokens, so the product arm was scored on FULL LINES
  and its first committed word/rhyme/span baselines were invalid (exact signature: line rows
  perfect, sub-line rows floored). Fixed via a punctuation-tolerant blank-region regex + seedText
  gap normalization (`"____,"` would otherwise become a LOCKED word / rhyme anchor in
  `core._tokens`); invalid run dirs sidelined to `runs/_invalid/`, dev re-measured (arm v2).
  Corrected picture: the product loop is structurally competent (span cfit 100%, fake cfit
  91–97%) but overshoots syllables on rhyme slots (syl 33%) and recovers the exact word far below
  `llm-constrained` (word 6.7% vs 10.8%, rhyme 20% vs 47.4%). Other majors: goldenness now UNIONS
  over exact-content hash groups (a lex-earlier re-scrape of a golden song could previously drop
  the golden copy and route the twin into dev — repro'd, RED-proven); runner cache keys carry the
  item-content sha (an eval rebuild can re-mask the same itemId); runner determinism checks use
  FRESH caches (replay was satisfying them); the product-lane test pins `lyrics.core._P` to the
  injected lexicon (the real Pronouncer could lazily reach g2p_en/nltk — network in a test).
  **GOTCHA (bench):** never locate mask blanks through a word-regex tokenizer, and never trust an
  arm-determinism check that runs against a warm cache.
