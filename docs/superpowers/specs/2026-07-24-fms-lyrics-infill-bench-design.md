# FMS Lyrics-First Program — masked-word infill bench + arm bake-off (design)

*Owner-approved 2026-07-24 (plan thread). This spec is the program charter's design half; the
run-state ledger lives in `docs/fms-lyrics-bench/PROGRAM.md`.*

## Why

Finish-my-song has a working vocal spine (Phase 1–3), but the owner is pivoting the quality push:
**produce high-quality lyrics first**, vocal matching later. The prior bench branch's own verdict
supports the re-focus (`origin/claude/fms-solve-for-the-song-bench` tip: "owner verdict —
guide-grade NO; words were never the binding constraint" — for the *guide vocal*; lyric quality as
its own goal was never the thing measured). The owner's proposed method — collect verifiable
known-good lyrics, mask words, have the system guess the fill from surrounding context — is
masked-LM/infill training plus a **verifiable cloze benchmark**, which matches the product moment
exactly: the user types part of a bar and the system fills the blank. JEPA-proper (embedding-space
prediction) appears as one arm: a learned candidate ranker.

This is a research program in the repo's kill-shot style: bench first, judges calibrated against
the owner's ear **before** any arm optimization (the lesson of the five instrument-wins that lost
by ear), pre-registered GO/ITERATE/KILL verdicts, winners promoted into the existing
`_propose_line` seam. Mapping fills back onto the mumble-take skeleton is explicitly out of scope
(the Phase-3 sing lane owns that).

## Decisions (locked with the owner)

| Axis | Decision |
|---|---|
| Corpus | All sources: HF Genius datasets (prefer `Dr3dre/Genius-song-lyrics-cleaned`, fallback `sebastiandizon/genius-song-lyrics`), owner catalog + `style_corpus.jsonl`, PD/open text, synthetic. **Personal-research posture**: lyric text + weights live outside git, never ship, never committed; repo carries code, numbers, hashes only. |
| Arms | All: baselines, prompt-side, FIM-LoRA fine-tune (sft lane), learned embedding ranker, combos. Training only if the bench proves it necessary. |
| Masks | All 4 granularities: single content word, line-end rhyme word, multi-word span, whole line. |
| Judges | All candidates (phonology fit, embedding sim, LLM panel, perplexity); a calibration round **elects which to trust** per granularity. |
| Golden | Broad rap slice for train/dev; golden = taste-curated via local `golden_spec.json` (owner-edited, never committed). |
| Compute | Per-arm escalation: Mac MLX → `ssh pc` (4070S, recipe search) → Vast (ask per-run). |
| Budget | ~$50 API total, hard `--budget` refusal, response-cached so nothing is paid twice. |
| Ear discipline | Calibrate-first HALT: no arm optimization until a judge combo reaches agreement ≥ 0.65 vs owner blind labels. Two sittings (~45 min, ~30 min). |
| Success | Calibrated metric gate then owner blind ear gate; pre-registered bars, golden budget 2 reads/arm, append-only ledger. |

## Layout

- **Code + hermetic tests**: `service/lyrics/bench/` (gate-discovered — `gate.sh` globs
  `service/**/*_test.py`; `scripts/` is not discovered). Core lib + tests import stdlib +
  `phonology`/`lyrics` only; heavy deps (datasets, sentence-transformers, mlx) live behind
  `setup-lyrics-bench.sh` → `~/Library/Mosh/venvs/lyrics-bench` and are reached by subprocess.
- **Data**: `~/Library/Mosh/lyrics-bench/` (`MOSH_LYRICS_BENCH_DIR` override):
  `raw/ corpus/ eval/ cache/ runs/ calibration/ adapters/ golden_spec.json`. Never under
  `~/Documents` (iCloud eviction), never in git.
- **Program docs**: `docs/fms-lyrics-bench/PROGRAM.md` (charter, frozen bars, append-only decision
  ledger) + `SCOREBOARD.md` (machine-regenerated; numbers/hashes only). Per-arm verdicts as dated
  docs in `docs/superpowers/specs/` (kill-shot format: bars frozen before running).

## The benchmark

**Song record** (normalized by `segment.py`): `{songId, source, artist, title, genre, views,
licenseTier, sections:[{kind,label,lines[]}]}`. Sections are load-bearing (whole-line masking needs
same-section context; choruses repeat → dedup/triviality vector). `views` kept as the memorization
stratifier. `licenseTier`: `eval-only` (Genius) vs `train-ok` (own/synthetic/PD). Zero
register/profanity filtering anywhere — raw register is the point.

**Masking** (`mask.py`, pure, per-item seed `sha256(policyVersion|songId|si|li|gran)`):
- `word` — low-document-frequency content token, never line-final, stopword/filler-excluded.
- `rhyme` — line-end token, emitted only when a ≥slant `rhyme_grade` partner exists within ±3
  lines; the partner becomes `constraints.rhymeWith` (this is what makes rhyme-fit non-vacuous).
- `span` — 2–4 contiguous tokens, never including the line-final token.
- `line` — whole line with ≥2 prior / ≥1 following in-section lines; `lineSyllableTarget` from the
  Pronouncer.

Eval item: itemId (embeds `POLICY_VERSION`), granularity, context (before/maskedLine/after), target
(text + phones/syllables/stress precomputed at build time; `phonesSource` flagged), constraints
(only serve-time-observable facts), split, views, seed.

**Splits** (`build_eval.py`): near-dup clusters (seeded MinHash over line shingles — covers,
remixes, re-releases collapse) are the split unit; golden membership by salted hash (salt lives
only in the data dir); golden-artist songs appear in **no** other split; manifest records the
`golden_spec.json` sha and the leak-scan report.

**Metrics** (`metrics.py`): exact (normalized), top-k, `syl_fit`, `rhyme_fit`, `stress_fit`
(reported, never gating), `multi_depth`; `constrained_fit` = AND of applicable fits. Judged
metrics (I2): embedding sim + LLM panel (blind A/B vs truth, order-swapped double judging,
deepseek-first) + perplexity delta — run only on span/line, dev/golden, all cached.
No composite is invented up front: **calibration elects the trusted column per granularity**
(`calibration/TRUSTED_METRICS.json`; the scoreboard says "UNCALIBRATED" until it exists).

**Runner** (`bench_cli.py`): arm contract `propose(item, ctx) -> {candidates, meta}` with declared
cache keys; built-ins `oracle` (ceiling + judge-sanity probe: truth-vs-truth must judge ~50/50),
`freq-floor`, `llm-zeroshot`, `llm-constrained`, `product-llm` (wraps the shipped
`fill_gap(spec, backend="llm")` loop — the bar every arm must clear). Every provider response is
cached by prompt hash; `MOSH_INFILL_CACHE_ONLY=1` replays a run bit-for-bit. Runs are append-only
under `runs/`; `summary.json` records cacheHits/misses so a "reproduction" with misses is
self-evidently not one.

## Arms (I3–I5)

- **Prompt-side**: `prompt-constrained` (constraint prompt + rhyme *menu* from
  `Pronouncer.rhyme_search` + palette rhymeFamily), `prompt-rag` (+ `style_corpus.retrieve`
  few-shot, `near_verbatim` parrot guard), `prompt-nbest-rerank` (25 draws → dedupe → validator
  hard-gate via the product's own `_evaluate` → validator + self-consistency ordering). Every arm
  reported raw AND validator-reranked; the delta is the measured value of the validator.
  `frontier-naive`'s fame-bucket split is the memorization diagnostic; **low-fame is the headline**.
- **FIM-LoRA** (sft lane): chat-JSONL infill examples whose constraints encode only
  serve-time-observable facts (leakage rule); cond/nocond ablation; song+cluster-disjoint dataset
  with a required `--exclude-manifest`; Mac tier trains against the 4-bit base and serves
  `--adapter-path` on the same base — **never fuse** (r5: fusing kept ~17% of the delta); CUDA is
  recipe search only, the shipped adapter retrains on MLX.
- **Ranker (JEPA-flavored)**: frozen MiniLM embedder + small predictor MLP, InfoNCE;
  hard negatives are syllable-matched + same-rhymeFamily (validator-passing by construction, so
  the ranker must learn what phonology can't); extrinsic eval = rerank frozen arm caches.
- **Combos** are runner configs over frozen caches (generator × rerank 2×2).

## Gates (frozen in PROGRAM.md at I2, before any arm runs)

GO = golden ≥ baseline by pre-stated effect (≥ +5pts constrained-fit@1 or ≥60% judge win) AND
validator pass-rate ≥ baseline AND owner blind pairwise ≥ 60% over ≥20 pairs AND p50 latency ≤
1.5× current. ITERATE = dev-better/golden-inconclusive, max 2 cycles. KILL = golden ≤ baseline,
two dry rounds, ear rejects, or infeasible. Golden budget: 2 reads/arm, every read appended to the
ledger. Judge-health tripwire: ≥3/10 sampled "wins" owner-rejected → arm freezes, back to
calibration. **HALT**: no arm work until some judge combo reaches ≥0.65 agreement with owner blind
labels (I2 sitting 1).

## Promotion (I6)

Three shapes, all small and flag-gated, product byte-identical when artifacts are absent:
prompt winner → `_build_messages` default; FIM winner → `service/lyrics/local_backend.py` +
backend `"local"`, `_auto_backend()` = local→llm→fake (`MOSH_ENABLE_LYRIC_LOCAL`); ranker winner →
optional `_rank` hook (`MOSH_ENABLE_LYRIC_RANKER`, default off). Untouched by construction:
server HTTP shapes, agent catalog, `LyricPanel.tsx`, native `--selftest`.

## Increments

I1 corpus + bench harness + first baseline number → I2 judge stack + owner blind calibration
(HALT gate) → I3 bench-branch 8-file port + prompt arms → I4 training arms → I5 combos + owner
confirmation + verdicts → I6 promotion. Each lands as its own PR with RED-proven hermetic tests
(synthetic fixtures only — invented bars, real register, zero real lyrics committed).
