# Moshi Training Program — Unified Spec (2026-07)

> **Adoption header (2026-07-03).** Status: **ADOPTED** (was PROPOSED — delivered by the owner from the external planning session on 2026-07-03 and adopted verbatim; the body below is unedited). Inputs: [GT] = `docs/CURRENT_STATUS_AND_CONTEXT.md` (2026-07-02), [R] = the 2026-07 external practitioner research report, [A] = `docs/plans/moshi-training-audit-2026-07.md`. The ⛳ gates herein are the pre-registrations of record. Owner scope decisions taken at adoption: ratings watcher **install approved**; this cycle executes **Stage 0 + builds the Days 3–4 tooling at smoke scale** — the $45–90 bulk token spend waits until the Stage-0 numbers are seen. Execution record: `docs/bench/PROGRAM_STAGE0_2026-07.md`.

Status: PROPOSED. Pre-registered gates are marked ⛳ and must be stated before their run; they do not move after results are seen. Inputs: `docs/CURRENT_STATUS_AND_CONTEXT.md` (2026-07-02, ground truth — cited as [GT]); the 2026-07 external practitioner research report, Parts A/B [R]; standing audit rulings in `docs/plans/moshi-training-audit-2026-07.md` [A]. Supersedes: the SFT→GRPO program shape as the training strategy. Does not supersede: the Long Pass pre-registrations (`docs/bench/RANKER_PROMOTION.md`, `docs/plans/STAGE2_GATE.md`) — adopted unchanged — or the audit's serving ruling (cloud gpt-5.4-mini KEEP). Written for: any future agent session picking this up cold. Read [GT] first.

## 1. Verdict

The program is two lanes on one spine. Lane 1 (Taste) is the Long Pass — beat factory → owner-rated packs → embedding store → advisory ranker → era mechanics — and it is already the correct implementation of the research recommendation's reward philosophy, at the layer where reward variance actually exists. Lane 2 (Agent) is the LLM command-emission track, whose failure is now diagnosed as data defects (coverage, fake back-translation, grounding) rather than capability ceiling, and whose fix is token-funded data work followed by retrain, best-of-n serving for taste-relevant actions, and DPO only behind the pre-registered Stage-2 gate. GRPO stays frozen with explicit resurrection conditions. The cloud brain keeps serving; the local model is the autonomy/distillation track.

## 2. Why the incumbent RL program failed (settled)

* Advantage collapse on both rungs. Rung-1 symbolic reward saturated at 1.0 (identical within-group rewards ⇒ zero advantage); the Rung-2 audio smoke returned exactly 0.0 (also uniform ⇒ collapsed) [GT §A2–A3]. No runtime logs survive; the recorded outcomes are sufficient for this verdict.
* The reward was invalid as an optimization target. Composite vs. owner blind ratings ρ≈0.007; the pull (taste) component anti-correlated at −0.129 [GT §A4]. Optimizing it harder would have optimized noise.
* The mismatch is structural. Micro command-deltas produce imperceptible audio deltas, so groups of nearby policies earn near-identical reward [R diagnosis, confirmed by GT]. The Long Pass fixes this by moving variation to whole candidates (72-beat grids), where deltas are audible by construction.

Consequence: PR #176 never merges. Resurrection conditions in §8.

## 3. Program shape

```
            OWNER LABELS (packs, top picks, validity sets)  ← the only taste currency
                     │
     ┌───────────────┴────────────────┐
     ▼                                ▼
 LANE 1 — TASTE                  LANE 2 — AGENT
 beat factory → packs →          SFT data repair → retrain →
 ranker (advisory→adopted)       best-of-n serving → DPO (⛳gated)
 era freezes, prequential        cloud serves / local trains
     │                                │
     └───────► SHARED SCORER SEAM ◄───┘
               ranker score_candidate  +  verifiable checks (clean-apply,
               constraint satisfaction, measured-feature direction)
```

Shared invariants (the spine): the owner-label ledger is the single taste currency; the ranker's `score_candidate` is the one scorer seam both lanes call; MoshOps remains the only mutation path; era-freeze discipline applies to anything that consumes labels; the two owner-labeled validity sets (24-clip pack, mean 2.88/6; 38-clip probe, mean 4.21/7 [GT §F20]) are the reward benchmark of record — no model is used as a scorer again without beating the current ranker on them.

## 4. Lane 1 — Taste (protect and feed)

1. Do not touch generation code inside an open era. Era-001 (packs 006–009) stays frozen at `~/mosh-eras/era-001` @ fc36d97c. Feature/ranker iteration happens only at era boundaries.
2. Labels: 84 → ⛳300 (the STAGE2_GATE threshold). At ~18 gradable rows/pack, that is ~12 packs ≈ 12 owner-days at ~10 min/day. Install the ratings watcher (written, pending owner go-ahead [GT §F20]) so pack N+1 builds automatically on rating pack N.
3. Ranker discipline: adoption bar stays prequential ≥0.65; current trajectory 0.5714 → 0.6458 across the era boundary is the right direction. ⛳ If prequential falls below 0.55 for two consecutive packs, the feature set is wrong — revisit at the next era boundary, not mid-era.
4. Reward re-benchmark (Day-1 item, ~1 hour): score composite, LoRA-MuQ, Audiobox axes, CLAP, and the ranker against both owner-labeled validity sets with the existing bench harness. Publish to `docs/bench/`. This retires or rehabilitates every legacy reward artifact in one pass.
5. Licensing posture: MuQ (CC-BY-NC) is an internal judge only; nothing NC ever ships in the product. Same for the IRCAM RAVE checkpoints (product posture stays "user supplies their own models").

## 5. Lane 2 — Agent (fluency + grounding)

Capability order: grounded corrective/instructed editing first; from-scratch generation stays in Lane 1 [R Q1; GT §B8 supports — the model can already act syntactically, it fails on grounding and content].

### Stage 0 — Measure (2–3 days)

1. Eval `v3-final` on the frozen 300-id subsample (~30 min) — the retrain exists but is unscored [GT §B7].
2. Fix the probe harness to mirror serving: inject the live snapshot into the prompt; add a file-existence validator. Re-run the 30-generation probe → the honest grounded clean-apply baseline. (The current 10/8/5 split is partly a harness artifact [GT §B8].)
3. Substrate fork, resolved empirically: few-shot the on-disk 18 GB A3B-class 4-bit checkpoint (lab-only weights — abliterated provenance, never product) on the same subsample. ⛳ If few-shot A3B ≥ tuned-4B (0.6192-class), Stage-2 substrate becomes clean Apache-2.0 Qwen3-30B-A3B; else stay Qwen3-4B. 64 GB unified memory makes inference comfortable and LoRA tight-but-plausible [GT §D16].
4. Run the §4.4 reward re-benchmark.
5. `nvidia-smi` on the CUDA box → records VRAM, which decides the Stage-3 DPO toolchain.

### Stage 1 — Data repair (~2 weeks, token-funded)

1. Real back-translation. The corpus's BT is 4 cached template shapes with `brainCalls: 0` [GT §C10]. Replace with actual brain calls: target ≥25 distinct paraphrase shapes per command, style-varied (terse producer-speak ↔ verbose beginner). ~30–60k calls at the recorded ~$0.0015/turn ≈ $45–90. The audit's own 0.42→0.62 lift from ~10 real calls is the prior; ⛳ if real BT at scale lifts the frozen eval <2 points, diversity was not the binding constraint — shift the remaining budget entirely to coverage and grounding.
2. Defect repair. Fix the `set_track_volume` mapping ("up a little" → `db=0` on 420/708 rows [GT §B7]) and audit siblings (pan, clip gain, tempo relatives) for the same relative-instruction→zero-delta bug class.
3. Coverage via execution-filtered synthesis. Build the ~1-day glue driver [GT §E18]: propose N command-sequences per prompt (cloud brain) → replay through `Mosh --run-script` → keep clean-apply only → write back to chat-JSONL. ⛳ Target: all 78 agent-callable commands at ≥50 examples each, with caps preventing add_note-style skew (current 19,780 add_note rows get downsampled to a cap).
4. Grounding data. Every training row carries the live snapshot it was generated against; include negatives that reference nonexistent ids/files with the correct refusal/correction behavior. This targets the observed failure mode directly (stale ids ×16, invented audio files ×3 [GT §B8]).
5. Consent stays load-bearing. Trajectory harvest remains OFF until a consent=true flow ships; the 96-row recorder file (consent=false) is not training data [GT §C13].
6. Frozen-eval-v2: build and ⛳ pre-register an expanded eval (per-command floors across the 78, grounded-execution section) before any Stage-2 training run touches it.

### Stage 2 — Train + serve (weeks 3–4)

1. Retrain on the Stage-0 substrate over the repaired corpus. ⛳ Exit gate: ≥0.75 on frozen-eval-v2 (closing half the 0.6192→0.8754 gap), per-command floor ≥0.5 across the 78, and grounded clean-apply ≥85% on the fixed harness.
2. RFT loop: iterate the Stage-1 driver against the new checkpoint (sample → clean-apply filter → SFT), two rounds; ⛳ stop when a round lifts eval <1 point.
3. Best-of-n serving path (currently absent [GT §E18]): build candidate generation + ranking on `brain_client` with the shared scorer seam, behind a flag. Policy: corrective ops = single-shot + validator-retry (latency-bound); taste-relevant generative ops (populate, re-imagine parameters, arrangement) = best-of-4→8, scored by verifiable checks plus the ranker where audio is the point. Measured budget: ~25 s / ~$0.012 for cloud best-of-8; ~80–90 s local [GT §D17].
4. Archive every chosen/rejected candidate pair. This is the DPO fuel and costs nothing extra.

### Stage 3 — Preference optimization (gated)

* ⛳ STAGE2_GATE unchanged: ≥300 owner labels AND ranker rung ≥1 before any DPO pilot.
* Toolchain: `mlx-lm` 0.31.3 has no DPO [GT §E18]. Decision by Stage-0 item 5: trl+peft on the CUDA box if VRAM ≥16 GB; else hand-rolled MLX DPO reusing the per-token logprob code already written on the PR #176 branch.
* First DPO run trains on the Stage-2 archived pairs, evaluated on frozen-eval-v2 plus a 20-item blind owner A/B (single-shot vs. DPO output).

## 6. Data fronts, ranked

1. Execution-filtered synthesis + real BT — token spend, fastest capability per dollar, falsifies quickly.
2. Owner catalog recipes (~460 of 542 already [GT §C11]) + the `~/mosh-taste/projects/` drop folder — the fidelity backbone. Merge PR #197 (r7 promotion, +18 recipes) after normal checks.
3. Owner labels (Lane 1 packs) — the only taste currency; rate-limited by the owner's 10 min/day, which is why the watcher matters.
4. Trajectory harvest — currently zero ever; build the consent UX properly rather than faking volume.
5. YouTube teardown mining — stays dead. The scout queue's 13 orphaned jobs get deleted or the missing stage gets built later; the Recipe schema + compiler live on as importer infrastructure. No new spend here this cycle.

## 7. 30-day spend

* API tokens: $150–400 (real BT $45–90; synthesis proposals + curation/judging passes the rest). This is the program's engine, consistent with the standing token-over-GPU learning.
* Burst CUDA: $0–150, only if the Stage-3 DPO pilot lands on the box and its GPU is insufficient (unlikely — resolve at Stage 0).
* Hardware: $0. 64 GB M1 Max covers everything specced, including 30B-A3B inference.
* $99 Apple Developer cert — not training, same wallet; unblocks the already-built notarization pipeline.

## 8. Risks & falsifiers

* Real BT lift <2 eval points → diversity wasn't binding; budget shifts to coverage/grounding (⛳ §5 Stage 1.1).
* A3B few-shot ≤ tuned 4B → substrate stays 4B; revisit only on new hardware (⛳ §5 Stage 0.3).
* Ranker prequential <0.55 for two consecutive packs → feature revisit at era boundary (⛳ §4.3).
* Best-of-n fails the owner blind A/B (picks preferred ≤50% vs. single-shot over 20 items) → the scorer seam is invalid for that action class; halt DPO-pair harvest from it (⛳ §5 Stage 2).
* Label rate collapses (<8/week) → Stage-3 slips; fix pack size or rating UX, never the gate.
* GRPO resurrection conditions (both required): ⛳ RFT sampling stats show ≥30% of candidate groups contain nonzero reward variance under a scorer that has beaten the ranker on the validity sets. Until then, frozen means frozen.
* Licensing (product-side, independent of training): resolve the SA3 weights license from the download source before any public build; the abliterated checkpoint never ships and is deleted or quarantined once Stage-0.3 concludes.

## 9. Invariants

MoshOps is the only mutation path · era freezes are respected · consent gates all usage harvest · NC-licensed weights never ship · pre-registered gates never move after results · the cloud brain remains the serving default until a local checkpoint beats it on frozen-eval-v2 and serves at <2 s median (current local median 8.3 s [GT §B8]).

## 10. First two weeks, sequenced

* Day 1: reward re-benchmark vs. both validity sets (~1 h); `v3-final` eval (~30 min); `nvidia-smi` on the box; owner go-ahead → install ratings watcher.
* Day 2: fix probe harness (live snapshot + file-existence); re-run probe for the honest baseline; A3B few-shot eval; record the substrate decision.
* Days 3–4: synthesis-driver glue; real-BT prompt kit; defect-repair PR (volume mapping + siblings).
* Days 5–10: run the data fronts to the coverage targets; build and pre-register frozen-eval-v2; packs continue nightly.
* Days 11–14: Stage-2 retrain + eval against the gate; best-of-n serving skeleton behind a flag; begin archiving preference pairs.
* Throughout: one rated pack per owner-day (84 → 300 is the Stage-3 clock).

Highest-information experiment in the whole plan: Day 1's reward re-benchmark — one hour that either retires or rehabilitates every reward artifact the program has ever produced, and sets the bar every future scorer must clear.
