# Training program — Stage 0 execution record (2026-07-03)

*Executes `docs/plans/MOSHI_TRAINING_PROGRAM_2026-07.md` Stage 0 (measure) + the
Days-3–4 tooling builds at smoke scale, per the owner's adoption-day scope
decision. ⛳ gate readings are recorded against the spec text as written,
including where reality diverged from the spec's stale numbers.*

## S0.1 — Reward re-benchmark (the Day-1 hour) ✅

`scripts/verify-hardware/bench_evaluators.py --validity` →
[`REWARD_BENCH_2026-07.md`](REWARD_BENCH_2026-07.md) + `~/mosh-beats/labels/reward-bench-2026-07.json`.
Pre-registered metric (Spearman, one-sided, no post-hoc binarization) stated in
the doc above the results. Byte-identical across re-runs (CLAP embeddings pinned;
pre-pin GPU jitter was ρ ±0.03 with unchanged signs).

Headlines:
- **Composite (GRPO reward, as implemented): ρ 0.097 / 0.065** on the two sets —
  no owner-taste signal; the audit's retirement verdict is **confirmed by fresh
  computation** and is not retested again.
- **No scorer beats the ranker on both sets** except Audiobox **PC** (complexity:
  0.199 / 0.675) — recorded as a candidate ranker *feature* to check at the next
  era boundary (it is already an input axis), not as a scorer adoption.
- CLAP anchors dominate validity-24 (ρ ≈ 0.78) but **flip negative** on probe-38
  (−0.41): they detect "sounds like a finished trap beat", which separates the
  broken-render-heavy validity set but anti-correlates once everything sounds
  like a beat. Set-dependence noted; no adoption.
- The ranker is the only scorer significantly positive on probe-38 (ρ 0.453,
  p 0.002) and goes negative on validity-24 (−0.165) — its features were learned
  on factory beats, and validity-24 is GRPO-render material. The standing bar
  (beat the ranker on BOTH sets + prequential ≥0.65) remains unmet by everything.
- LoRA-MuQ: by record only (checkpoint unrecoverable; validity ρ −0.129 stands).
  CLAP→owner-corpus centroid: not computable — `~/mosh-taste/own` still empty.

## S0.2 — v3-final score provenance ✅ (no re-run needed)

The spec said "the retrain exists but is unscored [GT §B7]" — **stale**:
`docs/bench/STAGE0_RESULTS.md` (2026-07-01/02) records fused **v3-final = 0.558**
on the frozen 300-case subsample under the pinned stack (mlx_lm 0.31.3,
`HF_HUB_OFFLINE=1`, model by PATH), against base 0.714 / cloud 0.875 / v2 0.218,
with the pre-committed gate applied (0.558 < 0.714 ⇒ does not ship).
`service/sft/.adapters/v3-final/sft_run.json` carries config + dataset sha +
mlx_lm version. Provenance complete; recorded, not re-run.

Serving-setup validation this session: base-4B plain re-run on the same frozen
subsample = **0.710** (vs recorded 0.714 — single-run noise), so the arms below
are comparable to the recorded ledger.

## S0.3 — ⛳ Substrate gate: few-shot A3B vs 4B (frozen 300, same rules) ✅ GATE FIRES → A3B

Pre-registered before the run (adoption-day plan): the comparison is
**A3B few-shot vs base-4B few-shot**, both `--n 300 --rules examples` on
`service/sft/.sft-data/v3/test.eval.jsonl`, AND the spec's literal comparator
("tuned-4B, 0.6192-class" — in reality fused v3-final 0.558) is also recorded.
Few-shot = `RULES_WITH_EXAMPLES` via the new `eval-sft --rules examples` flag
(byte-identical to the Moshi-Bench lever).

| arm | clean-apply | deferrals | serving config |
|---|---|---|---|
| base-4B plain (anchor) | **0.710** | 35 | pinned id, temp 0 |
| base-4B few-shot | **0.717** | 8 | pinned id, temp 0 |
| **A3B few-shot (18 GB abliterated, lab-only)** | **0.826** | **0** | pinned by PATH, temp 0, `--no-think` (`chat_template_kwargs.enable_thinking=false` — the checkpoint is a thinking model; the 4B-Instruct arms have no thinking to disable, prompts byte-identical across arms) |

**⛳ GATE READING: A3B few-shot 0.826 ≥ 4B few-shot 0.717 (and ≥ the spec's
literal "tuned-4B 0.6192-class" comparator, real value 0.558) → the Stage-2
substrate is clean Apache-2.0 Qwen3-30B-A3B.** +10.9 points over the best 4B
few-shot arm, zero deferrals, and within 4.9 points of the cloud brain's 0.875 —
before any fine-tune. Reference ladder on this frozen subsample now reads:
cloud 0.875 > **A3B few-shot 0.826** > 4B few-shot 0.717 > 4B plain 0.710/0.714
> v3-final 0.558 > v2 0.218.

Consequences: Stage 2 fetches the CLEAN Apache-2.0 Qwen3-30B-A3B checkpoint
(the abliterated copy was measurement-only and per spec §8 is now
quarantine/delete-eligible — owner call); LoRA on 30B-A3B under 64 GB is the
"tight-but-plausible" case flagged in [GT §D16], so Stage-2 planning should
budget a fallback to the CUDA box if MLX LoRA memory doesn't close.

Serving-trap incident (recorded for the provenance rule): the first A3B arm was
caught evaluating the **4B base** — `mlx_lm.server --model <path>` also lists the
HF-cached models in `/v1/models` and the harness took `data[0]`. Killed mid-run,
its partial result (0.584) **discarded and deleted**. The pipeline now pins the
request id to the model PATH and runs a one-token identity probe before any eval
— the third occurrence of this trap class (0.889 Huihui, 0.619 base-mislabel,
now this), so the identity probe is permanent harness behavior.

Disposition of the abliterated checkpoint after measurement (spec §8): flagged,
left in place pending the owner's quarantine/delete call — it never ships.

## S0.4 — Probe-v2: the honest grounded baseline ✅

The v1 probe (10/8/5-of-23) is now **diagnosed as a harness artifact in full**:
its prompts said `tracks: (none)`, its intents referenced training-set track
names, and execution ran against a third unrelated session — prompts, intents,
and execution were mutually incoherent.

Probe-v2 = `ui/scripts/policyProbe.mts` (`npm run policy-probe`): ONE
deterministic live session via `--run-script`; the prompt is
`buildSystemPrompt(DEFAULT_RULES, <live __snapshot>)` — byte-identical to
serving AND to training rows; grading = catalog → session-id grounding →
file-existence → REAL engine apply (`ui/scripts/lib/groundedApply.mts`; random-id
entities resolved via single-invocation `${VAR}` captures). Two arms:
**grounded-30** (24 groundable intents + 6 negatives where deferring is correct)
and **prior-30** (the v1 intents verbatim — negative-handling at scale).

Results (reports in `~/mosh-bench-artifacts/policy-probe-v2/`):

| model (arm) | grounded: clean | negatives: defer-ok | wrong-defer | failure classes |
|---|---|---|---|---|
| base-4B + examples (the shipping config) | **23/24** | **6/6** | 0 | 1 invented-file (sketch intent → `sketch_beatbox` with a made-up WAV) |
| fused v3-final (plain rules) | 19/24 | 6/6 | 4 | 1 validation |
| — prior-30 replay, both models | 1/1 groundable | ~14–15/29 | ~14–15 | few stale-id/apply-error/invented-file |

Readings:
- **The v1 probe's headline failure modes were harness artifacts.** With the
  serving prompt carrying the live snapshot, stale-session-ids drop to ZERO on
  grounded intents for both models (v1 claimed ×16).
- **The honest grounded clean-apply baseline for the shipping local config is
  ~96%** (23/24) with perfect negative handling on this set.
- v3-final's misses are NOT grounding: all four wrong-defers are the documented
  mode-interpolation pathology — *claims the edit, emits no command* ("Tempo now
  150 BPM! 🎵"). The honest harness reproduces exactly the defect class that
  failed its ship gate.
- The prior-30 replay (intents referencing absent tracks) shows the real
  remaining gap for BOTH models: ~half the time they act on some other track
  instead of deferring — precisely the Stage-1.4 grounding-negatives data need.

## S0.5 — CUDA box: PENDING (owner)

`nvidia-smi` must run on the Windows box — owner ask. Decides the Stage-3 DPO
toolchain (trl+peft if VRAM ≥ 16 GB, else hand-rolled MLX DPO).

## Days 3–4 tooling (built + smoked; bulk runs NOT this cycle)

1. **Execution-filtered synthesis driver** — `ui/scripts/synthesizeDriver.mts`
   (`npm run synthesize`): propose per-command user requests (cloud task-gen) →
   answer through the serving prompt → grade via groundedApply → keep ONLY
   clean-apply on-target rows as `{messages:[system,user,assistant]}` chat-JSONL
   (each row snapshot-grounded by construction — Stage 1.4). **Smoke: 4 commands
   × 5 proposals → 20/20 kept**, ~49k prompt tokens (≈ $0.03).
   Found + fixed in the build: OpenAI `json_object` needs the literal word
   "json" in the prompt; section/annotation ids are random per engine invocation
   → the `${VAR}` capture remap above.
2. **Real back-translation kit** — `Backtranslator` gains a style axis
   (`BT_STYLES`: terse-slang / plain / verbose-beginner; one call per style per
   shape), `buildSft --bt-styles`. **Smoke: 8 shapes × 3 styles = 24 real brain
   calls → 26.8 mean phrasings/shape (target ≥25)**, genuinely register-spread
   ("kill {0}" ↔ "Would you mind muting the {0} track for me?").
3. **Defect sibling audit (Stage 1.2)** — the unfaithful relative→absolute
   pairing class is **gone everywhere** (v3-final fixed volume; pan/tempo
   utterances were already faithful-absolute). The remaining gap was *coverage*:
   no TRUE relative tasks for pan/tempo. Added `RELATIVE_PAN_MOVES` (touch=10%,
   bit=15%, by-N%=N) + `RELATIVE_TEMPO_MOVES` (touch=2, bit=5, by-N=N) to
   `sliceProgramFull`, range-guarded (never teach a clamped delta), with goldens.
   Clip gain: no agent-callable clip-gain command exists — nothing to audit.

## Spend ledger (this session)

| item | calls | est. cost |
|---|---|---|
| BT style smoke | 24 | < $0.05 |
| synthesis driver smokes (×3 incl. failed runs) | ~72 | ≈ $0.10 |
| **total cloud** | | **≈ $0.15** |

Local MLX/judges compute: $0. No training runs started; no training data,
checkpoints, or configs modified (new files + smoke outputs only); era-001
untouched.
