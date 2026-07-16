# a3b-r5 local MLX serving read (post-playtest deployment task)

Date: 2026-07-16
Adapter: `a3b-r5-cuda` (§P9 gate PASS 2026-07-10, bf16 LoRA on
`Qwen/Qwen3-30B-A3B-Instruct-2507`, r16 · α32 · q/k/v/o · layers 32–47;
`adapter_model.safetensors` sha256 `76f8db52ef732734…`, verified vs
`~/AI/adapters/a3b-r5-cuda-pull/a3b-r5-cuda`).
Hardware: the owner's M1 Max, 64 GB unified memory · mlx 0.31.2 / mlx-lm 0.31.3
(`~/Library/Mosh/venvs/sft`).

Question under test (program invariant, `docs/plans/MOSHI_TRAINING_PROGRAM_2026-07.md`):
does a local serve of r5 (a) hold the frozen-eval-v2 quality the bf16 adapter
passed, and (b) reach **< 2 s median** end-to-end (prior local median 8.3 s,
CURRENT_STATUS §B8)? The cloud brain stays the serving default until the owner
flips it — this read only reports against the two bars.

## Artifacts

| artifact | construction | size |
|---|---|---|
| `~/AI/adapters/a3b-r5-mlx` | PEFT→MLX conversion (`convert_peft_adapter_to_mlx.py`), 128 tensors, scale 2.0 | 18 MB |
| `~/AI/models/fused/a3b-r5-4bit-hd` | **attn-overlay** (`build_attn_overlay_model.py`): 4-bit base + exact bf16(base+Δ) attention Linears | 16.4 GB |
| `~/AI/models/fused/a3b-r5-8bit-hd2` | attn-overlay on the 8-bit base + verbatim bf16 routers & lm_head | 33.0 GB |

(Two probe-only intermediates were built and deleted after their attribution
data was recorded: the plain `mlx_lm fuse` 4-bit lane and 4-bit/8-bit overlay
variants isolating the router/lm_head contribution.)

**Why the overlay exists — fuse-into-4bit measurably destroys this adapter.**
r5 was trained against the *bf16* base (CUDA lane), unlike r3/r4 which were
QLoRA-trained on the 4-bit MLX base itself. Its weight delta is tiny relative
to the 4-bit grid (delta RMS ≈ 2 % of the mean quant step). Probing two
touched matrices after `mlx_lm fuse` into the 4-bit base: the applied weight
change has cosine ≈ 0.03 with the intended Δ and ~5–6× its norm — i.e. mostly
re-quantization noise; only ~17 % of ‖Δ‖ survives in-grid. The overlay instead
fetches the 64 touched bf16 attention tensors (~600 MB via HTTP range requests
against the HF shards — validated: dequant(4-bit base) vs fetched bf16 cos
0.9954, pure quant noise), computes base+Δ in f32, and stores those 64
projections as bf16 Linears via mlx-lm's per-layer quantization opt-out
(`config.quantization[path] = false`; layers without `.scales` load
unquantized — verified in mlx-lm 0.31.3 `utils.load_model`).

## Serving-trap #4 compliance (fuse first + differential probe)

Registered rule: never trust `--adapter-path` serving; serve a fused/merged
dir and prove the served weights are the adapter side before any eval.

- Identity probe: `/v1/models` returns the artifact path. ✓
- Differential probe (real rendered evalA row `evalA#move_section#0`, temp 0):
  - served-hd == offline-hd **byte-identical**
    (`{"intent":"ACK_GOT_IT","commands":[…move_section…]}`) ✓
  - offline-base differs (`ACK_WORKING`, spaced JSON vs the trained compact
    style) ✓
- (A toy out-of-catalog prompt showed served-vs-offline token flips — batched
  vs single-stream kernels make near-ties non-bit-stable; on real prompts the
  serve path reproduced offline generation exactly.)

## Bar (b) — latency, 4bit-hd

`bench_serve_latency.py`, 30 rendered evalA brain prompts (~2.76 k prompt
tokens each, per-row session snapshots — so consecutive requests share only
the static rules prefix, the real per-turn shape), eval-parity payloads
(temp 0, json_object, max_tokens 2500, no-think), `mlx_lm.server`, M1 Max:

- **Warm median 1.67 s** (p25 1.55 · p75 1.98 · max 2.83; 29 requests) — **clears < 2 s** ✓
- Cold first request (empty prompt cache, full ~2.8 k-token prefill): 6.54 s —
  a per-session one-time cost, ~490 tok/s prefill.
- Median over all 30 incl. cold: 1.69 s. 30/30 replies parsed as JSON.
- vs the recorded 8.3 s §B8 median (4B fused, no prompt-cache reuse): the win
  is mlx_lm.server's KV prefix reuse + the A3B's 3.3 B-active decode.

Full per-request data: `~/Library/Mosh/work/gate/rerun-evals/latency.a3b-r5-4bit-hd.json`.

Speculative decoding (0.6B 4-bit draft, `--num-draft-tokens 4`) was measured
and **rejected for this workload**: warm median 2.84 s (vs 1.67 s plain) —
typical Moshi turns generate only ~30 tokens, so the draft's own ~2.7 k-token
prefill + verify overhead outweigh the decode speedup (and the draft path
disables the server's batched engine). It would only help long note-population
generations. Data: `latency.a3b-r5-4bit-hd-draft.json`.

## Bar (a) — frozen eval surfaces (same harness as the §P9 read)

Surfaces staged at `~/Library/Mosh/work/gate/rerun-evals/` (the registered
location, recreated after a build-clean removed it):

- `evalA.eval.jsonl` — regenerated post-idfix via `buildEvalV2A.mts --repair`
  from the pre-fix file (sha `f4944392…`); output sha
  `d68ec63696ee1e88c2bb39c7ff21ae98e1dca4b60d9b762a680b33ac4019c911` — exact
  match to the registered post-idfix sha. 210 rows.
- `frozen300.test.eval.jsonl` — sha `1868ed3153ef7a21…`, §C = deterministic
  `--n 300` subsample (the gate procedure).
- `diag_floor4.eval.jsonl` — sha `6488483a7518abae…`, 19 rows (post-fixture-fix).

Harness: current main (`ui/` scripts; drift since the §P9 read = the idfix
itself #293 + the additive small-model arm #289 — the `--rules plain` path is
unchanged). Payloads: `--model default_model` → temp 0 + max_tokens 2500
(the documented temp-0 eval condition).

### Results — a3b-r5-4bit-hd vs the bf16 §P9 read

| leg | bf16 (2026-07-10) | 4bit-hd (this read) | gate bar |
|---|---|---|---|
| diag_floor4 clean-apply | 0.895 (1 defer/19) | **0.9298** (0 defer/19) | split_clip family ≥ 0.5: **0.833 ✓** |
| evalA clean-apply | 0.9357 (5 defer/210) | **0.9333** (0 defer/210) | ≈ parity |
| frozen300 clean-apply | 0.977 (6 defer/300) | **0.7667** (2 defer/300) | ✗ regression |
| aggregate (A,C) | 0.9563 | **0.8500** | ≥ 0.75 ✓ |
| §B grounded clean-apply | 0.8919 (33/37) | **0.9189** (34/37, wrong-defer 12→11) | ≥ 0.85 ✓ |
| per-command floors | all ≥ 0.5 | all ≥ 0.5 **except `add_note` 0.000 (n=6)** | ✗ one miss |

### The single divergence: the `add_note` routing flip

Everything above/at bf16 except ONE behavior: on "write a short pattern"-style
asks, the artifact answers `add_drum_pattern` (with a malformed bare-steps
lane string) instead of the trained `add_note` sequence. That one flip is:

- the whole evalA `add_note` family miss (6/6 rows, same signature),
- essentially the whole frozen300 drop (68 of the 70 zero rows carry the
  identical `add_drum_pattern … missing ':'` feedback; the corpus surface is
  note-population-heavy, hence −0.21 where evalA moved −0.002).

Attribution (measured):

- Lane-a `mlx_lm fuse` into 4-bit shows the **identical 6/6 signature** →
  not an overlay-construction artifact (two independent constructions agree).
- The **plain 4-bit base** (no adapter) also answers `add_drum_pattern` on
  these prompts → the bf16 adapter normally *overrides* a base prior; base
  quantization erodes the override on exactly this decision.
- An experiment artifact adding **verbatim bf16 MoE routers (all 48
  `mlp.gate`) + bf16 `lm_head`** on top of the attn overlay (113 overlaid
  paths, +0.45 GB) still shows the identical 6/6 signature → routers and
  lm_head precision are **exonerated**; the flip lives in the **quantized
  experts** (the FFN bulk — unfixable by any small overlay; 8-bit experts
  only partially recover it, see the 8-bit section). The fetched bf16
  routers/lm_head validated against the base at 8-bit/4-bit quant-noise
  levels (relerr ~1 % / ~9.5 %), same revision.

### Lane comparison — plain fuse-into-4bit (r3/r4 lane)

The tensor-level probe (script header) shows plain fuse keeps only ~17 % of
‖Δ‖ in-grid, yet the behavioral signature probe matches 4bit-hd on the flip
family. Full-surface reads were run on 4bit-hd only; the fused lane served as
the construction-bug control.

### 8-bit (a3b-r5-8bit-hd2: overlay + bf16 routers/lm_head)

- Fetched-tensor revision check vs the 8-bit base: relerr 0.74–0.76 % (pure
  8-bit quant noise). ✓
- **Latency: warm median 1.774 s** (p25 1.60 · p75 1.85 · max 3.09; 30/30
  JSON-clean) — **also clears < 2 s**. Per-turn cost is prefill-dominated, so
  the ~2× memory-bound decode barely moves a ~35-token reply. (The bench's
  first-request 2.67 s is NOT a cold number — the signature probe had
  pre-warmed the prompt cache; the honest cold prefill reference stays the
  4-bit run's 6.5 s.)
- **The add_note flip only partially recovers: 1/6** (4-bit: 0/6) — and the
  bf16 routers + lm_head extras change nothing at 8-bit either (attn-only
  8-bit probe: 1/6; with extras: 1/6). Precision-monotone but still broken:
  the adapter's override of this base prior does not survive expert
  quantization at any tested width.
- Full surfaces: diag_floor4 **0.8947** (0 defer/19; split_clip 0.833 ✓) ·
  evalA **0.9357** (0 defer/210 — exactly the bf16 aggregate; `add_note`
  still 0.000, the 1/6 probe recovery is boundary noise that flips with
  prompt-cache history) · frozen300 **0.7933** (1 defer/300; 58 of 61 zero
  rows carry the add_drum_pattern signature) · §B **0.9189** (34/37,
  wrong-defer 11, classes validation 2 / apply-error 4 / invented-file 2).

### Final comparison

| leg | bf16 (§P9, 07-10) | 4bit-hd | 8bit-hd2 | reference bar |
|---|---|---|---|---|
| warm median latency | (prior local 8.3 s) | **1.67 s ✓** | **1.77 s ✓** | < 2 s |
| diag_floor4 | 0.895 | 0.930 | 0.895 | split_clip ≥ 0.5 ✓✓ |
| evalA | 0.9357 | 0.9333 | 0.9357 | — |
| frozen300 (§C) | 0.977 | 0.767 ✗ | 0.793 ✗ | ≥ 0.875 (cloud) |
| aggregate (A,C) | 0.9563 | 0.850 | 0.865 | ≥ 0.75 ✓✓ |
| §B grounded | 0.8919 | 0.9189 | 0.9189 | ≥ 0.85 ✓✓ |
| `add_note` family | ≥ 0.667 | 0.000 ✗ | 0.000 ✗ | ≥ 0.5 |

## Recommendation

**No quantized serve of a3b-r5 clears both bars — do not flip the serving
default.** (Registered decision stays with the owner; this read just supplies
the numbers.)

- **Latency is SOLVED.** Both widths clear < 2 s decisively (1.67 s / 1.77 s
  warm median vs the prior 8.3 s) — mlx_lm.server prompt-prefix caching plus
  the A3B's 3.3 B-active decode make the M1 Max a viable serving seat. The
  latency leg of the invariant is no longer the blocker.
- **Quality fails on exactly one axis at both widths.** The bf16-trained
  adapter's note-population behavior (`add_note` sequences) collapses back to
  the base's `add_drum_pattern` prior under a quantized base: §C 0.767 /
  0.793 vs the 0.875 cloud reference and 0.977 bf16. Every other surface is
  at or above the bf16 gate read (§B actually improves to 0.919).
- **If forced to pick one artifact today: 4bit-hd** — same broken family as
  8-bit, faster, half the memory (17 GB vs 33 GB leaves headroom for SA3 +
  the app), and diag_floor4/§B at-or-above bf16. But it does not meet the
  registered quality bar, so it should not ship as default.
- **The fix is r6 trained against the 4-bit MLX base** (the §P8 local recipe,
  the r3 precedent: §C 0.960 served fused-4-bit). Train/serve precision
  matching is the durable lesson — §P9 caveat 3 anticipated it. Everything
  else is now in place for that cycle: conversion lane, overlay builder (not
  even needed when training on the quantized base — plain fuse suffices),
  latency bench, probes, and the re-staged frozen surfaces.
- Measured dead ends, so nobody re-tries them: plain fuse-into-4bit (~17 % of
  ‖Δ‖ survives), bf16 routers+lm_head overlays (behavior-neutral), 0.6B-draft
  speculative decoding (hurts short-turn median 1.67→2.84 s).

## BrainProxy wiring sketch (owner decision — NOT changed here)

`BrainProxy` already resolves providers env-first with a bundled
`Contents/Resources/brain.env` fallback (deepseek → openai → xai,
`MOSHI_BRAIN_PROVIDER` forces one). Local serving needs **zero C++**
for a manual bring-up:

```
MOSHI_BRAIN_PROVIDER=openai
OPENAI_BASE_URL=http://127.0.0.1:8080/v1
OPENAI_API_KEY=local
OPENAI_MODEL=default_model     # avoids the gpt-5* reasoning-payload branch
```

written to `brain.env` by a deploy variant (e.g. `run-mosh.sh deploy-local-brain`),
with `mlx_lm.server --model ~/AI/models/fused/<artifact> --port 8080` running.
The productized path wants: (1) a GenerativeJobManager-style spawn/health/reap
seam for the mlx server (the C2/C3 hardening patterns apply verbatim — PID
handshake + port fallback), (2) the first-turn cold prefill (~6.5 s) either
accepted, or pre-warmed by sending the static rules prefix once at session
open, (3) the cloud chain kept as fallback when the server/model dir is
absent. Removing the cloud key from shipped builds is the owner's ship gate,
per the program invariant, only after this read's numbers are accepted.

## Honest caveats

1. §B binary provenance: `/Applications/Mosh.app` (built 2026-07-11 08:03,
   post-hardening-sprint main ≈ #317; carries P1 split-normalization). Current
   main is 7 commits ahead (additive realtime-AI work); the §P9 §B binary was
   a 2026-07-10 gate3-source rebuild — same engine command surface, different
   builds. Not byte-identical provenance; same acceptance semantics.
2. evalA floor families are n=3–6; one row flips a floor — counts reported.
3. The bf16 comparison numbers were measured on the CUDA pod through the same
   eval scripts but a different serve stack (`serve_openai.py`, HF
   transformers); temp-0 determinism differs across stacks, so ±1-row moves
   are expected noise.
4. The warm latency median relies on mlx_lm.server prompt-cache prefix reuse;
   the first turn of each session pays the ~6.5 s cold prefill.
