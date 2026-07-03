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
| WP-1 pre-reg | this document | |

*(subsequent readings appended as they land)*
