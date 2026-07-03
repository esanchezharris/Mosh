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

Allocation: WP-0 $0.10 · WP-2 $40 · WP-4 $5+$35 · WP-5 $10 · WP-6 $50 (gate-dependent) · WP-7 $15 · WP-10 $10 · reserve ~$35.
