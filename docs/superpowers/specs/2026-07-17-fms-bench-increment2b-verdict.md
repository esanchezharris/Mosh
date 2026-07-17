# FMS-Bench increment 2b — faithful audio-in run on NUS-48E (2026-07-17)

The dataset half of increment 2: normalize NUS-48E, run the faithful audio-in harness on
real sung vocals, and produce the mumble-ratio scoreboard. The owner supplied NUS-48E
manually (its official download is dead / by-request).

## Built
- **Normalizer** (`bench_dataset.py`): NUS-48E phone annotations (`<start> <end> <phone>`,
  `sil`/`sp` boundaries) → the common item shape. Words = phone groups between sil/sp with
  PRECISE NUS timing; text via reverse-CMUdict (stress-stripped; miss → phone label).
  Registry marks `nus-48e` **train_ok:false** (research license → eval-only, never a shipped
  model). Real reconstruction: Edelweiss / Love Me Tender recover cleanly (~65% text-mapped,
  exact timing on all).
- **Faithful-run harness** (`bench_run.py`): per item × ρ → `bench_mumble` degrades a
  fraction of words → pluggable generator → `score_vocal` vs the clean vocal. Generators:
  `oracle` (=clean, ceiling), `passthrough` (=mumble, floor), `pipeline` (real FMS sing
  chain, **owner/GPU-gated — raises until armed**). `build_scoreboard` pivots into
  generator × ratio curves.
- **Scoreboard** (`bench_scoreboard.py`): self-contained HTML, inline-SVG curves + per-item
  mumble players. Served + screenshot-verified.

## Run: 3 NUS singers (ADIZ / JLEE / ZHIY), 24 runs, ρ ∈ {0.2, 0.4, 0.6, 0.8}

| ρ | 0.2 | 0.4 | 0.6 | 0.8 |
|---|---|---|---|---|
| **passthrough** word bag-coverage | 0.841 | 0.736 | 0.644 | **0.382** |
| passthrough onset F1 (timing) | 0.998 | 0.988 | 0.984 | 0.984 |
| passthrough naturalness (pq) | 7.36 | 6.89 | 6.09 | 5.24 |
| **oracle** bag-coverage / pq | 1.0 / 7.65 | — flat across ρ — | | |

**Reading it:** word recovery declines **monotonically** (0.84 → 0.38) as more of the song
is mumbled — the parametric "solve for the song" difficulty dial, on real human vocals.
**Timing stays flat at ~0.98** at every ρ, confirming the mumble synthesizer preserves
rhythm regardless of ratio (faithful by construction). Oracle is the flat ceiling;
passthrough is the floor the real pipeline must beat (at ρ=0.8 it recovers only 38% of words
— a good pipeline should fill the mumbled words back in and score higher).

## Instruments' behavior (design confirmed)
Because the mumble deliberately preserves pitch + rhythm, **word-match is the discriminator**
and onset/F0 stay high — so the benchmark cleanly separates "did it recover the words" from
"did it keep the performance." That separation is exactly the correctness-vs-naturalness /
timing decomposition the design set out to enforce. (word-match ground truth = Whisper on the
CLEAN vocal, not the reverse-CMUdict reconstruction, so the axis actually moves.)

## Verification
- Goldens ×3-det: `bench_dataset`, `bench_run` (pure pivot + injected-deps wiring),
  `bench_mumble`, plus all increment-1 suites. `overlap --selftest` green.
- GOTCHA fixed: `bench_mumble.degrade()` lazy-imports librosa (→ numba, whose in-process
  import order is flaky in the teardown venv). The runner now shells out to a `bench_mumble`
  CLI so librosa never loads in the long-lived run process (the `nsf_cli` isolation pattern).
- Datasets + run artifacts live under `~/mosh-fms-ksb/bench/` (never in git).

## What's next
- **Owner/GPU:** arm the `pipeline` generator (local MLX / PC SoulX) → the real sing pipeline
  becomes the third curve; THIS is the measurement the whole framework exists for.
- **Owner:** the real (mumble→finished) pairs + naturalness-on-real-vocals validation.
- Scale (more singers/songs) is a one-flag change; a fuzzy reverse-CMUdict pass would lift
  the ~65% text-map rate (labeled follow-up).
