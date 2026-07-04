# Moshi Training Program Audit — 2026-07

*Clean-slate review of the entire Moshi training program: policy, RL, reward model, data supply, compute posture. Evidence pass: 11 parallel read-only investigators over docs / training stack / worktrees / artifacts (all numbers below re-verified from primary artifacts this session, not quoted from memory notes), plus a 3-critic adversarial review of the draft verdict. Written 2026-07-01. Session was read/analyze only; this document is the sole mutation.*

---

## 1. Verdict

The incumbent program is the right **substrate** and the wrong **learning stack** — and the stack wasn't just under-executed, it was run in the wrong order on every axis the evidence exposes. RL ran before reward validity (GRPO's audio smoke earned reward **exactly 0.0**, and the reward it was chasing was later measured at **ρ≈0.007** against the owner's blind ratings — the pull component *anti*-correlated at −0.129, ranking the owner's own beats lowest). Learned taste ran before a single human label existed (the one validity instrument that was built — the 24-clip blind pack — has still never been rated). Local model replacement ran before any eval could say what it was replacing (the honest 0.619-vs-0.875 gap decomposes into ~¾ fixable data/calibration artifacts and ¼ genuine content gap, on an eval too narrow to diagnose itself). And generation-by-optimization ran before the system had ever seen a real beat — GEPA drove the rules-verifier score 0.79→0.97 while the music got worse, the now-canonical Goodhart result. The 2026-06-30 restart already corrected the generation half (retrieval over real motifs; RL frozen; verifier demoted to a validity gate). **This audit ratifies that correction and applies the same inversion to the whole training program:**

- **Evals with an audible axis first.** Nothing currently measures what a producer would respect; every automated proxy tested against the owner's ear has failed.
- **Frontier brain + model-agnostic scaffolding now** — the two levers with measured causal lift (worked examples +30pp; harness-owned slot-fill 9/9 audible where free-form failed for local *and* frontier) — with the **local model run as a parallel measurement column from week 1**, not parked to a hypothetical Stage 2.
- **Demonstrations at scale** from the importers (the program's crown jewel: 100% clean-apply, exact note fidelity) plus the live-harvest flywheel, which is built, tested, and — the single most damning finding of this audit — **has never captured one real datum** (0 `turn_id` markers across all 770 session logs).
- **Verifiable execution checks as filters and evals — never as policy gradients.** GRPO stays frozen. When preference optimization returns, it returns as DPO/rejection-sampling on owner labels, exactly as the unanimous 5-model panel prescribed.
- **Owner preference labels before any learned taste.** The MuQ head stays frozen as a candidate feature until the already-built validity pack is rated.
- **Distillation is contingent, not scheduled** — gated on a hardened bench-parity result *and* an explicit product reason (offline / privacy / the bundled-key exposure, which this audit registers as a pre-distribution ship-blocker).

**First capability bought: grounded corrective editing on real sessions**, gated by a pre-registered blind A/B — one recorded session, the owner dictates 10 corrective asks, incumbent single-shot brain vs. the new scaffolded brain side by side, blind; the new brain must win ≥7/10. That is the "producer doesn't cringe" demo made falsifiable. The generation lane (the owner's actual dream, whose own Gate C just measured *distinct but not keepable* — would_keep 2.17 vs 2.83) runs first-class in parallel under the restart thread's existing ownership, with this program contributing gates, specs, and one of the owner's scarce listening sessions.

Answering the brief's questions directly:

1. **Target:** corrective editing first — it's where *training* (vs. retrieval engineering) buys capability, it's the half of the mission a producer touches fifty times a session, and it's the only lane that generates the live preference data everything downstream needs. Generation is not demoted; it's already being solved by a different, correct mechanism (retrieval + recombination) with its own gates. Minimal demo: the blind 10-ask session above, plus one from-nothing generation ask served by the slot-fill tooling.
2. **Policy substrate:** frontier (gpt-5.4-mini: 18/19 on the bench, ~1.0s, ~$0.0015/turn) serves; local measures alongside from day one. Not because local is dead — the decomposition says a fixed-data 4B plausibly reaches ~0.86 — but because the serving decision should be made by an execute-graded bench, not by hope. The week-1 experiment (pinned-tokenizer re-eval) settles whether the tantalizing 0.889 was real or the known serving artifact.
3. **Learning signal:** SFT→GRPO was the wrong stack *as ordered*. The near-zero reward decomposes into all three failure modes at once: the policy couldn't act (75–85% deferrals), the reward couldn't see (binary clean gate zeroed valid renders; pull invalid), and the task was misspecified (free-form generation inside a template box). Right stack: demonstrations → verifiable filtering → expert iteration from the frontier through the verifier → owner-label DPO, in that order, each gated.
4. **Reward strategy:** verifiable-first, and honestly labeled — the parse→catalog→args→clean-apply→snapshot-assertion→render-features ladder is an **execution/renderability filter**, the axis measured to carry zero taste signal. It filters garbage and grades evals; it never becomes an optimization target for taste. Taste enters only as owner labels.
5. **Data:** importers + back-translation ≥ frontier-generated verified trajectories > live harvest (switch it ON; low volume, unique labels) > teardown recipes (retrieval library for the generation lane, not policy training data — the r7 corpus is rights-flagged `training_eligible=false` and metadata-corrupted). Video mining: parked on measurement, with one scoped open question kept alive.
6. **Curriculum:** single-command (solved) → multi-command single-turn (add_note population, the measured gap) → multi-step corrective with observation (the validated-slot loop) → full-song. Each rung gated by the bench + owner ears.
7. **Spend:** ≈$500 in tokens over 30 days, $0–20 GPU — the standing token-spend-over-GPU conclusion holds. The binding resource is not money: it is **owner listening time**, and the program below budgets it explicitly.

---

## 2. Keep / Kill / Change

| Component | Verdict | Rationale / switching cost |
|---|---|---|
| MoshOps seam + JSONL log + snapshot/events as training substrate | **KEEP** | Proven in production; 173 commands, 78 agent-exposed; turn provenance (`turn_id`/utterance on `batch_begin`) achieved with zero C++. |
| Importers (RPP/ALS/FLP → moshIR → replay) | **KEEP — promote to primary data engine** | 100% clean-apply, exact note counts (1046/1046, 5575/5575, 1404/1404…). Already emits training pairs via `sliceProgramFull`. |
| Replay verifier + conformance harness | **KEEP — becomes the bench's execution layer** | Real headless engine, ~10s, deterministic, read-only `__snapshot`; id-remap already solved by the RL host. |
| Live harvest (`ui/src/harvest/`) | **KEEP — but it must be switched ON** | Built and tested; zero real tuples ever. 2-day time-boxed fix with a week-1 "one real turn through the deployed bundle" gate and a kill criterion. |
| Frontier brain (gpt-5.4-mini via BrainProxy) | **KEEP as serving brain** | 0.875 vs 0.619 honest; ~1s; ~$0.0015/turn. Subject to continuous two-column measurement. |
| brainBench (19 cases) | **KEEP — grow into Moshi-Bench** | Right scorer design (deterministic, invented-id rejection); wrong substrate (mock fixture, text-graded, never executes). |
| Restart recipes lane (retrieval generation) | **KEEP — first-class parallel lane** | Gate B passed; Gate C mixed (won distinctiveness 4.17 vs 3.33, lost would_keep 2.17 vs 2.83). Needs the r8 corpus (below). Owned by the existing restart/Codex thread; this program contributes gates + specs, not duplicate engineering. |
| LoRA-MuQ reward head | **KEEP FROZEN as candidate feature** | The one robust learned-reward positive (iso-timing 0.897 vs CLAP 0.545, artifact-controlled 0.911) — but scoped to ablation ordering, not taste. Unfreezes only if the rated validity pack says the axis matters. |
| Back-translation (`backtranslate.ts`) | **KEEP** | Shape-cached, ~10 brain calls per corpus; balancing lifted 0.42→0.62. Fix the eval-contamination exposure (freeze disjoint eval shapes). |
| **GRPO as active path (PR #176)** | **KILL (ratify the freeze)** | Reward exactly 0.0; symbolic rung saturated at 1.0; renderability-dominated gradient; no completed run; owner already froze it. Switching cost ~0 — code parked, seam (`MOSH_RL_REWARD`) preserved. Preference optimization returns as DPO on owner labels, never GRPO-against-a-rubric. |
| **GEPA against taste rubrics** | **KILL (already banned — ratify)** | Goodhart measured twice (0.788→0.966; 0.869→0.992, music worse). GEPA on the brain prompt is also done: baseline hit ~1.0 after the id-quoting fix. |
| **Local Qwen3-4B as near-term serving brain** | **KILL as default; keep as measurement column** | Honest 0.619. Switching cost ~0 (env-var swap both directions). The autotrain pipeline is kept as the distillation lane; note `autotrain.sh`'s serve step still lacks `HF_HUB_OFFLINE=1` — the inflated-score trap is one unattended re-run away. |
| **Video teardown as near-term data source** | **KILL / park** | Measured on the dead branch: synth-param recall ≈0 after the never-mislabel gate, screen-MIDI pitch-class-only; zero recipes ever mined from any video; the mining stages don't even exist on main; the recovered scout catalog is 100% Serum/Vital-targeted (0 "ideal" candidates for trap). Cost of killing: 13 queued jobs stay queued. One scoped open question survives (§6.7). |
| **Monster eval CSV as-is** | **KILL as-is; salvage** | 150 rows = 20 unique prompts in an abstract vocabulary (SET_TRACK_GAIN, SUBMIT_MIX) that no code consumes; ~10 of 16 labels map to real commands and get reworked into bench cases; the arena labels don't. |
| SFT lane's *mission* | **CHANGE**: "replace the cloud brain" → "corpus factory + continuously-measured distillation option" | The 0.62 headline was ~¾ artifacts. Fix the two named data defects (HUH-slice deferral calibration; relative-utterance/absolute-gold volume rows), retrain, and measure — week 1, not week 7. |
| Reward strategy | **CHANGE**: model-first → verifiable-filter ladder + owner-label taste | The ladder filters and grades; it is never a taste target. Every proxy gate pairs with owner ears. |
| Agent loop | **CHANGE**: single-shot → validated-slot loops | The 9/9 result is the strongest causal finding in the record. Applied to corrective (repair via ≤2 validated retries) *and* productized as generation tooling (recipes as structure source). |
| Evidence practice | **CHANGE**: results live in committed annexes, not gitignored dirs of dirty worktrees | See §5 — the program's empirical record is currently one `git gc` / worktree-cleanup away from partial destruction, and the only on-disk numbers that look good (0.889/0.893) are known-invalid. |

---

## 3. The Program

### Stage 0 — Instruments before opinions (weeks 1–2, ~$60 API, owner time: one 45-min session)

**Objective:** the program can measure what it claims to improve, and its evidence base stops rotting.

- **Irreversibles chore (≤2 hours, immediately):** `git tag` the dangling PR #10 head (433e5e28) and fetch `refs/pull/10/head`; snapshot-branch the gitignored artifacts (funny-mendel `.sft-data`/`.adapters`, sleepy-euler `composite_reward.pt`/`reward_head.json`/the only built 2,469-item palette); quarantine/annotate the poisonous cp400/cp600 eval files. Doc reconciliation is a nice-to-have, not critical path — this audit restates the numbers with provenance.
- **Owner rates the already-built validity pack** (`~/mosh-validity`, 24 clips, blind page — 45 min). This settles whether the recipeVerifier tracks taste at all, and is a hard precondition for standing up any new synthetic grading scheme.
- **Harvest fix, time-boxed 2 days:** diagnose (deployed bundle predating the turn_id executor is the suspect), redeploy, and gate on **one real turn landing in `tuples.jsonl` through the deployed app**. Kill criterion: <50 organic turns in week 1 → live harvest is dropped from the Stage-2 label plan; labels come from blind packs only.
- **Moshi-Bench v0 (~30 cases):** 10 owner-dictated asks (harvested from the Stage-1 gate prep) + the 24 conformance scenarios, execute-graded against the real engine (`__snapshot` in → agent → run-script → `__snapshot` out), with **direction + tolerance-band grading per command family** (never exact gold — the db=0 defect is the proof case) and a rendered before/after on corrective cases (the audible axis). The execute-glue (id-remap + tolerance policy) is priced as its own week. Bench cases are never authored by the same factory that writes training data.
- **Local-parity experiment (the 0.889 question):** re-run the frozen 300-case eval with the pinned tokenizer under `HF_HUB_OFFLINE=1` — either the 0.889 is real (local is at parity NOW and the serving decision flips early) or it's the artifact (and the decomposition gets corrected). Then fix both data defects, retrain overnight ($0), and run local vs cloud on Moshi-Bench the day it exists. Pre-committed rule: local within 5pp of cloud on the execute-graded bench → local becomes the default runtime brain with cloud fallback.
- **Few-shot retrieval-bank A/B (both columns):** does the +30pp worked-example result transfer to command emission? ~$5.

**Gate:** bench baseline scoreboard exists (cloud + local columns); validity verdict written down; first real tuples on disk or the kill criterion invoked.

### Stage 1 — The corrective brain, and the generation lane's corpus (weeks 3–6, ~$250 API, owner time: two 45-min sessions + Gate C when r8 lands)

**Objective:** a corrective-editing agent a producer prefers blind, and a generation corpus that isn't corrupted or unlicensable.

- **Scaffolded corrective brain:** few-shot retrieval bank of worked examples injected into the prompt; the **validated-slot repair loop** (harness owns structure, ≤2 retries per validated slot — the measured 9/9 pattern, not a weaker "one repair turn") wrapping multi-command edits. Both A/B'd on the bench, both columns.
- **Corrective-pair factory — pilot before scale:** ONE degradation class end-to-end (gain staging), graded by invariant class (direction + bounded magnitude of the snapshot delta) to absorb multiple-valid-fixes; a blind owner spot-check ("is this a real producer ask + a respectable fix?") before manufacturing volume; real harvested asks held out as eval, never trained on. Guard against restore-to-original bias by mixing in real asks as they accrue. Full factory priced at 2–3 weeks if the pilot passes.
- **Slot-fill generation tooling:** productize the beatBuilder pattern as agent-facing tools on the from-nothing path, with recipes as the structure source — the marriage of the two things that measurably work.
- **Generation lane (owned by the restart thread; this program contributes gates + specs):** the **r8 corpus** — re-ingestion with real key/tempo parsing (all 48 r7 recipes carry tempo=140/key=None, which plausibly *caused* the would_keep loss since transposition and retrieval scoring silently no-op over it) from rights-eligible sources; then a **Gate C re-run targeting would_keep ≥ 2.83** (the seed baseline it lost to). `training_eligible=false` material stays out of any training corpus, period.
- **One-week local-brain dogfood window** (cloud fallback intact): generates local-in-the-loop harvest data, smokes the offline story, and feeds the serving decision with real usage instead of synthetic evals.
- **THE GATE (pre-registered, blind):** one recorded session; the owner dictates 10 corrective asks, no substitutions; both brains run them on a real session; owner rates blind side-by-side; **new brain preferred ≥7/10.** This simultaneously baselines the incumbent (if single-shot already wins, the scaffolding failed and we learn it), and its transcript becomes bench cases and the first owner-labeled corrective preference pairs.

### Stage 2 — Distill and taste (weeks 7–12, **contingent**, ~$150 API + $0–20 GPU)

**Starts only if** the Stage-1 blind gate passed **and** a product reason for local is written down (offline studios / snapshot-privacy / the bundled-key exposure — all three are real; see §5).

- **Distillation:** SFT v3 on the scaled, corrected corpus (Mac MLX; one RunPod run ~$20 only if scale demands). The parity gate is hardened against Goodhart round 2: eval cases owner-authored or harvest-derived only (zero factory authorship), a deferral-rate cap, per-command-family floors — the 0.619→0.889 template swing is the standing proof that one headline number is gameable. 4B until the bench says otherwise; don't buy 8B on vibes.
- **Preference optimization:** DPO (never GRPO-against-a-rubric) only if ≥ a few hundred owner labels exist by week 10 via harvest + blind packs; otherwise Stage 2 is SFT-only, no slippage.
- **Default weight** of these weeks shifts toward Gate C iteration and slot-fill generation tooling — consistent with token-spend>GPU and the $0.0015/turn economics; distillation is the option we exercise, not the plan we serve.

---

## 4. First Two Weeks — sequenced, highest information first

1. **(5 min)** Run one agent turn in the deployed `/Applications/Mosh.app`; grep the session log for `turn_id`. This single check decides whether the flywheel fix is a redeploy or a bug hunt.
2. **(45 min, owner)** Rate the validity pack sitting at `~/mosh-validity`. Built 2026-06-30, never rated, $0. The panel's #1 experiment.
3. **(hours, $0)** Pinned-tokenizer re-eval of the local model (`HF_HUB_OFFLINE=1`, correct served id) on the frozen 300-case eval. Rules the 0.889 in or out — either answer redirects the program.
4. **($5)** Few-shot retrieval-bank A/B on the existing eval harness, cloud and local columns. Tests whether the program's biggest measured lever transfers to command emission.
5. **(≤2 hrs)** The irreversibles chore (tags + snapshot branches + artifact quarantine).
6. **(the bulk)** Moshi-Bench v0: 30 cases, execute-graded, tolerance-band policy, audible axis. Baseline both brains.
7. **(overnight, $0)** Defect-fix retrain: rebalanced HUH slice + corrected volume rows; re-eval on the bench.

Week 2 ends with: a bench, two baselines, a validity verdict, a live-or-dead flywheel, and a local model whose true ceiling is measured instead of argued about.

---

## 5. Risks — including ones not raised in the brief

1. **Owner-session scheduling is the top program risk, and it's measured:** the highest-information 45-minute action available (the validity pack) has sat unrated since 2026-06-30. The plan must progress two weeks on zero owner minutes — and it does (items 1, 3–7 above). But every taste gate ultimately queues on one person's ears; if sessions don't happen, the program silently reverts to proxy metrics, which is how the last one failed.
2. **Goodhart round 2.** Clean-apply and snapshot assertions measure executability, the axis proven to carry zero taste signal (ρ +0.007; renderability-dominated gradient; GEPA 0.79→0.97-music-worse). A model that learns conservative, cleanly-applying minimal edits will climb this ladder while producing edits a producer shrugs at. Mitigation is structural: every proxy gate pairs with a blind owner check, and the bench's corrective cases carry rendered before/after audio.
3. **Evidence rot is one cleanup away from destroying the program's empirical record.** The probe RESULTS.md exists only in git history of an unmerged branch; all adapters/eval JSONs live gitignored in one dirty worktree; PR #10's head is unreachable; PR #176 is 13 commits behind its own local branch; the only on-disk local eval numbers that look good are the known-invalid tokenizer artifact. The Stage-0 chore is not housekeeping — it protects the basis of every decision in this document.
4. **The bundled key is a ship-blocker, not a config detail.** A plaintext OpenAI key sits in `Contents/Resources/brain.env` of an app with a working notarized-DMG pipeline. Extraction is trivial; revocation or a spend-cap breach lobotomizes every shipped copy simultaneously (fallback: a regex mock). And the session snapshot transits OpenAI on every turn — track names, structure, and lyric content in lyric flows: unreleased music metadata leaves the machine by default. Before any external distribution: metered proxy with kill-switch, or local-default + BYO-key. This is also the honest product reason the local lane stays warm.
5. **Deployed-bundle drift silently re-kills the harvest.** It plausibly already did — the flywheel's zero-data state may be exactly this failure. The week-1 verified-real-turn gate exists so it can't recur invisibly.
6. **Train/eval contamination.** Back-translated shapes are shared between train and eval sets today (8 shapes total), and Moshi-Bench is being built in the same window as the corrective-pair factory. Rule: bench cases from owner dictation, harvest, and conformance only — never from the factory.
7. **Rights.** The r7 corpus is `training_eligible=false` (tracked-research-only, no proof-of-rights); the arrangement-as-derivative-work question is explicitly unresolved; 5 of 13 DAW-file sources are unlicensed and 1 is NC. Training corpora stay CC-BY MIDI + owner-owned projects + synthetic until that's settled. Commercial licensability is a stated hard constraint — a corpus that can't ship poisons everything trained on it.
8. **Single-rater taste.** Every label comes from one person. That's correct for "sounds like *me*" and fatal for generalization claims. Acceptable for now; flagged so nobody mistakes owner-fit for market-fit later.
9. **Frontier API drift.** All three proxy mirrors treat `/^(gpt-5|gpt-6|o[0-9])/` as reasoning models (max_completion_tokens, no temperature); a model-string change silently shifts latency 6–8× (the recorded Aug-2025 trap). The bench re-baselines on any provider/model change.
10. **Corrective-synthesis restore-to-original bias.** Degradation-inversion pairs teach "undo," not "improve." The pilot's blind spot-check and the held-out real asks are the guard; if the spot-check fails, the factory doesn't scale.

---

## 6. Open Empirical Questions — each with its cheapest resolver

| # | Question | Cheapest experiment | Cost |
|---|---|---|---|
| 1 | Does the recipeVerifier track owner taste at all? | Rate the already-built 24-clip blind pack | 45 min, $0 |
| 2 | Was the local 0.889 real or the tokenizer artifact? | Pinned-tokenizer re-eval, `HF_HUB_OFFLINE=1`, frozen 300-case set | hours, $0 |
| 3 | Is the 4B deferral behavior fixable with data? | Retrain v2 with rebalanced HUH slice + fixed volume rows; re-eval | overnight, $0 |
| 4 | Does worked-example injection lift command emission like knowledge tasks (+30pp)? | Retrieval-bank A/B on the existing harness, both columns | ~$5 |
| 5 | Does a validated-slot repair loop beat single-shot on multi-command tasks? | 100-case A/B, single vs looped | ~$10 |
| 6 | Is add_note weakness (cloud 0.524) a prompting artifact? | Slot-fill-as-tool vs free-form on the bench | ~$10 |
| 7 | Can audio-domain extraction recover just the fields the restart consumes (tempo/key/section/drum-pattern) from tutorial audio — skipping the measured-dead screen-reading? | One-day spike on 3 tutorials from the scout catalog; score field accuracy vs. hand truth | 1 day, ~$5 |
| 8 | What does organic harvest volume actually look like? | One week of normal usage post-fix; count tuples | 1 wk, $0 |
| 9 | Does 8B materially beat 4B once the corpus is fixed? | One RunPod SFT run on the corrected corpus — only after Q3/Q4 land | ~$20 |
| 10 | Does the r7 metadata corruption explain the would_keep loss? | Re-ingest 10 recipes with real key/tempo; regenerate the Gate C pack from those; owner re-rates | 45 min owner + days eng (restart thread) |

---

## 7. Evidence Appendix

### Measured (artifact in hand this session)

- **GRPO runs:** `rl-audio-smoke/rl_results.json` — baseline clean-apply 0.0, step2 reward_mean 0.0; `_work/rewards.jsonl` — 6/6 rollouts at reward 0 (4 deferred; 2 rendered but zeroed by the binary clean gate, feedback `ok pq=1.0,clean=0.0`). Symbolic `rl-smoke` reward_mean 0.5 with baseline already 1.0 (saturated); last rl-v1 batch n=24, mean 0.9167, values ∈ {0,1}. Recipe smokes 0.030/0.010. Biggest rewards log anywhere: 24 rows. *(funny-mendel worktree, gitignored)*
- **Reward validity probe:** ρ(owner rating): composite +0.007, pull −0.129, pq −0.057, clean +0.030; A/B pull 3/10 (below chance); owner gold rated 6.92 with lowest pull 0.527; within-loop inversion (owner 3.21>2.00; reward 0.541<0.586). n=38 clips + 10 A/B; raw data persists at `~/mosh-reward-probe/`. *(RESULTS.md recovered via `git show claude/musing-herschel-c0501d`, commit 733e07cd)*
- **MuQ keystone:** LoRA-MuQ iso-timing 0.897 vs raw CLAP 0.545 (Δ+0.353, CI [+0.253,+0.454]); artifact-controlled 0.911 (CLAP fell to 0.41, raw MuQ to 0.09); timbre: raw MuQ 0.906 > LoRA 0.852 (fine-tuning hurts timbre); the earlier v1 head LOST to CLAP (0.9307 vs 0.9735, training inert) and a CLAP pooling bug invalidated all prior CLAP numbers. *(VERIFY_REAL.md, branch-only)*
- **SFT:** local Qwen3-4B-4bit LoRA 0.6192/57 deferrals vs cloud gpt-5.4-mini 0.8754/18 (byte-identical 300-id subsample, temp 0); cp400/cp600 = 0.8897/0.8935 under model id `Huihui-Qwen3.5-4B-…` (wrong-tokenizer artifact); v1 unbalanced 0.416; per-category: set_track_volume 0.000×16 (14 identical `"db" must be a number` errors; 420/708 train rows pair "up a little" with db=0), add_note 0.383 vs 0.524; deferrals 50 imperative vs 7 question-form, deterministic across runs; train loss 0.04–0.21, val 0.256; v2 = 7,315 rows; corpus = 179,711 MIDI + 606 DAW files on disk. *(funny-mendel `.sft-data`, verified directly)*
- **GEPA:** beat-directive runs 0.788±0.099→0.966±0.067 and 0.869→0.992±0.010 (commits 79f71756, ab14972e) — the restart's "0.79→0.97 while the music stayed bad"; brain-prompt rung baseline hit val 1.000 after the id-quoting fix (PR #97).
- **Restart gates:** Gate B PASS (≥99% event-match, 0 invented rhythms / 12 recombinations; 808 sustains 1.43s). Formal Gate C (owner-scored 18/18 blind, `~/mosh-beats/r7-gate-c-blind/scorecard.csv`): retrieved-adapted distinctiveness 4.17 vs seed 3.33 vs exact 3.00; would_keep 2.17 vs 2.83 vs 1.67; one 5/5.
- **r7 corpus:** 48 local-MIDI recipes + 5 seeds; ALL 48: tempo=140 (evidence `ingest-midi --bpm`), key=None — contradicting bpm/key in their own filenames; all `training_eligible=false`; all mislabeled `reconstruction_class="deterministic"`. *(ClaudeMosh-moshfx + PR #197)*
- **Video mining:** stages absent from main (`git ls-tree`); 13 queued jobs point at a nonexistent `video2recipe` stage; dead-branch measurements: synth-param read 0/6 post-appearance-gate, screen-MIDI pitch-class-only; scout template bank 14/14 Serum/Vital; 0 "ideal" candidates.
- **Harvest:** live log 2,775 lines, 0 `batch_begin`/`turn_id`; 0 hits across all 770 session logs; `tuples.jsonl` never existed; every manifest `tuples: 0`.
- **Runtime brain:** `/Applications/Mosh.app/Contents/Resources/brain.env` = openai/gpt-5.4-mini, plaintext key; single LLM call/turn, history last-8; system prompt 8,761 chars over the 3-track fixture; 78/173 commands exposed; brainBench 18/19 @ ~1,039ms (2026-06-25, memory-note only).
- **Eval substrate:** conformance = 24 unique scenarios (200 templated rows), ~9–10s/run, wired into gate.sh; current local report 135 pass/16 gap (committed FEATURE_AUDIT.md stale at 134/17); monster CSV = 20 unique prompts, abstract vocabulary, zero code consumers; importers 100% clean-apply on all five demo files with exact note counts.
- **Owner listening arc:** "outlines with dinky stock sounds" → "all sound the same… 808 like a hi-hat… guessing randomly" → post-pivot "the beats do sound like real beats now" → Gate C: distinct-but-not-keepable, one "wow! cool! not finished yet."

### Inferred (consistent with evidence, not directly measured)

- The 0.62 headline is ~¾ addressable (deferral calibration ~0.19 + volume defect ~0.05) with a plausible fixed-data 4B ceiling ≈0.86 — *contingent on Q2/Q3 above*.
- The r7 metadata corruption (tempo/key) plausibly caused the would_keep loss (transposition and tempo/key retrieval silently no-op over None/140).
- The harvest zero-data state is most likely the deployed bundle predating the turn_id executor — testable in 5 minutes.
- Loop architecture, not model choice, is the binding constraint for compositional asks (9/9 slot-fill vs silent skeletons on both model classes).
- "ρ≈0" and "renderability-dominated" are two distinct findings (validity probe vs gradient decomposition) that later docs fused into one phrase.

### Could not find (absence as signal)

- **Any GRPO reward curve from a real run** — no tensorboard, no CSVs; the "headline failure" was never a logged training collapse but a smoke + design-analysis conclusion. (This strengthens the case against the stack: it never even earned a failure curve.)
- **Owner ratings for the recipeVerifier validity pack** — built, never rated.
- **Any recipe ever mined from a real video** — platforms on disk: `seed` and `local-midi` only.
- **Any real harvested tuple, ever.**
- **`laughing-grothendieck` worktree/branch** — deleted; PR #10 closed unmerged 2026-06-11; head commit unreachable (recoverable via local object store or `refs/pull/10/head` until gc).
- **Gate A (owner-ear fidelity vs source) for any recipe** — the r7 "gate-a-midi-audit" is a programmatic note-fidelity check, exact by construction for MIDI sources; the panel's #1 risk remains untested.
- **A filled Results section in main's AUTONOMOUS_SFT.md**; **probe RESULTS.md on any disk checkout**; **brainBench results as an in-repo artifact**; **the exact "MERT 0.938>0.812" figure from the memory index** (ungroundable in any document — treat memory-index numbers as secondary).

### Provenance warnings

GEPA is quoted three ways across docs (0.79→0.97 / 0.752→0.997 / 0.87→0.99 — different runs of the same program, all real). The cp400/cp600 files (0.889/0.893) are known-invalid and sit undated next to valid results. PR #176 under-represents its branch by 13 commits. Anyone auditing this program after a worktree cleanup would reconstruct a materially wrong history — hence the Stage-0 irreversibles chore.

---

*Prepared 2026-07-01. Evidence workflows: `wf_bfe331a8-44e` (11 investigators), `wf_32a205d1-b4e` (3 adversarial critics). All "measured" numbers re-verified from primary artifacts this session.*
