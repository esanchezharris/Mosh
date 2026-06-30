# Reward-validity probe

Does a **higher §12 composite** — and specifically the learned **`pull`** term — correspond to
"sounds better to a human"? The §11 keystone proved *relative* ordering (original > ablation);
this probe tests *absolute* validity with the owner's ears as ground truth, **before** any further
policy/RL investment. Motivation + decision gate: `docs/AUDIO_RL_REVIEW_BRIEF.md`.

Why it matters: `composite = clean·(0.5·pq/10 + 0.5·pull)`, and only `pull` is learned/taste-bearing
— `pq` is a hand-tuned DSP heuristic, `clean` a hygiene gate. If `pull` doesn't track human taste,
GRPO would optimize the production surface, not music.

## Pipeline (all under the teardown venv, `PYTHONPATH=service`)

1. `samples.py` — curated real Splice melodic loops (genre/mood/tempo/key spread) + `prep()` which
   resamples each to 44.1kHz/PCM_16 under `.assets/` (gitignored). **Mandatory:** the headless
   `Mosh --run-script` render STALLS on a non-44.1k wave-clip source.
2. `variator.py` — builds 88 candidates: 12 bases × a 7-level quality gradient (tight → groove
   damage → tempo/key clash → mud/clip) + 4 hand anchors. Each is a deterministic command program
   (bundled drum kit MIDI + imported tempo-matched melodic loop).
3. `probe_score.py` — render via `Oracle` + score via `make_reward()` (the activated composite),
   returning `{pq, clean, pull, composite}` **separately** (the GRPO CLI only emits the scalar).
4. `build_pack.py` — render+score+loudness-normalize all candidates → a **blind** rating pack at
   `~/mosh-reward-probe/` (clips/ in randomized order, RATINGS.csv, AB_PAIRS.csv) + a **private**
   `.mapping.json` (joined only in analysis).
5. `rating_app.py` — writes a self-contained, blind `index.html` rating page into the pack.
6. `analyze.py` — Phase 2 (after the owner rates): Spearman ρ(rating, {composite,pull,pq,clean})
   pooled+per-base, `pull` dynamic range, A/B agreement, per-intent table, and a 🟢/🟡/🔴 verdict.

## Run

```sh
TEARDOWN_PY=service/teardown/.venv/bin/python
PYTHONPATH=service $TEARDOWN_PY service/teardown/probe/build_pack.py --out ~/mosh-reward-probe
PYTHONPATH=service $TEARDOWN_PY service/teardown/probe/rating_app.py --pack ~/mosh-reward-probe
# owner rates via the page → fills RATINGS.csv / AB_PAIRS.csv, then:
PYTHONPATH=service $TEARDOWN_PY service/teardown/probe/analyze.py --pack ~/mosh-reward-probe
```

Note: candidate generation is the **programmatic variator over real samples**, not the agent brain
— the brain is policy-limited (narrow quality spread → non-decisive ratings) and provenance is
irrelevant to *reward* validity; what matters is that candidates sound like real music and span
quality. The brain/policy is a separate (downstream) question gated on this probe's verdict.
