# SFT eval runbook — evalA / frozen300 / diag_floor4

*How to actually run the three frozen-eval-v2 surfaces (§A/§C + the split_clip
floor diagnostic) against a local mlx-served adapter, end to end, on this Mac.
Every command below is copied from — or directly derived from reading — the
scripts it invokes; where a documented flag turned out to be a no-op in the
current code, that is called out rather than silently repeated. Grounding
sources: `service/sft/GATE_READ_r3.md`, `service/sft/run-gate-r4.sh`,
`service/sft/R4_RERUN_AMENDMENT.md`, `service/sft/GATE_READ_a3b-r5-cuda.md`,
`ui/scripts/evalSft.mts`, `ui/scripts/evalV2Grounded.mts`,
`ui/scripts/buildEvalV2A.mts`, `ui/scripts/lib/realEngine.mts`.*

## 0. What the three surfaces are

| surface | what it measures | scored by | id convention |
|---|---|---|---|
| **evalA** | per-command floor — ~6 items × command, held-out + eval-only-synthesis rows | `ui/scripts/evalSft.mts` (mock-apply + gold-name recall, `ui/src/gepa/metric.ts`) | `evalA#<command>#<i>` (drives the per-family rollup) |
| **frozen300** (§C) | comparability anchor — deterministic 300-row subsample of the frozen v3 test split | same as evalA | corpus-hash ids (no per-family rollup) |
| **diag_floor4** | the `split_clip` floor, isolated to a small fixture-repaired set (19 rows) after the `evalA#split_clip#4/#5` degenerate-fixture bug — see `service/sft/R4_RERUN_AMENDMENT.md` §1 | same as evalA | `evalA#split_clip#<i>` |
| **§B grounded** | real-engine apply on a name-disjoint fixture session (~37 positives + 20 negatives) | `ui/scripts/evalV2Grounded.mts` (`gradeApply`, `ui/scripts/lib/groundedApply.mts`) | n/a (fixed intent list in the script) |

evalA/frozen300/diag_floor4 all go through the **same** verifier
(`ui/src/gepa/metric.ts::evaluate`/`scoreReply` — clean-apply × `fairRecall`
gold-command-name recall). §B is a structurally different check: it actually
executes the model's commands against a real headless `Mosh --run-script`
engine and grades whether the apply came back clean.

**None of these eval files are checked into git.** `service/sft/.sft-data/` is
gitignored (`.gitignore:64`) and does not exist in a fresh worktree/clone — see
§5 below for how to get or rebuild each one.

## 1. One-time setup

```sh
service/sft/setup-sft.sh          # creates ~/Library/Mosh/venvs/sft (mlx-lm), writes service/sft/.sft.env
source service/sft/.sft.env       # exports SFT_PY (the venv's python)
```

Apple Silicon only — `setup-sft.sh` hard-fails on non-arm64-macOS
(`service/sft/setup-sft.sh:30`). The venv lives **outside** the repo/iCloud at
`~/Library/Mosh/venvs/sft` (override with `MOSH_VENVS_DIR`) — see the script
header for why (iCloud silently evicted an earlier in-tree `.venv` twice).
Re-running `setup-sft.sh` is cheap (it just re-validates unless `--reinstall`
is passed).

You also need the `ui/` Node toolchain already installed (`npm ci` in `ui/`)
since every eval leg runs through `tsx`/`npx tsx`.

## 2. Serving discipline (read this before serving anything)

Three permanent rules, each burned in by a real incident:

1. **Fuse first, never trust `--adapter-path` serving.** `mlx_lm.server
   --adapter-path <dir>` has, in this program's history, silently served BASE
   weights while still answering `/v1/models` correctly — see
   `docs/bench/PROGRAM_STAGE1_2026-07.md` "Serving-trap #4 — CORRECTION". Always
   `sft_cli.py fuse` to a standalone dir and serve *that*.
2. **Weight-check the fused shard before trusting it.** Compare
   `shasum -a 256` of the base's last shard vs the fused dir's last shard —
   they MUST differ (the LoRA landed); compare shard 1 — for a last-N-layer
   LoRA it should equal base. `service/sft/GATE_READ_r3.md` has the exact
   snippet; `service/sft/run-gate-r4.sh:118-126` is a scripted version.
3. **ONE mlx process at a time.** MLX/Metal does not share the GPU well
   across processes on this Mac — training, serving, and the SA3 service all
   contend for it. `service/sft/TRAINING_HANDOFF.md` states this as the
   standing rule; `run-gate-r4.sh` itself refuses to start if any `mlx_lm`
   process is already alive (`find_mlx_proc`, line 92-97).
4. **Check the served model id before trusting a reply.** `mlx_lm.server`
   does NOT ignore the request's `model` field — a mismatch returns EMPTY
   content, which then scores as a false failure, not an error. Confirm with
   `curl -s http://127.0.0.1:8080/v1/models` and use that exact `id` (README
   §4 calls this out explicitly).

## 3. Fuse → serve

```sh
cd service/sft && source .sft.env
BASE=<path to the mlx 4-bit base you trained against>   # e.g. ~/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit
ADAPTER=.adapters/<your-adapter-name>                    # e.g. .adapters/a3b-r5-cuda-pull or a local .adapters/a3b-r6
FUSED=.fused/<your-adapter-name>

"$SFT_PY" sft_cli.py fuse --model "$BASE" --adapter "$ADAPTER" --out "$FUSED"

# weight-check (§2.2)
B4=$(shasum -a 256 "$BASE"/model-*-of-*.safetensors | tail -1 | awk '{print $1}')
F4=$(shasum -a 256 "$FUSED"/model-*-of-*.safetensors | tail -1 | awk '{print $1}')
[ "$B4" != "$F4" ] || { echo "FAIL: last shard == base — fuse produced base weights"; exit 1; }

# serve
"$SFT_PY" -m mlx_lm.server --model "$FUSED" --port 8080 &
SVID=$!
sleep 20
curl -fsS http://127.0.0.1:8080/v1/models   # note the exact "id" — you need it below
```

Port **8080** is the convention used by every gate read in this repo
(`README.md` §4, `GATE_READ_r3.md`, `run-gate-r4.sh`) — nothing enforces it,
it is just what every documented command below assumes.

## 4. Run the three legs

All three commands below run from `ui/`, with the model just served at
`http://127.0.0.1:8080/v1`:

```sh
cd ui
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1 OPENAI_API_KEY=local OPENAI_MODEL="<id from /v1/models>" MOSHI_BRAIN_PROVIDER=openai

# §C — frozen300 (comparability anchor)
npm run eval-sft -- --eval ../service/sft/.sft-data/eval-v2/frozen300.test.eval.jsonl \
  --rules plain --no-think --n 300 --tag <your-tag>-C

# §A — evalA (per-command floors; score on ALL 210 rows post-idfix, see §5.1)
npm run eval-sft -- --eval ../service/sft/.sft-data/eval-v2/evalA.eval.jsonl \
  --rules plain --no-think --tag <your-tag>-A

# diag_floor4 — split_clip floor, isolated
npm run eval-sft -- --eval ../service/sft/.sft-data/eval-v2/diag_floor4.eval.jsonl \
  --rules plain --no-think --tag <your-tag>-diagfloor4

# §B — grounded execution (spawns a REAL headless Mosh engine per intent)
npx tsx scripts/evalV2Grounded.mts --model "<id from /v1/models>" --no-think

kill $SVID   # free the mlx slot — required before starting another mlx_lm process
```

Notes on the exact flags (verified by reading the scripts, not assumed):

- `--eval <path>` is **required** for `evalSft.mts` (it exits 1 without it) —
  `ui/scripts/evalSft.mts:94-95`.
- `--n 300` deterministically subsamples via a djb2 hash of each row's `id`
  (`evalSft.mts:99-105`) — same seed logic every run, so re-running `--n 300`
  against the FULL `v3-import/test.eval.jsonl` reproduces the exact same 300
  rows as a pre-built `frozen300` file would, as long as the input file's row
  set is unchanged. If your worktree only has the full test split and not a
  pre-cut `frozen300` file, point `--eval` at the full file and keep `--n 300`.
- `--rules plain` selects `DEFAULT_RULES` (the production prompt) —
  `evalSft.mts:59-65`. `--rules examples` is the few-shot arm, used for the
  §P6 substrate-floor read; not what a gate read normally uses.
- `--no-think` **does work** for `evalSft.mts` (§A/§C, diag_floor4) — it sets
  `chat_template_kwargs.enable_thinking:false` on the request
  (`evalSft.mts:144-148`). **It is a documented no-op in
  `evalV2Grounded.mts` (§B):** the header comment
  (`ui/scripts/evalV2Grounded.mts:19`) advertises `--no-think`, but the
  script's only `callBrain(...)` call (line 159) never threads an `opts`
  object through, so the flag is silently ignored there. Don't spend time
  debugging why a thinking model's §B replies are slower/verbose than its §A
  replies — that's why.
- `--tag` and `--base` are likewise **no-ops in `evalV2Grounded.mts`** —
  grep the file: only `argFlag("rules")`, `argFlag("model")`, `argFlag("bin")`
  are ever read. Older runbooks (including `GATE_READ_r3.md`'s own snippet
  and `run-gate-r4.sh:141`) pass `--base`/`--tag` to this script out of habit;
  they do nothing. The model/base connection for §B comes entirely from
  `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` env (or `.env.local`) via
  `brainConfigFromEnv` (`ui/scripts/lib/realEngine.mts:108-114`) — `--model`
  only overrides the model id on top of that.
- `evalV2Grounded.mts --bin <path>` picks which `Mosh` binary the grounded
  apply runs against; if omitted, `findBin()` picks the **newest** of
  `../build-macos-arm64-release/…/Mosh`, `../build-macos-arm64/…/Mosh`, or
  `/Applications/Mosh.app/…/Mosh` by mtime (`realEngine.mts:41-56`) — a stale
  build silently wins if it happens to be newer. Pass `--bin` explicitly for a
  reproducible gate read, exactly as `GATE_READ_a3b-r5-cuda.md`'s honest
  caveat about §B binary provenance recommends.
- Output files: `evalSft.mts`/`--replies` writes
  `eval_results.<tag>.json` **next to the `--eval` file**
  (`evalSft.mts:176-177`); `evalV2Grounded.mts` writes
  `~/mosh-bench-artifacts/eval-v2/sectionB.<model-id-sanitized>.<rules>.json`
  (`evalV2Grounded.mts:22,190-191`) — a fixed location, not next to the eval
  file.

## 5. Getting or rebuilding the eval files

`service/sft/.sft-data/` is entirely gitignored — there is no committed copy
of `evalA.eval.jsonl`, `frozen300`, or `diag_floor4.eval.jsonl` in this repo.
Historically these lived on the owner's Mac (and durable copies were archived
to `~/Library/Mosh/work/gate/rerun-evals/` per `GATE_READ_a3b-r5-cuda.md`).
If you don't already have them locally:

### 5.1 evalA
Build (or repair) via `ui/scripts/buildEvalV2A.mts`:
```sh
cd ui && npx tsx scripts/buildEvalV2A.mts \
  [--synth ../service/sft/.sft-data/synth] \
  [--held ../service/sft/.sft-data/v3-import/test.eval.jsonl] \
  [--out ../service/sft/.sft-data/eval-v2/evalA.eval.jsonl] [--per 6]
```
**Use the post-idfix file, not a pre-2026-07-10 copy.** 29/210 rows in the
original evalA carried real-engine ids the mock could never resolve — repaired
by `--repair` (`buildEvalV2A.mts` header, `PROGRAM_STAGE1_2026-07.md` §P9
amendment 1). The registered post-fix sha is
`d68ec63696ee1e88c2bb39c7ff21ae98e1dca4b60d9b762a680b33ac4019c911` (210 rows).
**Every pre-fix floor read on `assign_sample` / `create_render_layer` /
`reject_render` / `rename_track` / `set_note` / `set_track_type` /
`suggest_next_line` / `load_drum_kit` / `remove_track` / `set_track_mute` /
`set_track_solo` / `set_track_volume` / `bypass_plugin` / `render_layer` /
`arm_track` / `set_track_pan` carried a fixture ceiling below 1.0** — don't
compare a fresh read on those families against a pre-idfix number (§P9
amendment 1, "RE-BASELINE").

### 5.2 frozen300 (§C)
This is a **deterministic `--n 300` subsample** of the frozen v3 test split
(`v3-import/test.eval.jsonl`, sha `1868ed31…f9d7a2c`, pinned in
`docs/bench/PROGRAM_STAGE1_2026-07.md` §P5) — not a separately-authored file.
If you have `v3-import/test.eval.jsonl`, just point `evalSft.mts --n 300` at
it; if a `frozen300.test.eval.jsonl` copy already exists, using it directly
(no `--n` flag) is equivalent, since the 300-row selection is stable.

### 5.3 diag_floor4
**No build script exists in this repo for this file.** It was hand-curated
during the r4 harness-bug investigation (`docs/bench/P1_SPLIT_CLIP_DIAGNOSIS_2026-07-09.md`,
`service/sft/R4_RERUN_AMENDMENT.md` §1) by extracting evalA's `split_clip`
family (`evalA#split_clip#0..5`) into its own 19-row file and repairing two
degenerate fixture rows (`#4`/`#5` asked to split a [0,3]-second clip at 4
seconds — impossible as written; the fixture clip was extended). The
registered sha is `6488483a7518abae…` (19 rows, post-fixture-fix). If you
don't have a copy: ask for the archived file (paths cited in
`GATE_READ_a3b-r5-cuda.md`), or reconstruct it by filtering `evalA.eval.jsonl`
for ids matching `evalA#split_clip#*` and applying the fixture fix described
above — the eval-set anti-gaming rule (§P4) means you should NOT edit these
files casually; treat any hand-reconstruction as a new pre-registration, not
a silent swap-in.

### 5.4 §B fixture
`evalV2Grounded.mts` builds its own session fixture from `SETUP` in the file
itself (`ui/scripts/evalV2Grounded.mts:37-49`) via a real `Mosh --run-script`
call — nothing to fetch; it self-constructs on every run. The frozen artifact
is only the **intent list + grading**, sha-pinned at
`f415b1f41047d84b65a23c66d370dfaff5e9fccdf3f5da9b45a60a431c09bc27`
(`PROGRAM_STAGE1_2026-07.md` WP-7 FREEZE row) — i.e. don't edit the `INTENTS`
array without re-registering.

## 6. Latency bench (bonus leg, not a gate leg)

```sh
# 1. dump real rendered prompts from an eval file (no live model needed):
cd ui && npm run eval-sft -- --eval ../service/sft/.sft-data/eval-v2/evalA.eval.jsonl \
  --rules plain --no-think --dump ../service/sft/evalA.prompts.jsonl

# 2. bench against the served model:
cd ../service/sft && source .sft.env
"$SFT_PY" bench_serve_latency.py --prompts evalA.prompts.jsonl \
  [--base http://127.0.0.1:8080/v1] [--model default_model] [--n 30] \
  [--max-tokens 2500] [--tag <name>] [--out results.json]
```
(`--base`/`--model`/`--tag` DO work here — this is a plain Python `argparse`
script, unlike the two `.mts` scripts above.) Bar: **warm median < 2 s**
(`service/sft/LOCAL_SERVE_READ_a3b-r5-mlx.md` §"Bar (b)"). Request #1 is
reported separately as a cold-prefill number and should not be averaged into
the warm median.

## 7. Troubleshooting

- **`/v1/models` returns an HF-cache id, not your fused path.** You served
  `--adapter-path` instead of a fused dir, or fusing silently failed — re-run
  the weight-check in §2.2/§3; do not trust the identity probe alone
  (`PROGRAM_STAGE1_2026-07.md` "Serving-trap #4").
- **All replies score 0 / come back empty.** Almost always `OPENAI_MODEL`
  doesn't match the served `id` exactly — `mlx_lm.server` does not ignore a
  mismatched `model` field (§2.4). Re-check `curl .../v1/models`.
- **A `split_clip` row fails with "split point outside clip" on a row that
  looks correct.** Confirm you're on the fixture-repaired `diag_floor4`
  (§5.3) or the post-idfix `evalA` (§5.1) — the pre-fix fixtures had two
  genuinely-unsatisfiable rows (`P1_SPLIT_CLIP_DIAGNOSIS_2026-07-09.md`).
- **A row rejects a correct-looking `add_midi_clip`-derived time.** Confirm
  you're running against a harness that has PR #286's mock length-fidelity
  fix (`R4_RERUN_AMENDMENT.md` amendment 5) — the mock used to hardcode
  MIDI-clip length to 4s regardless of the `length` arg.
- **`mlx_lm.server` won't start / hangs.** Something else already holds the
  GPU — check `pgrep -fl mlx_lm` (the exact check `run-gate-r4.sh` does before
  serving) and kill it, or wait for training to finish. Do not run this
  alongside a live SFT training job or the SA3 service.
- **`npm run eval-sft` complains `--eval <test.eval.jsonl> required`.** The
  flag has no default; you must always pass `--eval`.
- **§B (`evalV2Grounded.mts`) throws `need OPENAI_BASE_URL / OPENAI_API_KEY /
  OPENAI_MODEL`.** Those three env vars (or `ui/.env.local`) are required —
  `--base`/`--tag` will NOT set them (§4 notes above); only `--model`
  overrides the model id, and only on top of an already-valid env.
- **§B "setup produced an empty snapshot" error.** The `--bin` Mosh binary
  either isn't headless-clean or `--run-script` failed silently — try passing
  `--bin` explicitly at a known-good build.

## 8. Reading a result

- `cleanApply` in each `eval_results.*.json` is the mean score (0–1);
  `deferrals` is how many rows the model declined to answer at all — both are
  printed at the end of each `eval-sft` run alongside a per-family table
  (worst family first).
- Per-command floor reads use the **per-family rollup**
  (`evalSft.mts::perFamilyRollup`, keyed on the `evalA#<command>#<i>` id
  pattern) — this ONLY appears for evalA/diag_floor4, never for frozen300
  (corpus-hash ids don't match the pattern, by design — §C is a comparability
  anchor, not a floor surface).
- `evalV2Grounded.mts`'s summary reports `groundedCleanApply` (clean ÷
  positives) and `negativeDeferRate` (deferred-ok ÷ negatives) separately —
  the registered gate leg is `groundedCleanApply ≥ 0.85`; negative-defer is
  tracked, not gating (`PROGRAM_STAGE1_2026-07.md` §P4).
