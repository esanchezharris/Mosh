# Stage-1/2 run — cloud spend ledger (2026-07)

*Hard cap **$200** (owner, 2026-07-03). Soft halt $190. Rates: gpt-5.4-mini via the brain proxy;
estimates use the recorded ~$0.0015/turn average with token counts logged for audit.
⚠️ A concurrent session shares the same API key — this ledger bounds only this run's spend.*

Checkpoints (cumulative re-read against the allocation): before WP-2 · after WP-3 (⛳ shift rule) ·
after WP-4 calibration (bulk projection; projection > remaining−reserve ⇒ HALT, never shrink the ⛳
50/command target) · before WP-6 · before each RFT round.

| # | date | WP | tool + args | calls | tok in | tok out | est. $ | cum. $ |
|---|------|----|-------------|-------|--------|---------|--------|--------|
| 1 | 2026-07-03 | WP-0 | synthesize --commands set_track_volume --per 2 (smoke) | 3 | 5,041 | 108 | 0.005 | 0.005 |
| 2 | 2026-07-03 | WP-2 | build-sft s1-bt real BT (5 shapes × 3 styles) | 15 | ~15k | ~4k | 0.02 | 0.03 |
| 3 | 2026-07-03 | WP-4 | synthesize cal-01 (10 track/mixer cmds × 8) | 90 | 194,227 | 3,981 | 0.14 | 0.17 |
| 4 | 2026-07-03 | WP-4 | synthesize cal-02..08 (64 cmds × 8, calibration) | 576 | 1,245,485 | 30,245 | 0.86 | 1.03 |
| 5 | 2026-07-03 | WP-4/5 | driver smokes (rich/rendered/proposals/negatives) | 37 | ~68k | ~2k | 0.06 | 1.09 |
| 6 | 2026-07-03 | WP-7 | eval-v2 §B fixture dry-run v1 vs cloud (instrument validation — caught 11 unfair intents pre-freeze) | 62 | ~250k | ~5k | 0.09 | 1.18 |
| 7 | 2026-07-03 | WP-7 | eval-v2 §B fixture dry-run v2 vs cloud (corrected fixture; doubles as cloud anchor candidate) | 59 | ~240k | ~5k | 0.09 | 1.27 |
| 8 | 2026-07-03 | WP-7 | eval-v2 §B v3 vs cloud (FINAL instrument; cloud anchor 83.8%/75%) | 57 | ~235k | ~5k | 0.09 | 1.36 |
| 9 | 2026-07-03 | WP-4/5 | bulk round 1 (11 coverage runs + 2 negatives runs; 1,545 rows kept incl. 115 negatives) | 3,010 | 7,025,479 | 158,308 | 4.51 | 5.87 |
| 10 | 2026-07-03 | WP-4 | bulk round 2 (9 runs, state hints; 36/78 at target after) | 1,453 | 3,383,410 | 76,197 | 2.18 | 8.05 |
| 11 | 2026-07-03 | WP-4 | bulk round 3 FINAL (8 runs; 40/78 at target, coverage closed) | 1,277 | ~3.0M | ~68k | 1.92 | 9.97 |
| 12 | 2026-07-03 | WP-7 | eval-v2 §A synthesis (eval profile, 69 cmds × 8 → 318 kept → 265 items/51 cmds) | 612 | 1,326,513 | 32,834 | 0.92 | 10.89 |

Allocation: WP-0 $0.10 · WP-2 $40 · WP-4 $5+$35 · WP-5 $10 · WP-6 $50 (gate-dependent) · WP-7 $15 · WP-10 $10 · reserve ~$35.
