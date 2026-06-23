# Moshi note-population — the one open task, cracked

*The SFT rung ([MOSHI_TRAINING_RUNG_SCOPE.md](MOSHI_TRAINING_RUNG_SCOPE.md)) took a 4B to
parity with frontier gpt-5.4-mini on deterministic command emission, but left **one**
task unsolved: "**write a short pattern into the clip**" — content generation. This is
the fix. Authored 2026-06-22.*

## The problem was three stacked bugs, not one

Re-grading the recorded eval outputs surfaced that the residual "note-population gap"
was actually three independent failures:

| model | overall (old→fair) | populate (old→fair) | populate deferrals |
|---|---|---|---|
| baseline gpt-5.4-mini | 0.757 → **0.868** | 0.087 → **0.503** | 13 / 40 |
| 4B unmasked (cuda v2) | 0.733 → 0.733 | **0.000** | **40 / 40 — always defers** |
| 4B masked (local v2) | 0.458 → **0.547** | 0.067 → **0.400** | 0 / 40 — acts, but ~3 notes |

1. **Unfair metric.** The eval graded a populate reply by *multiset* recall against the
   source clip's exact note count (often 64), so a valid 6-note pattern scored 6/64 ≈
   0.09. **Fix:** `ui/src/gepa/metric.ts` `fairRecall` caps the required multiplicity of
   any one command at `SHORT_PATTERN_NOTES = 8` — a "short pattern" earns full credit;
   deterministic single-op gold is graded exactly as before. (Also fixed a real footgun:
   `__resetMockForTests` now resets the id counters, so the offline dump/replies paths
   mint matching ids.)
2. **No assistant masking on the CUDA lane.** trl's `assistant_only_loss` needs a chat
   template with `{% generation %}` tags; Qwen3's lacks them, so the first cloud run fell
   back to full-sequence loss — the ~3k-token system prompt dominated the gradient and the
   model learned to **defer** on note population (40/40). **Fix:** `sft_cuda_train.py`
   injects the tags into the *real* template (byte-identical render → no train/serve skew),
   proven GPU-free by `service/sft/verify_mask.py`. (The mlx lane already masks via
   `--mask-prompt`.) On a template-shape mismatch the trainer now hard-fails rather than
   silently reverting to the known-bad config.
3. **Truncated targets.** `max_seq_length` was 2048, but a populate example is ~3.3k
   tokens (system prompt + 64-note target) — the target was truncated off the end and the
   model never saw a full pattern. **Fix:** both lanes default to **4096**.

## Result — the masked + seq-len-fixed retrain (local mlx, 200 iters)

`finetuned-local-v3` vs the prior runs, all under the fair metric, same 150-task subset:

| metric | local v2 (truncated) | **v3 (masked + 4096)** | baseline gpt-5.4-mini |
|---|---|---|---|
| overall clean-apply | 0.547 | **0.769** | 0.868 |
| deferrals | 44 / 150 | **12 / 150** | 13 / 150 |
| populate (fair) | 0.400 | **0.434** | 0.503 |
| populate deferrals | 0 / 40 | **0 / 40** | 13 / 40 |

The trained 4B now **writes valid, musical patterns and never defers** on note population.
A sampled reply for *"write a short pattern into the clip on the BASS track"*:

```json
{"intent":"ACK_WORKING","commands":[
  {"command":"add_note","args":{"clipId":"109","pitch":36,"start":0,"length":0.5,"velocity":80}},
  {"command":"add_note","args":{"clipId":"109","pitch":36,"start":1.0,"length":0.5,"velocity":80}},
  {"command":"add_note","args":{"clipId":"109","pitch":36,"start":2.0,"length":0.5,"velocity":80}},
  {"command":"add_note","args":{"clipId":"109","pitch":36,"start":3.0,"length":0.5,"velocity":80}} ]}
```

A clean four-on-the-floor bassline on the right clip — the hard part (act, target the
right clip, emit valid notes) is solved.

## Honest residual — pattern length (it's training *volume*, not target length)

v3 emits ~4 notes; the fair floor for full credit is 8, and baseline emits ~6. So v3 is
*reliable* (0 deferrals) but *short*, landing populate at 0.434 vs baseline's 0.503 (and
baseline only reaches 0.503 by acting richly the 27/40 times it doesn't defer — when it
acts it's ~6 notes, but it defers a third of the time, which v3 never does).

**Tested hypothesis — target-length alignment (negative result).** Natural guess: the
model learns to stop early because its targets are 64-note source clips. So `buildSft`
gained a `--max-notes` knob and a second model (**v4**) trained on a dataset capped at 16
notes — short-pattern targets aligned with both the "short pattern" ask and the fair
floor. Result on the *same* eval set: **overall 0.776, populate 0.434** — statistically
identical to v3 (0.769 / 0.434); v4 still emits ~3-4 notes. So target length is *not* the
lever. The model has a strong "emit a few commands then stop" prior that ~200-250 iters
(a small fraction of one epoch over 100k examples) doesn't override for the populate
minority. The real lever is **training volume** — the multi-epoch cloud run
(`sft_cuda_train.py`, now with working assistant masking), which exposes the model to far
more populate examples. That, not a dataset trick, is the path to a richer pattern.

## Reproduce

```bash
# fair metric + masking proof (no GPU)
cd ui && npm test -- src/gepa/metric.test.ts
source service/sft/.sft.env && "$SFT_PY" service/sft/verify_mask.py

# retrain + eval (Apple Silicon)
"$SFT_PY" service/sft/sft_cli.py train --data service/sft/.sft-data/sft-v2 \
  --out service/sft/.adapters/sft-v3 --iters 200 --no-grad-checkpoint   # masked + seq-len 4096 by default
"$SFT_PY" service/sft/sft_cli.py fuse --adapter service/sft/.adapters/sft-v3 --out service/sft/.fused/sft-v3
"$SFT_PY" -m mlx_lm server --model "$PWD/service/sft/.fused/sft-v3" --port 8090 &
cd ui && OPENAI_BASE_URL=http://127.0.0.1:8090/v1 OPENAI_MODEL=mlx-community/Qwen3-4B-Instruct-2507-4bit \
  OPENAI_API_KEY=local npm run eval-sft -- \
  --eval ../service/sft/.sft-data/sft-v2/test.eval.jsonl --n 150 --tag finetuned-local-v3
```
