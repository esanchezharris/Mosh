# FMS phoneme-probe — Stage-0 falsification harness

Tests the "the take is a phonetic spec" thesis: CTC phoneme template + weighted
phonemic-distance rescoring of LLM candidate lines. EXPERIMENT ONLY — nothing here
ships; no MoshOps registrations; outputs live under `~/mosh-fms-ksb/phoneme-probe/`.

## Run order

```bash
# 0. setup (~10 min first time; downloads the 1.2 GB wav2vec2 phoneme model)
bash scripts/fms-phoneme-probe/setup-probe.sh
source scripts/fms-phoneme-probe/.probe.env

# 1. unit tests (all deterministic; run 3x when touching the modules)
"$PROBE_PY" scripts/fms-phoneme-probe/ipa_norm_test.py
"$PROBE_PY" scripts/fms-phoneme-probe/distance_test.py
"$PROBE_PY" scripts/fms-phoneme-probe/template_build_test.py
"$PROBE_PY" scripts/fms-phoneme-probe/gen_candidates_test.py

# 2. extraction (known-lyric take first; --force after code changes)
K=~/mosh-fms-ksb; P=$K/phoneme-probe
HF_HUB_OFFLINE=1 "$PROBE_PY" scripts/fms-phoneme-probe/phoneme_extract.py \
  $K/pella-goingdown-91-v4/input.wav --words $K/pella-goingdown-91-words.json \
  --f0 $K/pella-goingdown-91-v1/f0.json --out $P/pella-goingdown-91
# mumble takes: NO --words (their Whisper cache is garbage by construction)
HF_HUB_OFFLINE=1 "$PROBE_PY" scripts/fms-phoneme-probe/phoneme_extract.py \
  $K/lala1-127-v4/input.wav --f0 $K/lala1-127-v1/f0.json --out $P/lala1-127
HF_HUB_OFFLINE=1 "$PROBE_PY" scripts/fms-phoneme-probe/phoneme_extract.py \
  $K/poppinshit-134-v4/input.wav --words $K/poppinshit-134-words.json \
  --f0 $K/poppinshit-134-v1/f0.json --out $P/poppinshit-134

# 3. STAGE B — metric kill-shot (LLM-free decision point; run sabotage too, always)
"$PROBE_PY" scripts/fms-phoneme-probe/validate_metric.py $P/pella-goingdown-91 \
  --lyrics scripts/fms-killshot/ksa-inputs/goingdown-lyrics.txt \
  --words $K/pella-goingdown-91-words.json --json-out $P/pella-goingdown-91/validate.json
"$PROBE_PY" scripts/fms-phoneme-probe/validate_metric.py $P/pella-goingdown-91 \
  --lyrics ... --words ... --sabotage shuffle-phones     # must collapse or the
                                                          # metric is VACUOUS

# 4. STAGE C — generation + rescore (gated on Stage B; calls the brain, cached)
MOSH_BRAIN_ENV=~/Library/Mosh/brain.env "$PROBE_PY" \
  scripts/fms-phoneme-probe/gen_candidates.py $P/lala1-127 --topic "..." --mood "..."
"$PROBE_PY" scripts/fms-phoneme-probe/rescore.py $P/lala1-127

# 5. STAGE D — blind listening page (the owner's ear is the verdict)
"$PROBE_PY" scripts/fms-phoneme-probe/make_probe_page.py $P
python3 -m http.server 8189 -d $P
# tick candidates, press Export, then:
"$PROBE_PY" scripts/fms-phoneme-probe/make_probe_page.py --score $P '<pasted JSON>'
```

## Verdict bars (pre-registered)

| stage | PASS | KILL | VACUOUS |
|---|---|---|---|
| B (metric) | top-2 ≥ 0.7 AND median margin > 0.5, sabotage top-2 ≤ 0.35 | top-2 ≤ 0.4 or margin ≈ 0 | sabotage top-2 > 0.5 |
| C (rescore) | top-5 vs random-5 separation ≫ 0 sd | separation ≈ 0 | — |
| D (ear) | owner picks hit top-5 at ≥ 2× the random-5 rate | top rate ≤ random rate | — |

## 2026-08-11 findings (first full run)

- **Stage B on pella-goingdown-91** (produced full-mix song, harder than the dry-mumble
  product domain): top-1 **0.45**, top-2 0.50, MRR 0.52 over 20 scorable lines with a
  ~52-candidate pool; **sabotage collapses to 0.05** (the signal is genuinely phonetic).
  Stratification: clean solo-vocal spans ≈ 11/12 truth in top-2 with positive margins;
  every failure sits on spans with overlapping echo vocals / heavy effects, where the
  CTC stream is visibly garbage (`tamkɛɑɛntsaː` for "I'm going down") — a recognizer
  front-end failure on produced audio, not a metric failure (the report's pre-declared
  "domain gap" branch). Formal aggregate verdict vs the pre-registered bars:
  NOT PASS on this take — margin median ≈ 0 dragged by the corrupt stratum.
- **Sung-vowel reductions are real and metric-relevant**: every sung "down" decodes as
  [daːn] (no ʊ glide). Fixed principledly: vowel emphasis applies to syllable NUCLEI
  only (`distance.nucleus_flags`); glides cost like consonants.
- **Pure humming defeats the phoneme recognizer**: lala2-127 (closed-mouth hum) yields
  ~7 phones over 15 s — no phonetic template exists. Articulated mumbles (lala1,
  poppinshit) decode richly. Product implication: the phonetic path needs la/da/na
  articulation; hums fall back to the rhythm-only skeleton path.
- Continuous singing defeats gap segmentation (mainvox = one 46-syllable span) —
  line-scale units need bar-based splitting (the product's mumble.py already bins by
  bars; this harness uses largest-gap recursive splitting as an approximation).
- **Stage C**: ~100 LLM candidates/line (gpt-class via brain_client, cached).
  Top-5 vs random-5 rescore separation: lala1-127 **1.59 sd** (2 lines),
  poppinshit-134 **1.78 sd** (11 lines, every line > 0.9 sd). Top candidates are
  audibly template-shaped (liquid onsets + open vowels for the la-la take). Blind
  page at `~/mosh-fms-ksb/phoneme-probe/index.html` (195 blind candidates); owner
  verdict via `make_probe_page.py --score` is the remaining Stage-D gate.
