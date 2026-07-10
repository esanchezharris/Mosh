# Small Model Mode — pruned command-schema + system-prompt arm (2026-07-10)

**Status:** §1–§3 pre-registered BEFORE any model run (committed with the arm code). §4–§5 filled after execution.

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

## §4 Execution record

*(to be filled after the runs: gate-checkout sha, eval-file shas, served-model identity + differential-probe outputs, fused-shard weight-check, full results table — aggregate + per-family blocks per arm × subject × surface)*

## §5 Decision & follow-ups

*(to be filled: primary/secondary verdicts per subject; adoption path — production wiring would need a mode switch in `brain.ts` and a fresh look at `compile_render`, which the pruned arm drops as a recall-stealing attractor on the eval surfaces; `pruned-catalog-only` ablation if the bundle wins; moshiBench/evalV2Grounded `--rules` parity is a known sharp edge, out of scope here)*
