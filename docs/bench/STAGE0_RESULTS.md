# Training program — Stage 0/1 execution results (2026-07-01/02)

*Execution session following `docs/plans/moshi-training-audit-2026-07.md`. Everything below ran
headlessly on the real engine unless noted. Spend so far: ≈$0.60 cloud tokens (ceiling $100).*

## The headline discovery: the local-lane numbers were mislabeled

Re-running the frozen 300-case eval under ONE pinned serving stack (mlx_lm 0.31.3, venv unchanged
since Jun 21, `HF_HUB_OFFLINE=1`, model pinned by PATH) reverses the audit's inherited premise:

| model (same frozen 300, same stack, temp 0) | clean-apply | deferrals |
|---|---|---|
| cloud gpt-5.4-mini (recorded June) | **0.875** | 18 |
| **BASE Qwen3-4B-Instruct-4bit — no fine-tune** | **0.714** | 24 |
| fused v2 (the June LoRA fine-tune) | **0.218** | 204 |

- The recorded "local Qwen3-4B LoRA **0.619**" (AUTONOMOUS_SFT.md results, unmerged branch) was
  almost certainly the **BASE model**: its eval requested model id
  `mlx-community/Qwen3-4B-Instruct-2507-4bit`, and this mlx_lm version **routes multi-model by
  request id** — the request loaded the HF-cached base, not the fused weights. Verified live:
  the same deferring prompt answered correctly via the base id and with
  `{"intent":"ACK_GOT_IT","say":"Tempo set to 125 BPM."}` — **claims the edit, emits no
  command** — via the fused path.
- So the **v2 fine-tune DAMAGED the model** (−0.50 vs its own base). Mechanism located: v2 train
  data has exactly two modes (6,960 ACK+commands rows, 355 HUH+say rows); the over-fit LoRA
  (train loss 0.04, 8 utterance shapes) mode-interpolates to ACK+say+no-commands on
  off-distribution phrasings.
- **A completely untrained 4B is only 0.16 behind the cloud brain** on this eval. The local
  lane's bar is now: any fine-tune must beat **0.714**, or don't ship it.
- Provenance rule going forward: any local eval number must record the serving fingerprint
  (mlx_lm version + model resolution mode). Three numbers — 0.889 / 0.619 / 0.218 — were all
  "the local model" in prior records; they were the Huihui-template artifact, the base model,
  and the actual fine-tune.

## Moshi-Bench v0 (execute-graded, real engine, 35 cases)

`ui/scripts/moshiBench.mts` + `ui/src/bench/cases.ts` — NL→command cases graded by executed
STATE (direction+tolerance bands, never exact gold); defer cases; corrective cases render
before/after WAVs to `~/mosh-bench-artifacts/` for the owner's ears.

| arm | score | notes |
|---|---|---|
| cloud gpt-5.4-mini, plain rules | **31/35 = 88.6%** | fails: fx-ott, fx-autotune (deferred — catalog never names builtin types), section-rename (passed section NAME as id — real ids are 32-hex), transport-play (headless grading artifact, case fixed) |
| cloud + worked-examples block | **32/35 = 91.4%** | both fx cases FLIPPED to pass (one composed load_builtin + set_plugin_param); tempo-slang deferred once (new); section-rename still fails |
| cloud + one-shot repair turn | 30/35 = 85.7% | neutral-to-noise on the cloud column: its failures are DEFERRALS, which repair can't touch (repair fires on failed commands — the local column is its real target) |
| cloud plain, run 2 (variance) | **31/35 = 88.6%** | headline identical; 1 model-side case flip (transport-seek) ⇒ single-run noise ≈ ±1 case (±2.9%); persistent failures = section-rename, fx-ott, fx-autotune — exactly the examples-block targets |

The worked-example lever transfers to command emission. `ui/src/agent/fewshot.ts` holds the
block (kept out of production `DEFAULT_RULES` until the A/B is conclusive across both columns).

## Flywheel + turn factory

- **First real tuples in the program's history**: bracketed `--run-script` turns → harvester →
  3/3 tuples with correct labels (proof session `harvest-proof-1`).
- **Confirmed defect**: organic tuples whose commands reference engine ids mock-replay as
  `replayClean:false` with WRONG snapshots (native id 1010 vs mock id 14; mock also seeds
  phantom demo tracks). Organic tuples' commands/utterance/appliedClean/taste are trustworthy;
  their snapshots are not. `scripts/harvest-watch.sh` documents this; factory tuples sidestep it
  entirely (real `__snapshot` grounding).
- **Turn factory** (`ui/scripts/turnFactory.mts`): 41 real-engine tuples from 51 turns across 10
  arcs, 92.7% appliedClean, engine ids verified deterministic across replays. The 10 CLOUD-brain
  deferrals map the few-shot bank's target list (builtin FX, bar-referenced moves, loop/seek,
  compound asks).

## Data fixes + v3 corpus

- Fixed the two measured defects (`ui/src/sft/buildDataset.ts`): absolute-faithful volume/pan
  utterances; NEW true-relative volume tasks (fixed convention: touch=2dB, bit=3dB, "by N"=N);
  HUH slice 5%→1.5%; `autotrain.sh` serve step pinned `HF_HUB_OFFLINE=1`.
- `service/sft/curate_dataset.py` — THE committed curation recipe (v2's was ad-hoc/unreproducible):
  merge by priority (DAW-rich first), leakage-filter vs frozen evals (275 rows dropped, 183
  sources), class caps, content dedupe (12,776 MIDI near-clones collapsed).
- **v3-final: 7,444 train / 1,911 valid** — volume 827 rows (v2-equivalent had the broken 708),
  pan 358, populate/clip capped 2,500 each, 38 factory tuples. Known gaps: only 5 defer rows
  survived dedupe; .flp files skipped (PyFLP venv not set up here — 500 files of future coverage).
- **v3-final LoRA training in flight** (500 iters, mask-prompt, 16 layers — sft_run.json will
  carry the config + dataset hash). Gate: beat BASE 0.714 on the frozen 300 under the same
  pinned stack, else the local lane ships the BASE model + prompt work.

## Engine/catalog findings for the follow-up list

- `set_transport` cannot express a loop REGION (boolean + position only) — catalog-extension
  candidate; both cloud and factory turns defer on "loop the first 8 beats".
- `create_track {name, type:"midi"}` drops the name (only "audio"/"drum" are valid types; the
  catalog desc says so, models pass "midi" anyway — worth a validation error or coercion).
- Section ids are 32-hex UUIDs; models (incl. frontier) pass the section NAME. Either accept
  name as a fallback resolver in `rename_section`/`move_section`, or teach harder in the prompt.
- `rename_section` correctly errors on unknown ids (no silent-ok — verified).

## Owner ears queue (unchanged, waiting)

1. Rate the validity pack `~/mosh-validity` (45 min) — the panel's #1 experiment, still unrated.
2. Blind 10-ask corrective session (pre-registered gate for the scaffolded brain).
3. Corrective before/after renders in `~/mosh-bench-artifacts/` (2 pairs so far).
4. Gate C r8 re-run when the generation thread lands the corpus fix (`docs/plans/r8-corpus-spec.md`).
