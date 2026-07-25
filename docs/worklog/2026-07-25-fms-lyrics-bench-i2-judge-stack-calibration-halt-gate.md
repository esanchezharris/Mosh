# FMS lyrics-bench — I2: judge stack + owner blind calibration (the HALT gate) (2026-07-25)

- **I2 BUILT: the judge stack + the calibration sitting that gates every later arm (2026-07-25).**
  I1 produced deterministic columns (exact/topk, syllable/rhyme fit); I2 adds the columns that
  might capture *taste*, plus the instrument that decides whether any of them deserve to be
  optimized. Nothing about arm work starts until the owner's blind labels say a column tracks his
  ear (charter bar 0.65) — the program's governing lesson (five instrument "wins" that lost by ear)
  encoded as a **HALT**, not a footnote.
  - **`judge.py` — blind A/B vs the ground truth.** Each candidate fill is shown against the real
    human line with no marker of which is which, and **every pair is judged TWICE with the sides
    swapped**: a judge that merely picks a slot answers the same LETTER both times → `inconsistent`
    (worth nothing), while a real preference answers the same SIDE both times. RED-proven: with the
    swap removed, a purely position-biased judge scores a fabricated `win=1`. The "panel" is three
    deliberately different LENSES (meaning / craft / voice) rather than three providers, because
    only one provider is keyed on this Mac (`brain_client.resolve()` → openai gpt-5.4-mini, a
    reasoning model, so temperature is ignored — the cache, not temp 0, is what makes runs
    replayable). Errors and junk **abstain**; they never fall back to a coin flip that would read
    as a win. Judged granularities are span/line only — single words are decided exactly and for
    free by exact-match + phonology, so paying a panel there buys noise.
  - **`torchjudge.py` + `_torch_worker.py` — emb + ppl behind a subprocess seam.** `emb` = cosine
    of mean-pooled MiniLM embeddings of the truth-filled vs candidate-filled LINE; `ppl` =
    masked-LM **pseudo**-log-likelihood delta under roberta-base (labelled as PLL, not causal
    perplexity, wherever reported). Absent torch degrades to `status:"unavailable"` with scores
    `None` — **never a fabricated 0.0 that calibration would read as data**. Provenance
    (interpreter + model id) travels WITH each cached score, so a replayed number can still name
    its weights. The resolver reuses any venv that already has torch (the tunejury venv here), so
    `--torch` is optional rather than a second 1.5 GB install. Real-weights ordering verified:
    emb identical 1.00 / plausible 0.51 / nonsense 0.08; ppl 0.00 / +0.03 / +2.58 (opt-in smoke,
    `LYRICS_BENCH_TORCH_SMOKE=1`, kept out of the default gate like the SA3/whisper posture).
  - **`calibrate.py` + `calibrate_page.py` — the sitting.** Seeded pair minting balanced over
    (arm × granularity) with deliberate repeats measuring the OWNER's self-consistency; the blind
    key is a separate 0600 file and the rendered page contains only pairId/left/right/context
    (RED-proven: adding `truth` to the pair dict reds the blindness check). Stats are
    hand-verified — Wilson CI (n=4,k=3 → [0.3006, 0.9544]), tie-safe Spearman, Cohen's κ = 0.5 —
    and `elect()` **HALTs** when no column reaches the bar. Machine scores are stamped BEFORE the
    owner opens the page (prequential), so no metric can be tuned to the labels after the fact.
    The page is keyboard-first (A/B/T, ← back), autosaves each verdict over loopback, and APPENDS:
    a changed mind stays visible and a contradictory repeat resolves to `None` rather than
    silently taking the last click.
  - **First real judged numbers (dev, 40 items/arm, span+line).** `llm-constrained` — 25/40
    separated, **candidate beats the real human bar 52%** of the time; `product-llm` — 40/40
    separated, **0%**. Both are LLM-panel opinions with **zero** owner validation so far: that
    52% is precisely the claim the sitting exists to confirm or kill.
  - **GOTCHAS (both self-inflicted, both now structural).** (1) The alphabetical `--limit` bias
    fixed inline in `run` during I1 **recurred verbatim** in `judge` — itemIds start with the
    granularity, so "line" wins the alphabet and the first judged batch was 38 line / 2 span. The
    logic now lives in ONE tested helper (`sampling.balanced`) used by both call sites. (2) Arm
    identity was parsed out of the run-dir name, which contains a hyphen-bearing timestamp →
    `"31-54-llm-constrained"`; `sampling.arm_of` reads the run's own summary instead. Lesson worth
    keeping: *a fix applied inline is a fix that will recur at the next call site.*
  - **Verification (local only — CI is still frozen by the Actions billing outage, owner's call to
    gate on the Mac).** 6 new hermetic suites (judge 18 · torchjudge 16 · calibrate 26 · page 13 ·
    sampling 11), every module import-RED'd first, the two load-bearing guards (position-bias
    swap, page blindness) sabotage-RED-proven, all 3× byte-identical, `grep SABOTAGE` clean.
  - **NEXT (owner):** `bench_cli.py calibrate serve` → rate ~64 blind pairs (~45 min) →
    `calibrate report`. That either lifts the HALT and names the trusted metric per granularity,
    or keeps arms blocked and sends I2 back to judge design. Runbook in
    [`docs/fms-lyrics-bench/PROGRAM.md`](../fms-lyrics-bench/PROGRAM.md).
