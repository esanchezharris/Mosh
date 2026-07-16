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
| `~/AI/models/fused/a3b-r5-4bit` | `mlx_lm fuse` into the 4-bit base (the r3/r4 lane) | 16 GB |
| `~/AI/models/fused/a3b-r5-4bit-hd` | **attn-overlay** (`build_attn_overlay_model.py`): 4-bit base + exact bf16(base+Δ) attention Linears | 16.4 GB |
| `~/AI/models/fused/a3b-r5-8bit-hd` | attn-overlay on the 8-bit base | TBD |

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
  lm_head precision are **exonerated**; the flip lives in the **4-bit
  experts** (the FFN bulk — unfixable by any small overlay; higher-precision
  experts, i.e. an 8-bit base, is the smallest structural fix). The fetched
  bf16 routers/lm_head validated against the base at 8-bit/4-bit quant-noise
  levels (relerr ~1 % / ~9.5 %), same revision.

### Lane comparison — plain fuse-into-4bit (r3/r4 lane)

The tensor-level probe (script header) shows plain fuse keeps only ~17 % of
‖Δ‖ in-grid, yet the behavioral signature probe matches 4bit-hd on the flip
family. Full-surface reads were run on 4bit-hd only; the fused lane served as
the construction-bug control.

### 8-bit

TBD (mlx-community 8-bit base download in progress; overlay build + reads
follow the identical procedure).

## Recommendation

**Interim (8-bit leg pending):** no measured artifact clears BOTH bars yet.

- **4bit-hd**: latency ✓ (1.67 s warm median), quality ✗ — one behavior
  (`add_note` population) collapses to a base prior, sinking §C to 0.767
  (< the 0.875 cloud reference, so the "beats frozen-eval-v2" invariant
  fails) and breaking one §P9 floor family. Everything else ≥ bf16.
- **8-bit-hd**: the smallest structural fix for the flip (higher-precision
  experts); decode is ~2× more memory-bound, so the < 2 s median is at risk —
  measured read pending.

**The durable lesson is train/serve precision matching.** r3 — trained
QLoRA-style ON the 4-bit MLX base — held §C 0.960 when served fused-4-bit;
r5 — trained bf16 on CUDA — loses exactly the near-base-prior behaviors when
its base is quantized under it. §P9's registered caveat 3 anticipated this.
If the owner wants the 4-bit latency point with r5-level quality, the clean
path is an r6 trained against the 4-bit base (the §P8 local recipe), not more
serving-side patching.

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
