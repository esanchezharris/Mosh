# SKILL: Operating the Mosh data flywheel from the CLI

For any tool-using agent (Claude Code et al.) driving Mosh's harness,
extraction, store, eval, and replication ladder autonomously. Every command
emits structured JSON; humans get the same output. Run everything from the
repo root.

## Environment (once per shell)

```bash
source ~/.config/mosh/env     # GEMINI_API_KEY + MOSH_AGENT_MODEL (env-only; never in repo)
APP=build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
```

Gotchas that bite:
- **Port 8770**: a stale generative service wedges runs. Before judging a
  flaky failure: `lsof -ti:8770 | xargs kill`.
- **Session isolation**: parallel/headless runs MUST set `MOSH_SESSION_DIR`
  (and usually `MOSH_GAP_LEDGER`) to throwaway dirs, or they fight over
  `~/Library/Mosh/session`.
- **`MOSH_KEEP_SESSION=1`** makes successive headless runs continue one
  session (multi-invocation scenarios, collab tests).
- Headless runs auto-isolate identity; `MOSH_IDENTITY_FILE` overrides.
- Rebuild after C++ changes: `cmake --build build-macos-arm64 --target Mosh`.

## The harness (deterministic replay — the heart)

```bash
MOSH_SESSION_DIR=/tmp/s "$APP" --harness job.json --harness-out result.json
# job.json: {"ops": [MoshIR...]} | {"commands": [{command,args}...]}
#   + optional: "projection": true, "bounce": true, "timeout_s": 120,
#               "state_before": "<edit path>", "tutorialId": "..."
# result: {ok, state_hash, counts{executed,unsupported,failed}, results[],
#          projection?, bounce{file, audio_md5}?}   exit 0/1/2/124
```
Same (ops, seed) → same `state_hash` on every machine. `audio_md5` is the
byte-identity check (whole-file md5 includes a wall-clock BWAV chunk — don't
use it).

## Validate IR / inspect failures

```bash
python3 moshir/validate.py ops.json        # exit = number of invalid ops
python3 moshir/validate.py --self-test     # 64 checks
```
Harness `results[i]` carries `unsupported` (gap-ledgered finding) vs `error`
(real failure) — gaps land in `$MOSH_GAP_LEDGER`.

## Replication ladder (Stage 13 — the main loop)

```bash
python3 -m flywheel.replicate.ladder attempt trap-03   # autonomous attempt
#  → runs/replication/trap-03/{attempt.json, projection.json, work/{source.mp4,
#    transcript.json, frames/*.jpg + index.json}}
# CORRECTION PASS (you, the agent): read attempt.json + transcript, VIEW the
# keyframes, write runs/replication/trap-03/corrected-steps.json:
#   {"steps": [{"step_id", "narration", "narration_ts", "ops": [...]}],
#    "corrections": [{"root_cause": "asr|segmentation|inference|vocabulary|claims",
#                     "what": "...", "lesson": "..."}]}
python3 -m flywheel.replicate.ladder rescore trap-03   # replay + delta-score + store
python3 -m flywheel.replicate.ladder status            # scoreboard
```
Distill every correction into ONE of: `flywheel/gepa/program/v0/reflections.md`
lesson · code/prompt fix · verified exemplar (`exemplars.jsonl`) · gap-ledger
entry. Tutorial ids/order: `flywheel/tutorials.json` (held-out ones REFUSE).

## Extraction / eval / GEPA / store

```bash
python3 -m flywheel.extract.pipeline --url URL --provider gemini   # or --fixture
python3 -m flywheel.gepa.eval --provider gemini [--tasks 4|all]    # 24-task bar
python3 -m flywheel.gepa.gepa --provider gemini --reflect-provider claude ...
python3 -m flywheel.store.import_session <session_dir> [--allow-no-consent]
python3 -m flywheel.store.export_jsonl --db PATH
python3 -m flywheel.store.replay_check <traj_id> --db PATH --app "$APP" --strict
python3 -m flywheel.envgen.tutorial_pipeline --db PATH --out runs/envs
```

## Scoring primitives

```python
from flywheel.verify import delta            # session-delta scorer
d = delta.delta(proj_before_json, proj_after_json)
delta.score(d_attempt, d_oracle)             # {entity_f1, magnitude, composite}
from flywheel.verify import l3               # CLAP (judges venv sidecar)
l3.clap_cosines([(a_wav, b_wav)]); l3.verdict(cos, genre)
```

## Standing batteries (run before claiming anything works)

```bash
"$APP" --selftest        # 148/148 ×3 expected, 0 assertions
"$APP" --selftest-undo   # 18/18
scripts/harness-conformance.sh && scripts/flywheel-store-test.sh \
  && scripts/collab-sync-test.sh && scripts/agent-smoke-test.sh \
  && scripts/extract-smoke-test.sh
```

## Reviewing IN Mosh (the point of the product)

```bash
python3 -m flywheel.replicate.ladder open trap-03   # materialize + launch the app
```
The corrected session lands in `~/Library/Mosh/session` (old one backed up),
the 2-bar pattern loops on play, and the always-on SessionRecorder turns any
tweak made in the app into correction data — import it afterwards with
`flywheel.store.import_session` or read `~/Library/Mosh/session/trajectory.jsonl`.

## Stage 15 — real-DAW commands

`set_tempo {bpm}` / `set_time_sig {numerator,denominator}` now have UI
(click the BPM / time-sig chips in the transport). New commands:
`set_metronome {on,gain?}` (playback aid — never recorded/synced/hashed),
`set_master_volume {db}` (synced; NOT hashed — see the hash-v2 note in
PHASE0_EXIT.md), `duplicate_clip {clipId,startSeconds?}` (lifts to
clip.duplicate — ledger entry retired), `move_track {trackId,beforeTrackId?}`,
`choose_file {title?,wildcard?}` (native dialog; headless tests set
MOSH_CHOOSE_FILE to bypass it). Keyboard in-app: Space play/stop · ⌫ delete
clips · ⌘Z/⌘⇧Z undo/redo · ⌘D duplicate · +/− zoom.
