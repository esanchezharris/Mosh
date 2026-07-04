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

*(subsequent readings appended as they land)*
