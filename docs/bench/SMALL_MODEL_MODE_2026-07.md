# Small Model Mode — pruned command-schema + system-prompt arm (2026-07-10)

**Status:** COMPLETE. §1–§3 pre-registered before any model run (commit `edada2f4`); §4–§5 executed 2026-07-10, both subjects, 12/12 cells, one read per cell, no retries. **Headline: the §P9 "deferral-class model misses" turned out to be a FIXTURE bug (29 stale-id evalA rows), not model behavior — on valid fixtures both subjects have zero target-family deferrals under every arm. The pruned arm itself is a real aggregate win (matches few-shot without examples, stacks with it) with a registered frozen300 cost.**

---

## §1 Motivation & cross-refs

The 2026-07-10 r4-cuda fixed-harness rerun left exactly two model-caused floor misses, both deferral-class: `assign_sample` 0.333 (n=3) and `load_drum_kit` 0.333 (n=8) — the model DEFERS on fully-explicit asks ("Map /Users/…/kick.wav to track 1010 on note 38 …"). [PROGRAM_STAGE1_2026-07.md](PROGRAM_STAGE1_2026-07.md) §P9 registers up front that if the deferral habit survives r5, **the next lever is intent-level (ACK vs DEFER prior), not more rows**.

This experiment builds that lever **prompt-side** — a producer-pal-inspired "Small Model Mode": a pruned command catalog, simplified descriptions on the hottest commands, and an ACT-by-default defer rule — and measures it with the EXISTING `evalSft.mts` harness on the SAME frozen surfaces. Stage-0 evidence says prompt-side wins are real (worked examples lifted a weak model ~+30pp where intent-only rule cards gave zero; scaffolding > weights).

**Independence from the r5 gate:** all runs use distinct `smm-*` tags; nothing here folds into a §P8/§P9 gate read. No training, no RunPod.

## §2 Treatment (registered)

One new eval arm `--rules pruned` (+ a `pruned-examples` factorial variant), implemented in `ui/src/agent/smallModel.ts` and threaded through `buildSystemPrompt`/`metric.ts` as an optional catalog override (production prompt byte-unchanged; all existing callers positional).

**Catalog prune — 81 → 51 commands, 7,765 → 4,475 chars (−42%).**
- Kept = the **41 eval-gold commands** (pinned by test `smallModel.test.ts` — dropping any would make its rows unpassable, breaking the A/B by construction) + 10 product-core keeps: `add_test_tone_clip` (WORKED_EXAMPLES emits it), `import_clip`, `move_clip`, `trim_clip`, `split_clip`, `duplicate_clip`, `remove_clip`, `quantize_notes`, `load_builtin`, `accept_render`.
- Dropped (30): annotation edits (`edit/move/remove_annotation`), clip cosmetics (`rename_clip`, `set_clip_gain`, `set_clip_mute`), take management (`list_takes`, `set_current_take`, `keep_take`), plugin micro-management (`load_plugin`, `set_plugin_param`, `reorder_plugin`, `open_plugin_editor`), render-lifecycle micro-commands (`compile_render`, `reset_render_layer`, `bypass_layer`, `freeze_layer`, `bounce_layer_to_clip`, `remove_render_layer`), and the 11 non-gold lyric-editing commands.
- Arg specs are reused **by reference** from `AGENT_COMMANDS` (desc-only overrides) — validation (`validateCommand`) and function-call-form recovery (`normalizeCommand`) are identical across arms; scoring parity is automatic since the scorer always validates against the FULL map.

**Desc overrides (4, desc-only):**
- `assign_sample` → "Map an audio file onto a track's sampler at a MIDI note — a named track + file + note is a complete ask, act on it (mode 'drum' = one-shot pad, default; 'melodic' = pitched across the keyboard, note = root)"
- `load_drum_kit` → "Load the built-in drum kit onto a track's sampler — to make an existing track a drum track, pair with set_track_type"
- `create_render_layer`, `set_render_param` → mechanical trims of the two longest kept descs.

**Rules — 880 → 726 chars; the load-bearing change is the defer pair** (replacing DEFAULT_RULES' "If the request is unclear or needs info you don't have, set intent HUH … don't guess", which a small model reads as license to defer on explicit asks):

```
Rules:
- Use the REAL ids from the session for trackId/clipId, always as a JSON string — "trackId": "17", never the bare number 17.
- One request can produce several commands (they apply together as one undoable change).
- ACT by default. If the user names the target and the values (e.g. a track + a file + a note), emit the command — do not ask.
- Set intent HUH and ask in `say` ONLY when a required value is missing or two session objects match the request equally.
- To re-imagine part of the song: create_render_layer on the clip with regionStart/regionEnd in seconds (beats × 60 ÷ tempo), then render_layer.
- After edits use intent ACK_GOT_IT (or DONE). Stay in character — never mention JSON, commands, models, or AI.
```

`pruned-examples` = the pruned catalog + `SMALL_MODEL_RULES` + the existing `WORKED_EXAMPLES` bank verbatim (every command it emits is in the keep-list, test-pinned).

**Declared limitation:** "pruned" bundles catalog-prune + desc-overrides + rules-sharpen into ONE treatment. If the bundle wins, a `pruned-catalog-only` ablation (default rules + pruned catalog) decomposes it — defined as follow-up, not run here.

**Subjects & matrix (12 cells, owner-approved):**
- Subjects: **base** `Qwen3-30B-A3B-Instruct-2507-4bit` (MLX, `~/AI/models/mlx/`), then **fused r3** (re-fused from `.adapters/a3b-r3` into a non-iCloud dir — the existing `.fused/a3b-r3` shards are iCloud-evicted stubs; weight-check + identity + differential probes before eval).
- Per subject: evalA (210-row core) × {plain, examples, pruned, pruned-examples}; frozen300 `--n 300` × {plain, pruned}. All `--no-think`, temp 0, one `mlx_lm.server` at a time, run from the non-iCloud gate worktree; tags `smm-<subj>-<arm>-<surface>`.
- Eval files: the durable copies at `~/Library/Mosh/work/gate/rerun-evals/` (same files as the r4 rerun; shas recorded in §4).

## §3 Pre-registered read (BEFORE runs)

**Primary — deferral counts on the target families (evalA, plain vs pruned, same subject):** `assign_sample` (n=3), `load_drum_kit` (n=8), `set_track_type` (n=8; carries 2 of the paired set_track_type+load_drum_kit rows). **Success = strict deferral-count decrease on ≥1 target family AND no family that had 0 deferrals under plain gains deferrals under pruned.** Counts are reported (e.g. "2/3 → 0/3"), never rates alone — at n=3–8 one row flips a floor (§P9's registered caveat).

**Secondary — non-regression:** evalA aggregate cleanApply within **−0.02** of same-subject plain; frozen300 (`--n 300`) cleanApply within **−0.01**; no family ≥0.5 under plain dropping <0.5 under pruned (counts disclosed).

**Attribution:** examples vs pruned vs pruned-examples deltas answer "is any lift just few-shot?" — pruned must beat plain on the primary read to claim the schema/rules lever works independently of examples.

**Caveats registered up front:**
1. ONE read per cell, no retries; a re-run for infra failure (server crash) is noted, never silently substituted.
2. `deferred` in the harness conflates true deferral with JSON-parse failure — target-family "deferrals" are manually classified from `feedback`/replies before being counted as intent-level deferrals.
3. temp-0 + `--no-think` is near-deterministic but not bit-guaranteed across serving restarts.
4. The pruned arm is prompt-steering only — the model can still emit dropped commands and they still validate/apply (scored by recall as usual).

---

## §4 Execution record (2026-07-10)

**Provenance.** Runs from the non-iCloud gate checkout `~/Library/Mosh/work/gate` at detached `edada2f4` (the pre-registration commit). Eval files (durable copies, same as the r4 rerun): `evalA.eval.jsonl` sha256 `f4944392053f7aadf1dc108da31a7ef14c2e7ea6c23a98b7e9a79341802d1123`, `frozen300-test.eval.jsonl` sha256 `1868ed3153ef7a212c72911f26f8aedb94997eb76e1e45f6df822f65ff9d7a2c`. Server `mlx_lm` 0.31.3 (sft venv), one server at a time on :8080, `--no-think`, temp 0. Subjects: **base** = `~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit`; **r3** = re-fused from `.adapters/a3b-r3` (rank-8, last-16-layers) to `~/AI/models/fused/a3b-r3` — weight-check PASS (shard4 base `b02f0e9f…` ≠ fused `e9d27ee3…`; shard1 base-identical, as expected for last-16); identity probe PASS; **differential probe PASS** (fixed evalA prompt; r3 reply ≠ captured base reply). Full shard shasums: `rerun-evals/smm-aux/fused-r3-shasums.txt`. The fused dir was deleted after the runs (disk at 97%; regenerate with `smm-aux/run-r3.zsh`'s fuse step, ~40 s). Raw results: `rerun-evals/eval_results.smm-*.json` (12 files, each records its `rules` arm + `perFamily`); runner + analysis scripts in `rerun-evals/smm-aux/`.

**Aggregates (as-measured):**

| subject | surface | plain | examples | pruned | pruned-examples |
|---|---|---|---|---|---|
| base | evalA (210) | 0.765 (37 def) | 0.810 (29 def) | 0.810 (24 def) | **0.840 (17 def)** |
| base | frozen300 (300) | 0.888 (7 def) | — | 0.873 (2 def) | — |
| r3 | evalA (210) | 0.834 (27 def) | 0.843 (22 def) | 0.852 (22 def) | **0.862 (21 def)** |
| r3 | frozen300 (300) | 0.968 (2 def) | — | 0.943 (0 def) | — |

**FINDING F1 — 29/210 evalA rows are broken fixtures, and they ARE the "deferral problem".** Row-level classification of every target-family deferral (pre-registered caveat 2) showed the deferring rows' utterances hardcode real-engine 1000-series ids ("track 1010", "clip 1016", "1012") while the mock snapshot the model sees contains ids 17–20/107–108 — the referenced object does not exist. A rule-following model can only defer or emit the literal id (failed apply); both score 0, so the rows are **unpassable**. A full-surface scan found **29 such rows across 15 families** (list: `smm-aux/broken-rows.json`; 26 score 0 under every arm on both subjects; 3 — `reject_render#0/#4`, `rename_track#4` — can "pass" only when the model ignores the stated id and guesses a target, which name-recall scoring cannot detect). Root cause: the eval-build pipeline authored utterances against real-engine logical ids (MoshOps ids start at 1000) but rows replay on the mock with different id assignment. **Consequent family ceilings on this harness path: assign_sample 0.333 (2/3 broken), load_drum_kit 0.667 (2/6), set_track_type 0.500 (3/6), rename_track 0.500, reject_render 0.500, remove_track 0.667, …** The r4-cuda gate read of assign_sample **0.333 sits exactly at its ceiling** — zero measurable model misses — and the §P8/§P9 per-command floor gate (≥0.5) is **unsatisfiable by construction** on assign_sample. Same bug class as the two degenerate split_clip fixtures repaired in the r4 rerun. Follow-up task filed (fix `buildEvalV2A.mts` id resolution, regenerate, re-baseline).

**PRIMARY read (deferral counts, plain → pruned, per §3):**
- base: assign_sample 2/3 → 2/3, load_drum_kit 2/6 → 2/6, set_track_type 2/6 → 1/6. Letter of the criterion: PASS (≥1 family strictly decreased; no 0-deferral family gained deferrals). r3: 2/3, 2/6, 2/6 → unchanged: FAIL by the letter.
- **Honest read: the criterion is vacuous — every immovable target-family deferral on both subjects is one of the F1 broken rows.** On the 181 valid rows the target families have **zero deferrals and (excepting r3-plain's one 0.50 partial on `assign_sample#1`) perfect scores under every arm on both subjects.** There is no intent-level deferral habit on this surface for the arm to fix; §P9's premise dissolves into F1.

**Fixture-adjusted aggregates (181 valid rows; the fair arm comparison):**

| subject | plain | examples | pruned | pruned-examples |
|---|---|---|---|---|
| base | 0.873 (12 def) | 0.918 (7 def) | 0.917 (5 def) | **0.952 (0 def)** |
| r3 | 0.951 (4 def) | 0.972 (0 def) | 0.965 (0 def) | **0.978 (0 def)** |

**SECONDARY read:** evalA aggregate: base **+0.045** ✓, r3 **+0.018** ✓ (both improve; bound was −0.02). No family ≥0.5 under plain dropped <0.5 under pruned; no 0-deferral family gained deferrals (both subjects) ✓. **frozen300: base −0.0155 ✗, r3 −0.0247 ✗ — both breach the −0.01 bound → secondary MISS on both subjects.** Decomposition (per-example diff): the loss is concentrated in note-population rows — under the pruned catalog the model sometimes answers a populate ask with `sketch_beatbox` instead of `add_note` runs (base 4 rows, r3 7 — a recall-stealing attractor that becomes more salient in the shorter catalog; it cannot be dropped, it is eval-gold) and sometimes emits thinner patterns (partial fairRecall; base ~9 rows, r3 11). Gains on the same surface: deferrals 7→2 (base), 2→0 (r3). r3's larger breach is expected: the adapter was **trained on full-catalog + DEFAULT_RULES prompts**, so the pruned prompt is off-distribution for it.

**ATTRIBUTION:** the pruned arm's lift is not few-shot in disguise — pruned ≈ examples on both subjects with **fewer or equal deferrals**, and the levers **stack**: pruned-examples is the best arm in every cell (base adj 0.952 / 0 deferrals in 181 — for an untuned 4-bit model, 0.001 above r3-plain's adjusted score). Notable arm effects outside the targets: base `undo` 0.000 (6 def) → prunedex 1.000; `redo` 0.000 (4 def) → 0.750; `reject_render` 0.750 → 1.000.

## §5 Decision & follow-ups

**Verdict: measured lift with a registered cost, plus a harness finding that outranks the experiment.**

1. **F1 first (blocks §P9/r5 reads):** fix the 29 stale-id fixtures before the r5 gate rerun — the assign_sample floor is unpassable, so r5 would MISS it regardless of training. Follow-up task filed ("Fix 29 stale-id evalA fixtures capping §P8/§P9 floors"): repair id resolution in `buildEvalV2A.mts` (render through the mock and rewrite utterance ids from the bound env), regenerate, archive the old file, re-baseline. Pre-fix floor reads for the affected families must not be compared against post-fix reads. **The r5 corrective-batch premise ("model defers on fully-explicit asks") is unsupported on this surface** — reconsider the 90-row drum-sampler batch's weight in s2-mix-v5 after the fixture fix produces a real read.
2. **Do not adopt `pruned` for production as-is.** The frozen300 breach is real on both subjects (sketch_beatbox attractor + thinner note patterns). Before any adoption: tune the `sketch_beatbox` desc (make "requires a recorded beatbox WAV file" load-bearing) and consider a population rule line, then re-run the two frozen300 cells only.
3. **For tuned models, the prompt arm must match training:** r3 regresses more than base under the pruned prompt (−0.025 vs −0.015 on its home distribution). If Small Model Mode is adopted, r5+ should *train* on the pruned prompt, not just serve with it.
4. **The strongest configuration measured is `pruned-examples` on the untuned base** (adj 0.952, zero deferrals on valid rows) — a genuine scaffolding-over-weights result: it puts base within noise of the r3 adapter's plain-arm performance. If a no-adapter fallback path is ever needed (fresh install, adapter unavailable), this is the arm to serve.
5. Deferred/known edges: `pruned-catalog-only` ablation (decompose catalog-prune vs rules-sharpen — worth running only if adoption proceeds); `compile_render` re-inclusion decision at adoption time; moshiBench/evalV2Grounded `--rules` parity.
