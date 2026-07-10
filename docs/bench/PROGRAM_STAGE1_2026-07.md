# Training program — Stage 1→2 execution record (2026-07-03 …)

*Executes `docs/plans/MOSHI_TRAINING_PROGRAM_2026-07.md` Stages 1–2 under the owner's
2026-07-03 greenlight: hard cloud-spend cap **$200**
([ledger](SPEND_LEDGER_STAGE1_2026-07.md)), autonomous through Stage 2, work packets
merge on green gates. Everything in §P below is **pre-registered before its run** and
does not move after results are seen. Gate readings land in §R as they happen.*

## §P — Pre-registrations (stated before any bulk run)

### P1 — ⛳ BT gate (spec §5 Stage-1.1) — measurement protocol

The spec's gate: *"if real BT at scale lifts the frozen eval <2 points, diversity was
not the binding constraint — shift the remaining budget entirely to coverage and
grounding."* Read via a **differential two-arm 4B LoRA ablation** (the differential
neutralizes the known 4B-fine-tunes-degrade-base confound — it is held constant
across arms):

- **Corpora** (identical rebuild args from the v3 manifest, current slicer — both arms
  therefore include the Stage-0 relative pan/tempo/volume tasks):
  `npm run build-sft -- --corpus ~/mosh-corpus --sample 1500 --seed 1 --split 80/10/10 --max-notes 8`
  - arm **s1-nobt**: no `--backtranslate` (mechanical seed phrasings).
  - arm **s1-bt**: `--backtranslate 26000 --bt-variants 9 --bt-styles`, **fresh
    `bt_cache.json`** (the v3 cache is the fake 4-shape template BT — `brainCalls: 0`
    in its manifest — and must never seed a "real BT" arm).
- **Training** (identical for both arms): `sft_cli.py train`, base
  `mlx-community/Qwen3-4B-Instruct-2507-4bit` pinned by local PATH, `--iters 1200
  --batch-size 1 --num-layers 16 --lr 1e-5 --max-seq-length 3000`, mask-prompt on,
  mlx-lm **0.31.3** (`~/Library/Mosh/venvs/sft`). (iters sized to the ~24k-row set;
  v3-final's 500 iters ≈ 2% of an epoch was likely under-trained — recorded as a
  deliberate, identical-across-arms recipe change.)
- **Eval**: frozen-300 = deterministic `--n 300` subsample of the sha-pinned
  `v3/test.eval.jsonl` (`1868ed31…`, see §P5) — the same comparator Stage 0 used.
  Plain `DEFAULT_RULES` (matching how v3-final/v2 were scored), temp 0, adapter served
  one-at-a-time via `mlx_lm.server --model <4B PATH> --adapter-path <arm>`, model
  pinned by PATH + one-token identity probe before each arm.
- **Gate quantity**: mean(cleanApply s1-bt) − mean(cleanApply s1-nobt) over the same
  300 ids, in points (×100). **< 2.0 ⇒ the shift rule fires** (the WP-6 $50 BT
  phase-B cap moves to coverage/negatives).
- **Pre-registered validity caveat**: if BOTH arms score >5 points below the base-4B
  anchor 0.714, the reading is recorded as *pathology-dominated* (training defect
  floors both arms and compresses the delta); the gate still applies as written.
- **Data disposition**: the gate governs *spend*, not *mix* — s1-bt rows enter the
  Stage-2 mix unless the delta is *negative* beyond −2.0 points.

### P2 — ⛳ Coverage target (spec §5 Stage-1.3) — command universe

The 78 agent-callable commands, enumerated at runtime from
`ui/src/agent/commands.ts::AGENT_COMMANDS` (count 78) at f1925292:

accept_lyric_proposal, accept_render, add_midi_clip, add_note, add_test_tone_clip,
analyze_lyrics, arm_track, assign_sample, bounce_layer_to_clip,
build_skeleton_from_clip, bypass_layer, bypass_plugin, complete_lyrics,
create_annotation, create_lyric_sheet, create_render_layer, create_section,
create_track, duplicate_clip, edit_annotation, fill_lyric_gap, freeze_layer,
get_rhymes, import_clip, keep_take, list_takes, load_builtin, load_drum_kit,
load_plugin, move_annotation, move_clip, move_section, open_plugin_editor,
quantize_notes, redo, regenerate_lyric, reject_render, remove_annotation,
remove_clip, remove_lyric_line, remove_note, remove_plugin, remove_render_layer,
remove_section, remove_track, rename_clip, rename_section, rename_track,
render_layer, reorder_plugin, save, set_clip_gain, set_clip_mute, set_current_take,
set_input_monitor, set_key, set_lyric_constraint, set_lyric_line, set_master_pan,
set_master_volume, set_metronome, set_note, set_plugin_param, set_render_param,
set_tempo, set_time_signature, set_track_mute, set_track_pan, set_track_solo,
set_track_type, set_track_volume, set_transport, sketch_beatbox, split_clip,
stop_recording, suggest_next_line, trim_clip, undo

**Measured baseline (v3 train, gold-command instances):** only **19/78 commands appear
at all**; add_note 50,046 · add_midi_clip 6,311 · set_tempo 5,948 ·
set_time_signature 5,327 · then ≤8 each for the other 15 · **59 commands at zero**.

Target: ≥50 kept training rows per command whose gold set names it. Rows come from
execution-filtered synthesis (clean-apply + on-target keeps only). Commands still <50
after ≤3 top-up rounds + SETUP-profile extension are recorded as **named misses** —
the gate is read honestly, never padded.

**Anti-skew cap**: rows whose gold command set consists only of the populate class
(add_note, and add_note+set_note variants) are downsampled to **≤2,000 rows** in the
Stage-2 mix (seeded, seed 1). (The v3 count above is *instances*; the cap is on
*rows*.)

### P3 — Grounding negatives (spec §5 Stage-1.4) — schema

Driver extension `--negatives`: task-gen writes user requests referencing
tracks/clips/sections/files **absent** from the live snapshot; a local filter rejects
any request that names a real snapshot entity. Gold assistant row =
`{"intent":"HUH","say":"<≤12-word clarifying ask>"}` — the existing defer convention,
same serving system prompt with the live snapshot. `--twins`: each negative also
emits a grounded twin (same phrasing rebound to a real entity), brain-answered, kept
only on clean-apply — contrastive pairs targeting the measured ~50% wrong-act on
absent-target intents. Volume ~600–900 negatives; negatives capped at **10–15% of
newly added rows** (the historic huh-overgeneralization lesson); wrong-defer is
tracked on eval-v2 §B.

### P4 — ⛳ Frozen-eval-v2 (spec §5 Stage-1.6) — composition & anti-gaming rules

- **§A per-command floors**: ~6 items × 78 commands. Sources: held-out test-split
  rows (splits group by sourceId — no cross-split leakage) + for
  synthesis-only commands, a **separate eval-only synthesis run** using a SETUP
  profile *different from every training SETUP*; its out-files never enter any
  training mix.
- **§B grounded execution**: policyProbe-style REAL engine apply on a **fresh third
  session fixture** (≠ training SETUPs, ≠ probe-v2 session): ~40 grounded intents
  across command families + ~20 negatives (absent ids, invented files). Grading:
  catalog → id grounding → file existence → real apply (`groundedApply`). This is the
  ⛳ "grounded clean-apply ≥85%" leg.
- **§C comparability anchor**: the frozen-300 verbatim, report-only.
- **Anti-gaming (all pre-registered)**: eval sourceIds excluded from all training;
  eval SETUP ≠ any training SETUP; eval utterances never pass through the training BT
  cache; the eval-v2 file sha256 is committed here **before any Stage-2 run**; temp 0;
  `--no-think` for thinking models; model pinned by PATH + identity probe; one mlx
  proc at a time.
- **⛳ Stage-2 exit gate (spec §5 Stage-2.1, unchanged)**: ≥0.75 on eval-v2 §A+§C
  aggregate, per-command floor ≥0.5 across the 78 (§A), grounded clean-apply ≥85%
  (§B). One diagnostic + one revised-**mix** retrain allowed; second miss ⇒ HALT.
- **⛳ RFT stop rule (spec §5 Stage-2.2, unchanged)**: max 2 rounds; stop when a round
  lifts the eval <1 point. Retrains are always **from base** on mix+RFT rows.

### P5 — Comparator integrity

v3 import sha256 pins (copied read-only from the Stage-0 worktree):
`test.eval.jsonl 1868ed31…f9d7a2c` · `train.jsonl d8893605…ad492f` ·
`manifest.json e5e3ca4f…f2fd2` (full sums in
`service/sft/.sft-data/v3-import/SHA256SUMS`, gitignored; reproduced in §R on first
use). Frozen-300 arm defs and all serving fingerprints are recorded per reading.

### P6 — ⛳ Substrate re-verification floor (new this run, protective)

Stage-0's substrate gate was measured on the **abliterated Qwen3.6-35B-A3B**
(lab-only); the pre-registered clean substrate is **Apache-2.0 Qwen3-30B-A3B 4-bit**
— a different base. Before any Stage-2 training: few-shot eval the clean checkpoint
on frozen-300 (`--rules examples --no-think --n 300`, temp 0). **Floor: ≥ 0.717**
(the 4B few-shot arm). Below floor ⇒ HALT for owner — the substrate-gate premise does
not transfer.

## §R — Readings & execution record

| WP | status | artifact |
|----|--------|----------|
| WP-0 preflight | ✅ 2026-07-03 | keys ✓ · v3 sha-pinned ✓ · sft venv (mlx-lm 0.31.3, out of iCloud) ✓ · driver smoke 2/2 kept ✓ · df 18 Gi free |
| WP-1 pre-reg | ✅ 2026-07-03 | PR #219 (804f3254) |
| WP-2 BT phase A | ✅ 2026-07-03 | s1-nobt: train 6,048 / valid 769 / test 748 (mechanical seeds). s1-bt: train **169,328** / valid 21,542 / test 20,944 — 27.0 phrasings/shape (≥25 target met). **Reading: the corpus yields only 5 distinct utterance shapes → the ENTIRE possible real-BT spend was 15 brain calls (~$0.02), not the spec's $45–90.** "BT at scale" is bounded by shape count, not budget: phase B (WP-6) is **structurally empty** — the fresh cache already covers all 5 shapes, so additional BT budget buys nothing. The WP-6 $50 cap therefore shifts to coverage/grounding *by construction*, consistent with (and independent of) the ⛳ P1 delta, which is still measured as pre-registered. Utterance diversity beyond 27×5 must come from execution-filtered synthesis (natural task-gen phrasings — cal-01 measured 91% acceptance). |
| WP-4 cal-01 | ✅ 2026-07-03 | 10 track/mixer cmds × 8: **73/80 kept (91%)** — far above the 0.15 planning floor; bulk coverage projects ≈ $10–15, well inside cap. |
| WP-4 cal-02..08 | ✅ 2026-07-03 | Full calibration, 74 deficit cmds × 8 (~$0.86): clips 70% · notes/sections 69% · master/annot 61% · **plugins 14% · takes/render 2.5% · lyrics ~11% · misc 0%**. Failure classes cleanly split: missing prerequisite state in the fixed SETUP (no notes/wave clip/plugin/annotation/lyric sheet/render layer), invented-file on file-taking commands, and model deferrals. |
| WP-4/5 driver upgrade | ✅ 2026-07-03 | `--setup` profiles (basic/rich/renders/rendered/proposals/**eval**), per-command task-gen hints, real asset WAVs under `~/Music/mosh-sft-assets/`, `--negatives --twins` mode (§P3). Goldens pin: every profile command agent-callable w/ required args; training profiles are prefix-supersets of basic; **eval profile shares zero entity names with training profiles (§P4 anti-gaming)**; HUH gold-row convention. Real-engine smokes: accept_render kept under `rendered` (was 0/8), set_clip_gain + bypass_plugin keep under `rich` (were 0/8), negatives 10/12 kept incl. correct entity-filter rejection. Structural named-miss candidates identified: takes family (no agent command creates take lanes headless), load_plugin (scanned-plugin ids unknowable), set_note/remove_note + annotation edits (entities not in the serving snapshot — deferring is arguably correct serving behavior). |

| WP-7 §B instrument | ✅ 2026-07-03 | `ui/scripts/evalV2Grounded.mts` — 37 grounded positives + 20 negatives on a name-disjoint fourth session. **Validated against the cloud anchor BEFORE freeze, 3 iterations: 63.4% → 73.0% → 83.8% clean** as instrument defects were removed (11 invisible-entity positives — plugins/render layers/lyric lines/note counts are NOT in the serving snapshot; a SETUP render-layer collision; a duplicate-lyric-sheet collision; one unguessable camelCase builtin type). Engine check recorded: `set_lyric_line` does NOT auto-create a sheet. Remaining cloud failures are all legitimate: over-asking on single-visible-clip intents (5), one arg-type validation, 3 invented-file negatives, 1 wrong-entity destructive act ("remove the Intro section" → removed the Bridge). **Cloud §B anchor: 83.8% grounded clean-apply, 75% negative-defer.** The ⛳ local gate (≥85%) stands as pre-registered — noting it now exceeds the measured cloud anchor. sha-freeze at the WP-7 PR. |

| WP-4/5 bulk r1 | ✅ 2026-07-03 | 3,010 calls / $4.51 → **1,430 coverage rows + 115 negatives kept**; 14/78 commands at ≥50 after r1. Diagnosis for r2: (a) per-40 task-gen replies TRUNCATED (4 commands lost to unterminated JSON — r2 uses small per); (b) render/lyric-proposal families defer because the entity is invisible in the serving snapshot → r2 adds profile-aware task-gen STATE hints (grounded-by-user-statement, same philosophy as real file paths); (c) **8 structural NAMED-MISS candidates** where no fair synthesis exists under the serving contract: `edit_annotation`, `move_annotation`, `remove_annotation` (annotationId invisible), `reorder_plugin` (slot indices invisible), `keep_take`, `list_takes`, `set_current_take` (no headless way to create take lanes), `load_plugin` (scanned-plugin ids unknowable). These are recorded against the ⛳ 78×50 target honestly — not padded. |

| WP-4/5 ⛳ coverage FINAL | ✅ 2026-07-03 | After 3 pre-registered rounds: **40/78 commands at ≥50 kept rows; 2,598 synthesis rows + 115 negatives (+twins) total; ~$8.6 synthesis spend.** 29 commands partial (2–47 rows — every kept row still enters the mix; the eval-v2 §A per-command floor will show which partials generalize). **9 named misses with causes:** 3 annotation edits + reorder_plugin (entity/slot ids invisible in the serving snapshot), 3 take commands (no headless take creation), load_plugin (scanned ids unknowable), get_rhymes (HARNESS: synchronous service query fails in the grade replay — proven by an engine-only probe with perfect args). Notable partial-miss causes: accept_lyric_proposal 0/118 (model never acts on invisible proposals even when the request asserts them), quantize_notes (model emits division as a string — a real arg-type defect now *measured*), assign_sample (note-name args). The ⛳ 78×50 target reads **NOT MET at 40/78** — recorded honestly; the binding constraint is serving-snapshot observability, not budget (spend was ~4% of cap). |
| WP-6 ⛳ shift reading | ✅ 2026-07-03 | BT phase B was **structurally empty** (all 5 corpus shapes fully covered by phase A's 15 calls) — the $50 cap shifted to coverage/grounding by construction and was partially consumed by synthesis rounds 2–3 ($4.10). The P1 delta ablation still reads on schedule (arm evals pending). |

| WP-3 arm-1 train | ✅ 2026-07-03 | s1-ablate-nobt: 1200 iters, val loss 0.222, **no NaN**, 4.6 h, peak mem 23.0 GB; provenance in `sft_run.json` (dataset sha a95b6040ea6a5543). Eval + arm-2 chained. |
| WP-3 arm-1 eval | ✅ 2026-07-03 | **s1-ablate-nobt: 0.7075 clean-apply, 35 deferrals /300** (frozen-300, plain rules, temp 0, pinned by PATH + identity probe). At BASE level (0.710/0.714) — **the fine-tune-degrades-base pathology (v3-final 0.558) is GONE with the rebuilt corpus + 1200-iter recipe, before BT even enters.** The P1 pathology caveat will not fire for this arm. Delta reads after arm-2. |
| **WP-7 ⛳ FREEZE** | ✅ 2026-07-03 | **Frozen-eval-v2 is FROZEN as of this commit — no Stage-2 run has touched it.** §A: `evalA.eval.jsonl` sha256 `de1d4cdb621707a6bf0e122d63544f0ed9fccc72fd0c8c2437526cb4591d8763` (265 items / 51 commands, 6-cap; built from the name-disjoint eval-profile synthesis + held-out v3 test rows; the 27 §A-absent commands are the named/partial misses — their floors read as unmeasurable, listed with the gate). §B: `ui/scripts/evalV2Grounded.mts` sha256 `f415b1f41047d84b65a23c66d370dfaff5e9fccdf3f5da9b45a60a431c09bc27` (37+20 intents; cloud anchor 83.8%/75%). §C: frozen-300 (sha `1868ed31…`, P5). Any edit to these files after this commit invalidates the pre-registration. **s2-mix (training data, not frozen — a P1 delta < −2 would swap its base to s1-nobt with a new manifest):** 172,026 → **61,218 rows** (dedupe 77,664 — BT-phrasing collisions; populate 35,144→2,000 seeded), 68 commands, A3B-tokenizer length filter dropped **0** rows at max-seq 4096 (the NaN class is empty at source); train sha `28ee65c763ebc357…`, valid sha `b5af29656b94e754…`. |

| WP-3 arm-2 train | ✅ 2026-07-03 | s1-ablate-bt: 1200 iters, val loss 0.226, **no NaN**, 5.0 h; provenance in `sft_run.json` (dataset sha 6fdae05aa7b47a8b). |
| **Serving-trap #4 — CORRECTION** | ⚠️ 2026-07-03 | **The earlier arm-1 "0.7075" reading and the first delta reading are INVALID and their result files were deleted** (provenance rule). Both arm evals served via `mlx_lm.server --model <4B PATH> --adapter-path <arm>` measured the **BASE model** — proven by: identical per-item scores across two different adapters (0/300 discordant), score ≈ base plain (0.710), and a differential test (direct `mlx_lm generate` with/without adapter produces different outputs, while the server's reply on the same prompt matches base exactly for both `model=<PATH>` and `model=default_model`). **The identity probe cannot catch this class** — it verifies the endpoint, not the weights. **New permanent rule: adapter evals FUSE first and serve the fused dir (the v3-final path), plus a DIFFERENTIAL probe** (fixed prompt whose base-vs-adapter outputs differ; the served reply must match the adapter side) before any adapter/fused eval. Re-run in progress. Also observed in the differential: the 4B training stack templates completions with an empty `<think>\n\n</think>` prefix (adapter emits it; base does not) — benign for parseReply, and exactly what the WP-9 smoke checks for on the A3B. |
| **WP-8 ⛳ P6 re-verify** | ✅ **PASS** 2026-07-03 | **Clean Qwen3-30B-A3B-Instruct-2507-4bit few-shot on frozen-300: 0.8808, 1 deferral/300** (examples rules, no-think, pinned by PATH, temp 0). Floor 0.717 cleared by +16.4 pts; **above the abliterated 35B's 0.826 AND above the cloud anchor's 0.875.** The substrate-gate premise transfers to the clean checkpoint, stronger than measured. WP-8 complete. |

| **WP-3 ⛳ P1 BT-gate READING (valid, fused path)** | ✅ 2026-07-03 | Weight-checked fused arms on frozen-300 (plain rules, temp 0, pinned by PATH): **s1-bt 0.6208 (66 def) vs s1-nobt 0.5188 (99 def) → delta +10.21 points, 67/300 discordant. GATE: ≥2.0 ⇒ NO SHIFT — real-BT diversity WAS the binding constraint** (and BT cuts over-deferral 99→66). **Pre-registered pathology caveat FIRES:** both arms >5 pts below base 0.714 — the reading is pathology-dominated (4B fine-tunes still degrade base on the ablation corpora, consistent with v3-final 0.558; the interim base-level claim from the poisoned serving was wrong and is corrected here). Net budget effect: unchanged — phase B remains structurally empty (5 shapes fully covered), so there is nothing further to buy in either direction. Mix base confirmed **s1-bt** (delta ≫ −2). Stage-2 consequence: the exit gate (≥0.75 + floors + §B ≥85%) is the protection against the same pathology class appearing on the A3B; its few-shot 0.8808 is the context to beat. |

| WP-9 train r1 | ✅ 2026-07-04 | a3b-r1: 2400 iters on s2-mix, 9.8 h, train loss 0.177, **no NaN**, peak 24.5 GB. Smoke pre-checks: NaN clean, `<think>` empty-block prefix present (template-injected; parseReply-safe — investigated on the 4B arms). Fused (shard-level weight check: tuned shard4 ≠ base, shard1 = base as expected for last-16-layer LoRA — the naive first check was corrected). |
| **WP-9 ⛳ EXIT GATE r1** | ⚠️ 2026-07-04 | **§C frozen-300: 0.914 (4 def/300) — ABOVE the cloud brain 0.875 and the untrained A3B 0.8808.** §B grounded: **89.2%** ≥ 85% ✓ (above cloud 83.8%); §A raw 0.757; **aggregate §A+§C 0.840 ≥ 0.75 ✓**. **Leg 2 (per-command floor) MISSES as written.** §A instrument amendment (recorded, file NOT edited): 45/265 items carry raw engine ids in utterances (ungroundable in the mock — builder defect) and 2 commands throw `window is not defined` in the mock; on VALID items §A mean = **0.9092**, 45/49 measurable pass. True below-floor: `undo` 0.00 + `redo` 0.25 (**root cause: BT expanded HUH rows 27× → 3,130 ≈ 5.1% of the mix — the historically known-bad defer fraction; model learned short-imperative→defer**), `set_render_param` 0.00 (8 training rows), `split_clip` 0.00 (absolute-seconds splits miss offset clips). §B negative-defer tracked: **8/20 — regression vs cloud 15/20** (same defer-distribution defect, opposite direction). **Pre-registered single retry fires: revised MIX only** — HUH rows capped to ~1.5%, negatives boosted, set_render_param top-up; gates unmoved. |

| WP-9 retry mix (r2) | ▶ 2026-07-04 | Deeper diagnosis before spending the single retry: (1) the HUH-gravity theory was **falsified** — post-dedupe the r1 mix held only 672 HUH rows (~1.1%), not 5.1%; (2) the real undo/redo defect is **output-format collapse on rare no-arg commands** (fused-r1 repro: `{"intent":"undo","say":…}` with NO commands array; `"commands":["redo()"]` as a string) — 53 perfect rows lost to 61k-row gravity; (3) split_clip is an **offset-clip generalization gap** (every training clip started at 0; args were well-formed). Revised mix v2 (data-side only): **rare-command oversampling ×4 below 100 rows** (8,118 extra rows across 64 commands), +226 negative/twin rows (§B defer regression), offset MIDI clip appended to the rich profile + 54 offset split/trim/move rows, defensive HUH cap. 69,610 rows, filter 0-dropped. set_render_param top-up failed again (0/40 hinted) — expected to remain below floor; recorded. r2 training launched (same pre-registered recipe). |

| **WP-9 ⛳ EXIT GATE r2 — SECOND MISS ⇒ HALT** | ⛔ 2026-07-04 | r2 (revised mix, same recipe): **§C 0.907 (2 def) · §A 0.750 raw / 0.9053 valid-items · §B positives 91.9% (up from 89.2%) · aggregate 0.833 ≥0.75 ✓** — but leg 2 misses on the IDENTICAL set (`set_render_param` 0, `split_clip` 0, `undo` 0, `redo` 0.25) and §B negative-defer is unchanged (8/20). **Root cause now measured, and it is the RECIPE, not the data: batch 1 × 2400 iters samples only ~2,400 of 69,610 rows (~3.4%)** — a 212-row command has ~7 expected exposures across the whole run; ×4 oversampling moved exposure from ~2 to ~7 rows, far below what format-imprinting needs. Fixing it requires more iters / epochs / curriculum — a recipe change the pre-registration does not permit inside this cycle. **Per §P4: second miss ⇒ HALT with report. The gate is NOT moved; the checkpoint is NOT declared passed.** |
| **RUN VERDICT (for the owner)** | 🏁 2026-07-04 | The Stage-2 checkpoint (`a3b-r2`, fused copy retained) **beats the cloud brain on the frozen comparator (0.907–0.914 vs 0.875)**, holds 45/49 measurable per-command floors, and exceeds the §B grounded-positive gate (91.9% ≥ 85%). It fails the letter of the exit gate on 4 commands with fully-diagnosed causes: 2 structural (`set_render_param` un-synthesizable at acceptance 0; `split_clip` offset-math needs broader session variety), 2 exposure-bound (`undo`/`redo` — recipe iters, above). §B negative-defer (8/20 vs cloud 15/20) needs negatives at meaningful mix share (~340 rows ≈ 0.5% was too small at 3.4% sampling). **Owner decisions for the next cycle: (a) bless a recipe amendment (iters ≥ 1 epoch equivalent, or epoch-based training) and re-register the gate; (b) or accept-with-exceptions for best-of-n serving experiments (cloud stays the serving default per invariants either way); (c) RFT rounds are moot until a passed checkpoint exists (⛳ unchanged).** |

*(run record closes here; next cycle opens a new §R block)*

---

## Cycle 2 (2026-07-04) — §P7 recipe amendment + gate re-registration

**Owner decision (2026-07-04, verbatim): "Recipe amendment + re-registration then keep working"** — option (a)
of the Cycle-1 RUN VERDICT. This section is written and merged BEFORE the r3 run
launches; nothing below moves after any r3 reading.

### P7.1 — Root cause being amended (measured, Cycle 1)

Batch 1 × 2400 iters saw ~3.4% of the 69,610-row v2 mix. The reason a full epoch
was infeasible is **mix shape, not model cost**: 3 head commands owned 80.6% of
the rows (`add_midi_clip` 35,168 · `set_tempo` 11,682 · `set_time_signature`
9,268; every other command ≤316). One epoch of v2 at the measured 17.1 s/iter
(r2: 41,127.5 s / 2400 iters) ≈ 14 days. The amendment removes the head skew so
epoch-scale exposure fits a ~3-day window.

### P7.2 — Amended mix: s2-mix-v3 (built, deterministic, auditable)

Derived from s2-mix-v2 (`train.jsonl` sha `b15dc2f10f7f730a…`) by
`rebalanceSelect` (`ui/src/sft/mixAssembly.ts`, golden-tested; I/O wrapper
`ui/scripts/rebalanceMix.mts`), params `cap-per-command 400 · neg-cap 200 ·
generic-huh-cap 50 · seed 1`:

- **Flat per-command cap 400** over a seeded shuffle, greedy keep-if-any-command-
  under-cap (multi-command rows may overflow a cap — coverage beats the cap).
  **NO dedupe**: v2 is already deduped; its ×4 rare-row oversample duplicates are
  intentional repetition and survive.
- **HUH re-cap 250 rows = 1.97%** (proven-safe band), **grounding negatives
  first**: 200 of the 232 negative rows present (exact line-hash match against
  `synth/negs-*.jsonl`) + 50 of 440 generic vague-request HUH. This is the §B
  negative-defer fix: at epoch exposure each kept negative is actually seen,
  while the defer *fraction* stays far from the known-bad ~5%.
- Result: **train 12,674 rows / 68 commands** (head 3 + add_note at 400 each;
  the four Cycle-1 floor-missers keep every row they have — `undo` 236 ·
  `redo` 236 · `split_clip` 272 · `set_render_param` 112 — ≈30× the exposure
  they got in r2), valid 1,650. A3B-tokenizer length filter at 4096: **0
  dropped** (v3 ⊂ already-filtered v2, belt re-run anyway).
- shas: train `e5e067cceaee945ad89b5d6439416debd23c19f4f7caa835643383b2e62c9af2`,
  valid `9047ab96fd7e8f7f…` (full manifest in `s2-mix-v3/manifest.json`).

### P7.3 — Amended recipe (r3): epoch-sized by selection rule

Unchanged from r1/r2: clean A3B base by PATH, LoRA `--num-layers 16`,
`--lr 1e-5`, mask-prompt ON, grad-checkpoint ON, `--max-seq-length 4096`,
train **from base** (fresh adapter `a3b-r3`), fuse → shard-4 ≠-base weight
check → differential probe → serve fused, ONE mlx proc, temp-0 evals.

Changed — batch and iters are fixed by this rule, with constants filled from
**measured pace smokes run before launch** (12–25-iter trains on the v3 mix at
batch 1/2/4; the smokes double as the NaN + `<think>`-artifact pre-check):

- **batch** = argmax measured rows/sec over {1, 2, 4} (ties → smaller batch,
  closer to the r1/r2 recipe; peak-mem must stay ≤ 50 GB of 64 GB) — **with an
  lr-coupling clause added pre-launch, after the smokes read but before any
  training** (amendment inside the open PR, recorded transparently): because lr
  is pinned at the r1/r2-proven 1e-5 and is NOT scaled with batch, batch > 1
  cuts optimizer steps per epoch by the batch factor — the exact under-imprint
  class this cycle repairs. Batch > 1 therefore requires a ≥ 25% measured
  throughput edge; below that, batch stays 1;
- **E (epochs over the 12,674-row mix)** = the largest of {1.0, 1.5, 2.0} whose
  projected wall-clock at measured pace is ≤ 78 h (projection includes the
  measured validation overhead ≈ +0.9 s/iter — wall-clock means wall-clock);
- **iters = ceil(E × 12,674 / batch)**.

The chosen constants are recorded in the §R2 launch row BEFORE training starts
and never adjusted afterward. Exposure consequence: every training row gets ≥E
looks (r2 gave rare rows ~7 total across 64 oversampled commands).

### P7.4 — Re-registered exit gate (thresholds verbatim, ONE clean read)

Identical to the Cycle-1 gate, including the recorded §A instrument amendments
(45 id-bearing items excluded as builder defects; 2 mock-broken commands
unmeasurable; floors read on valid items over the 49 measurable commands):

1. aggregate §A+§C ≥ **0.75**;
2. per-command floor ≥ **0.5** on the 49 measurable commands (valid items);
3. §B grounded clean-apply ≥ **85%** (negative-defer tracked, not a leg).

**One clean read. NO retry exists in this cycle: any miss ⇒ HALT-and-report.**
Known weakest measurable: `set_render_param` (112 rows, synthesis acceptance 0 —
no top-up possible); it is NOT exempted — if it stays <0.5 the gate reads as a
miss and the owner decides again with that number on the table.

### P7.5 — Concurrency + budget

r3 is $0 cloud (all local). While it trains, work continues on **WP-11
(best-of-n serving skeleton — cloud `brain_client`, flag-gated, full native
gate)**, which needs no local mlx serving; the ONE-mlx-proc rule bars any local
serving/eval until r3 finishes. Cloud spend cap unchanged ($200, $11.36 used).

## §R2 — Cycle-2 readings

| step | status | artifact |
|------|--------|----------|
| s2-mix-v3 build | ✅ 2026-07-04 | 69,610 → **12,674** train rows (recount-verified: 68 cmds, head 400 each, HUH 250 = 1.97% [200 neg + 50 generic], floor-missers keep all rows); valid 21,542 → 1,650; length filter 0-dropped; goldens 14/14 + typecheck. |
| Pace smokes (pre-launch) | ✅ 2026-07-04 | v3 mix, seq 4096, grad-checkpoint, last-full-window readings: **b1 16.1 s/iter (0.062 rows/s, peak 23.2 GB) · b2 32.3 s/iter (0.062, 27.1 GB) · b4 58.8 s/iter (0.068, 35.4 GB)** — throughput is compute-bound-flat; b4's edge is 9.7% < the 25% lr-coupling bar. Initial val pass 176.9 s → val overhead ≈ +0.9 s/iter at the 200-iter cadence. NaN pre-check: all three smokes finite-loss throughout (b1 loss 1.42→0.03 over 25 iters). `<think>`-artifact check carried over from the r1 investigation on the identical base+stack (template-injected empty block, parseReply-safe). |
| **r3 LAUNCH (constants fixed pre-run)** | ▶ 2026-07-04 | **batch 1 · E = 1.0 · iters = 12,674 · lr 1e-5 · layers 16 · seq 4096 · mask-prompt · grad-checkpoint · from base → `.adapters/a3b-r3`** — per the P7.3 rule: batch 1 (b4 edge below the lr-coupling bar), E=1.0 (E=1.5 projects 89.8 h > 78 h at blended 17.0 s/iter), projected **≈ 59.8 h**. Every training row gets ≥1 look; oversampled rare rows get 4; the four Cycle-1 floor-missers get 112–272 looks vs r2's ~7. nohup-detached (survives the session); log `.adapters/a3b-r3.train.log`. |

| **r3 GATE READ (full epoch, ckpt 12,674)** | 🛑 2026-07-07 | Fuse→shard-4 weight-check (tuned `e9d27ee3`≠base, shard1=base ✓)→serve fused→identity probe→§A/§B/§C, per `service/sft/GATE_READ_r3.md`. **§C frozen-300 = 0.960** (2 defer/300 — NEW BEST; cloud 0.875, r1 0.914, r2 0.907). **§A raw 0.777 / adjusted 0.937** (213 measurable items; the pre-recorded amendment excludes 7 mock-broken `build_skeleton_from_clip`/`sketch_beatbox` + 45 raw-engine-id utterances). **agg §A+§C ≈0.949 ✓≥0.75.** **§B grounded 91.9% (34/37) ✓≥85%** (cloud 83.8%, r2 89.2%; neg-defer 9/20 weak, tracked-not-a-leg). **Per-command floor: MISS** — `split_clip` 0.00 (5/6 "split point outside clip" — the offset-coordinate gap; fix built PR #238) + `set_render_param` 0.00 (n=1, semantic — unsynthesizable). **The 4 Cycle-1 missers: undo 0.33→0.67 ✓, redo 0.50→0.75 ✓ CROSSED** (the exposure hypothesis VALIDATED), split_clip/set_render_param remain. Cost $0 (local mlx + local engine). |

**RUN VERDICT (P7.4, ONE clean read — no retry this cycle):** 🛑 **HALT — the per-command floor leg MISSES** on `split_clip` (0.00) + `set_render_param` (0.00), so the re-registered gate is NOT met; **the gate is NOT moved.** BUT this is a decisively better checkpoint than r1/r2: §C **0.960** (beats the cloud brain by 8.5 pts and both prior runs), §A-adjusted 0.937, §B 91.9%, and **2 of the 4 Cycle-1 floor-missers (undo, redo) crossed** — the epoch-sizing amendment did exactly what it was designed to do for the defer-gravity commands. The remaining two misses are well-understood and mostly already addressed: `split_clip` is a coordinate-DATA gap with the corrective batch **already built + merged (PR #238)**; `set_render_param` is the long-standing unsynthesizable command (0% acceptance, needs a live render layer). Owner options: **(a)** Cycle-3 — a NEW pre-registration (P7's retry is spent) folding the #238 offset-coord batch + a render-layer-present profile for set_render_param → retrain → re-read the floor; **(b)** accept-with-exceptions — bless a3b-r3 as a serving checkpoint with `split_clip`/`set_render_param` as documented named exceptions (it beats the cloud on §C/§B and every other floor); the cloud stays the serving default per the program invariants regardless. **(c)** proceed to WP-10 RFT on a3b-r3 as-is (it clears the aggregate + §B legs) with the 2 floors flagged. Both the adapter (`.adapters/a3b-r3/adapters.safetensors`) and the fused dir (`.fused/a3b-r3`, ~17 GB) are RETAINED for whichever option the owner picks; the server is stopped (mlx slot free).

---

## §P8 — Cycle-3 pre-registration (owner chose "Cycle-3 for a clean pass" after the r3 HALT)

Registered 2026-07-07 **before any Cycle-3 training**. P7's one-retry allowance was spent on r3, so this is a FRESH pre-registration with its own single clean read.

**Diagnosis carried in (from the r3 gate read, corrected):** neither floor miss is a data-coverage gap — `split_clip` (272 rows) fails only on OFFSET clips (all training clips start at 0 → absolute==relative never learned); `set_render_param` (112 rows) fails a single n=1 eval item by routing an ambient-transform request ("spacious, dreamy, echoing") to a reverb PLUGIN instead of a generative layer — a semantic-routing ambiguity, not missing data.

**Mix — `s2-mix-v4` (train sha `2dbcb6fd58542288`, 12,889 rows):** `s2-mix-v3` VERBATIM (12,674 — its intentional rare-command oversampling preserved) + the engine-validated **offset-coords batch** (155: 94 `split_clip` + 39 `move_clip` + 22 `trim_clip` on non-zero-offset clips, PR #238) + the engine-validated **render-routing batch** (60: ambient-transform→generative-layer, `genRenderRouting.mts`). Post-add coverage: `split_clip` 366 (26% offset-corrective), `set_render_param` 172 (35% routing). Length-filtered (0 dropped). All commands ≤ 400 cap ⇒ no rebalance.

**Recipe (fixed BEFORE the run):** batch 1 · **iters 12,889** (1.0 epoch of v4) · lr 1e-5 · num-layers 16 · seq 4096 · mask-prompt · grad-checkpoint · from base `Qwen3-30B-A3B-Instruct-2507-4bit` → `.adapters/a3b-r4`. Projected ≈ 71.6 h at ~20 s/iter (< 78 h budget). Same trap-proof read as `GATE_READ_r3.md`.

**⛳ Gate — re-registered VERBATIM (unchanged from P7.4):** aggregate §A+§C ≥ 0.75 · per-command floor ≥ 0.5 on the measurable set (the pre-recorded amendment exclusions apply: mock-broken `build_skeleton_from_clip`/`sketch_beatbox` + raw-engine-id utterances) · §B grounded ≥ 85%. **ONE clean read, no retry.**

**Honest caveat (registered up front):** `split_clip` is a high-confidence fix (the corrective data directly targets the confirmed mechanism). `set_render_param` is a **best-effort** tip on a single ambiguous eval item — it may remain a **named exception** even if the routing batch helps; a Cycle-3 that clears `split_clip` but not the n=1 `set_render_param` will be reported as such (not spun as a pass), and the owner decides whether that lone ambiguous item should gate.

| Cycle-3 step | status | notes |
|---|---|---|
| v4 mix + corrective batches | ✅ 2026-07-07 | offset #238 (155) + render-routing (60) engine-validated; v4 = 12,889, sha `2dbcb6fd…` |
| r5 prep candidate | ✅ 2026-07-09 | Non-MLX prep only while r4 runs: `s2-mix-v5-prep` = v4 train/valid copy + 15 assist rows in train only + evaluator sidecar metadata; restart decision remains `continue-r4`. See [R5 training decision note](R5_TRAINING_DECISION_2026-07-09.md). |
| r4 local run | ⏹ stopped 2026-07-09 | 5200/12889 on the Mac; owner-requested CUDA cutover to RunPod pod `gc3v0gpji7xskt` (parity controls: PR #268). |
| r4 CUDA run | ✅ 2026-07-09 | 12889/12889 in 4h59m32s; r4 recipe knobs mirrored (s2-mix-v4, lr 1e-5, seq 4096, last-16-layer LoRA, assistant-only loss). |
| r4 gate read | ❌ MISS 2026-07-09 | agg(A,C)=0.8891 ✓ · §B=0.9189 ✓ · measurable floors miss: `split_clip 0.0`, `assign_sample 0.33`, `load_drum_kit 0.33`, `set_track_type 0.42` (build_skeleton/sketch_beatbox 0.0 were pre-excluded mock-broken rows; their `window` harness bug is since fixed by #275). Full read: [GATE_READ_a3b-r4-cuda.md](../../service/sft/GATE_READ_a3b-r4-cuda.md) (reconstructed — original lost to iCloud git corruption). |
| r4 disposition | 📦 2026-07-09 | Pod terminated after adapter archival (`~/AI/adapters/a3b-r4-cuda-pull`, adapter sha256 `2f29b655…` verified vs pod). Owner decision: **fix-first, then informed r5** — land harness fixes, rerun the gate surfaces on the SAME adapter, fold only surviving model-caused misses into r5. Plan: [R4_CUDA_GATE_MISS_FIX_PLAN_2026-07-09.md](R4_CUDA_GATE_MISS_FIX_PLAN_2026-07-09.md). |
| r4 gate RERUN (same adapter, fixed harness) | ✅ 2026-07-10 | Fix-first executed: P0 #275 + P1 #283 + mock length-fidelity #286 (found mid-rerun, amendment 5) + 2 repaired degenerate split fixtures. Archived adapter (sha `2f29b655…`) re-served on pod `8300s0vr5qas70`; **split_clip 0.0→0.833 ✓ and set_track_type 0.42→0.500 ✓ (harness-caused); assign_sample/load_drum_kit hold at 0.333 ✗ (model-caused)**; frozen300 0.989, agg 0.919, §B 0.892 — all context bars hold. Full record + pre-registered amendments: [R4_RERUN_AMENDMENT.md](../../service/sft/R4_RERUN_AMENDMENT.md). |

---

## §P9 — r5 pre-registration (informed by the fixed-harness rerun)

Registered 2026-07-10 **before any r5 training**.

**Context carried in:** the r4-cuda adapter, re-read through the fixed harness,
misses ONLY `assign_sample` (0.333 — deferrals on fully-explicit asks) and
`load_drum_kit` (0.333 — deferrals + dropped `set_track_type`+`load_drum_kit`
pairing + one `load_builtin` misroute). Every other §P8 leg holds or clears
(split_clip 0.833; set_track_type 0.500; agg 0.919; §B 0.892; frozen300 0.989).
The r3-era "clip-relative emission" mechanism is REFUTED (it was the mock's
hardcoded clip length) — no coordinate rows are added.

**Mix — `s2-mix-v5` (train sha `3c4e2e8b2ecc3562…`, 12,994 rows):** `s2-mix-v4`
VERBATIM (12,889) + 15 assist-demonstration rows (Codex-staged, shape-validated)
+ the engine-validated **drum-sampler batch** (90: 48 `assign_sample`
deferral-suppression / 21 `load_drum_kit` solo / 21 paired
`set_track_type`+`load_drum_kit`; `genDrumSampler.mts` PR #287, 90/90
gradeApply-clean vs the P1-carrying build-233 binary, 0 drops). valid = v4's
1,650 VERBATIM. Length-filtered (0 dropped). Codex's 9
`a3b-r4-cuda_next_run_examples` shape-rows are superseded by the 90-row batch.
Prep manifest: `.sft-data/s2-mix-v5-prep/manifest.json`.

**Recipe (fixed BEFORE the run — the r4-CUDA lane verbatim):** RunPod A100 80GB
(pod `8300s0vr5qas70`, reused from the rerun; bootstrap validated), bf16 LoRA on
`Qwen/Qwen3-30B-A3B-Instruct-2507` via `sft_cuda_train.py` — batch 1 · **iters
12,994** (1.0 epoch of v5) · lr 1e-5 · lora-r 16 · last-16-layers · seq 4096 ·
assistant-only loss · grad-checkpoint → `.adapters/a3b-r5-cuda`. Projected ≈5h
at r4's ~1.39s/iter · ≈$7. Chosen over the local MLX seat deliberately: same
lane as the r4 read (comparability) at 1/14th the wall-clock.

**⛳ Gate — re-registered VERBATIM (unchanged):** aggregate §A+§C ≥ 0.75 ·
per-command floor ≥ 0.5 on the measurable set · §B grounded ≥ 85%. **ONE clean
read, no retry.** Floor sources: `diag_floor4` (split_clip) + the evalA 210-row
core (all other families; the 55-row clip extension remains lost — disclosed in
the rerun amendment). All reads through the post-#286 harness.

**Honest caveats (registered up front):** (1) the corrective batch's utterance
grid is narrow (6 track names × ~20 phrasings); if the deferral habit on these
two families survives r5, the next lever is intent-level (ACK vs DEFER prior),
not more rows. (2) evalA floor families are n=3–6 — one row flips a floor;
reads are reported with counts, not just rates. (3) The base is the bf16 HF
model (CUDA lane), not the 4-bit MLX base named in §P8's local recipe — same as
the r4-cuda read this run is compared against.

### §P9 result — r5 gate read (2026-07-10): **PASS**

| r5 step | status | notes |
|---|---|---|
| r5 CUDA run | ✅ 2026-07-10 | 12,994/12,994 in 5h58m59s; train_loss 0.06349 (r4: 0.06465), mean_token_accuracy 0.9743. Recipe = §P9 verbatim. Adapter sha256 `76f8db52…`, archived `~/AI/adapters/a3b-r5-cuda-pull`. |
| r5 gate read | ✅ **PASS** 2026-07-10 | **One clean read.** diag_floor4 0.895 · evalA 0.9357 · frozen300 0.977 · **agg(A,C)=0.9563 ✓** · **§B=0.8919 ✓**. **Target floors cleared: `assign_sample` 0.333→0.667 ✓, `load_drum_kit` 0.333→0.750 ✓** (`set_track_type` also 0.500→0.750); every measurable evalA family ≥ 0.5. Full read: [GATE_READ_a3b-r5-cuda.md](../../service/sft/GATE_READ_a3b-r5-cuda.md). |
| r5 disposition | 📦 2026-07-10 | Pod `szln5r26qdy66j` terminated after adapter archival (sha-verified Mac↔pod). r5 is the new best A3B adapter — clears the §P9 gate r4 missed on the same lane. ≈$8.6 total. |

**Honest deltas vs r4 (not gating, tracked):** §B `negativeDeferRate 0.45→0.40`
(r5 defers less — the intended direction; grounded clean-apply held identical at
0.8919). frozen300 `0.989→0.977` (trivial). §B ran against a **faithful rebuild**
of the P1-carrying binary (the pre-registered `build-233` dir had been deleted by
a stray build-clean; the rebuild's HEAD carries P1 as a verified ancestor).
