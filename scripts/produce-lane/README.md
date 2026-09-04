# produce-lane — headless overnight driver

Runs the produce lane (docs/POSTMORTEM-2026-09.md's approved direction)
against a REAL, running Mosh app, unattended, overnight: launch the app with
the design-lab companion feed on, drive N produce-lane tasks over its HTTP
surface, capture a `.mosh` + loop-length `.wav` per run, replay a
sound-matched twin against the owner's own sample kit, and assemble a morning
audition package. See the top-level plan (W3.2/W3.4/W3.5) for the full design
rationale; this file is the operational reference — what each script does,
its CLI, and the exact command sequence to run.

## Why the companion server, not a bench replay

`Mosh --run-script` (the headless engine `ui/scripts/lib/realEngine.mts` uses
for benches) spawns a FRESH, isolated, no-audio engine per invocation — it
cannot produce a real `.mosh` file the owner reopens, or a real rendered
`.wav` under the session. The overnight driver instead talks to the SAME
`RemoteCompanionServer` HTTP surface (port 47873 by default) the phone
controller and design-lab feed use: `POST /command` runs `moshOps->execute`
on a REAL running app's message thread, `POST /snapshot` returns the real
WebView snapshot. `ui/scripts/produceReplay.mts` still uses `--run-script`,
but only for its REPLAY role (a captured program, brainless, isolated) — see
its own header for why that's the right tool there and the wrong tool for a
live run.

## Files

| File | Role |
|---|---|
| `overnight.sh` | The orchestrator: preflight guard → launch the app → watchdog → N produce runs (+ replay legs) → package → restore the owner's project → quit. |
| `launch-app.sh` | Starts ONE Mosh app instance with the design-lab feed + produce-lane brain env. Prints `pid=… port=… token_file=…`. |
| `guard.sh` | Three-state resource gate (`0` ok / `1` wait / `2` stop) on free memory %, swap MiB, Data volume free GiB — same metrics as `scripts/auto-loop/memory-preflight.sh`, split into "retry" vs "hard stop." Read-only; safe to run anytime, app or no app. |
| `watchdog.sh` | Liveness loop for one app pid: RSS sampling (advisory events at 12GiB/16GiB), `/health` + `mosh-log.jsonl`-growth stuck detection (SIGTERM → 20s → SIGKILL → relaunch). `--once` runs a single cycle for testing. |
| `build-package.py` | Assembles the morning package from `runs/*/run.json`: A/B WAV symlinks, `audition.html`, `verdict.json` template, `MORNING-REPORT-produce.md`. Pure filesystem — no app, no network. |
| `../../ui/scripts/lib/companionClient.mts` | HTTP client for `/command`, `/snapshot`, `/events`, `/health`, with the companion-timeout → `mosh-log.jsonl` fallback (see its header); `wavRmsDbfs()` for the silent-render check. |
| `../../ui/scripts/produceLiveRun.mts` | ONE produce-lane run against the live app: `new_project` → W2.5 preflight (real sounds before the model's first turn) → the agentic loop with the SAME brain HTTP path the app uses → `save_as` + `export_audio` → `run.json`/`transcript.json`/`program.jsonl`. |
| `../../ui/scripts/produceReplay.mts` | Brainless replay of a captured `program.jsonl` — plain replay, `--swap lab=<manifest>` (sound-matched twin), or `--fixture` (the corrected reference beat's own notes on Mosh's own sounds). |

## Run safety (read before running anything)

- **Never `kill -9`** a Mosh instance except as the LAST resort of a documented
  SIGTERM → wait → SIGKILL ladder (`launch-app.sh`'s shutdown, `watchdog.sh`'s
  stuck-recovery, `overnight.sh`'s cleanup trap all follow this).
- **Single instance per launch.** `launch-app.sh` refuses to start if ANY
  `Mosh.app/Contents/MacOS/Mosh` process is already running — including the
  owner's `/Applications/Mosh.app`. If that's up, leave it alone; do not run
  the overnight batch until it's not, or point `--bin` at nothing (there's no
  override — this refusal is deliberate).
- **Never** touch `com.emilio.*` LaunchAgents, `mlx_lm.server` processes, or
  Codex/ChatGPT processes. `watchdog.sh`/`overnight.sh` only ever signal the
  ONE pid they themselves launched.
- **Memory guard before every run**, not just once at the top — `overnight.sh`
  calls `guard.sh` before EACH run in the loop, waits 60s×10 on `wait`, stops
  the whole batch after 3 consecutive waits, and stops immediately on `stop`.
- **Budgets**: `--max-runs` (default 8), `--stop-at` (default `07:30`,
  next occurrence of that wall-clock time), `--max-brain-stalls` (default 3 —
  shim AND OpenRouter both failing 3 runs in a row stops the batch),
  `--openrouter-cap-usd` (default 15, summed from every `run.json`'s
  `costUsd`), `--max-disk-mb` (default 500, `du -sk` of the whole package
  dir), and a per-run hard timeout (default 720s, `--per-run-timeout-s`).
- **The app is ALWAYS quit cleanly on the way out** — `overnight.sh`'s `EXIT`
  trap restores the owner's last project (`~/Library/Mosh/session/
  last-project.json`) via `open_project`, then SIGTERMs the app, regardless of
  which exit path the batch took (ran out of runs, hit `--stop-at`, guard
  stop, brain-stall stop, or a Ctrl-C).
- **No secrets printed.** The lab token is random per launch
  (`MOSH_LAB_TOKEN=$(uuidgen)`), written to a mode-600 file
  (`$PRODUCE_AB_DIR/.lab-token`), never echoed to a log. `OPENROUTER_API_KEY`
  is read from the environment only.

## The exact sequence

All commands run from the repo root unless noted. `$PRODUCE_AB_DIR` defaults
to `~/Library/Mosh/produce-ab/<today's date>` (override with
`MOSH_PRODUCE_AB_DIR`).

### 0. Sanity-check everything without touching the app

Every script below has a `--dry-run` (or, for `guard.sh`/`watchdog.sh --once`,
a mode that never spawns/launches anything):

```sh
scripts/produce-lane/guard.sh                                    # live metrics, read-only
scripts/produce-lane/overnight.sh --ask "..." --dry-run           # prints the resolved plan
cd ui && node_modules/.bin/vite-node --mode development scripts/produceLiveRun.mts \
  --dry-run --ask "..." --run-id t1 --out-dir /tmp/x --token abc
cd ui && node_modules/.bin/vite-node --mode development scripts/produceReplay.mts \
  --program <some program.jsonl> --out-dir /tmp/y --run-id t1 --dry-run
python3 scripts/produce-lane/build-package.py --produce-ab-dir <a runs/ tree> --dry-run
```

`produceLiveRun.mts`/`produceReplay.mts` **must** run under
`ui/node_modules/.bin/vite-node --mode development`, never `tsx` or plain
`node` — see `produceLiveRun.mts`'s header for why (`ui/src/store.ts` throws
`window is not defined` outside a WebView; these scripts deliberately avoid
importing it).

### 1. Smoke — mock brain, no tokens spent

Confirms the whole pipe end-to-end (companion HTTP, the undo bracket, the
W2.5 preflight if landed, `save_as`/`export_audio`, the RMS check) without
calling a real brain:

```sh
scripts/produce-lane/launch-app.sh                 # prints pid=… port=… token_file=…
cd ui && node_modules/.bin/vite-node --mode development scripts/produceLiveRun.mts \
  --url http://127.0.0.1:47873 --token-file <token_file from above> \
  --ask "produce a dark jerk trap beat at 148 in D minor" \
  --run-id smoke1 --out-dir "$MOSH_PRODUCE_AB_DIR/runs/smoke1" \
  --mock-brain --hard-timeout-ms 120000
```

Check: `runs/smoke1/run.json` has `outcome` (mock brain parks on most asks —
`need_user` is an OK smoke result, it proves the pipe works; a `done`/`budget`
with tracks laid is the strong result), `mix.wav` exists and is > 0 bytes,
`produce-smoke1-*.mosh` exists. Then quit the app cleanly (SIGTERM the pid
from `launch-app.sh`'s output, wait for it to exit — never `-9`).

### 2. First live run — a real brain

Same as above without `--mock-brain`, letting the shim (`claude -p`, primary)
/ OpenRouter (fallback) do the actual production pass — this is the SAME
brain HTTP path the app itself uses (`OPENAI_BASE_URL=http://127.0.0.1:8788/v1`
etc., set by `launch-app.sh`'s env block; **the shim must already be running**
— `bash service/brain_shim/run-shim.sh`, W1.3, before this step):

```sh
scripts/produce-lane/launch-app.sh
cd ui && node_modules/.bin/vite-node --mode development scripts/produceLiveRun.mts \
  --url http://127.0.0.1:47873 --token-file <token_file> \
  --ask "produce a dark jerk trap beat at 148 in D minor" \
  --run-id live1 --out-dir "$MOSH_PRODUCE_AB_DIR/runs/live1"
python3 scripts/produce-lane/build-package.py --produce-ab-dir "$MOSH_PRODUCE_AB_DIR"
open "$MOSH_PRODUCE_AB_DIR/audition.html"
```

### 3. The actual overnight batch

```sh
scripts/produce-lane/overnight.sh \
  --ask "produce a dark jerk trap beat at 148 in D minor" \
  --max-runs 8 --stop-at 07:30 --sonnet-runs 5
```

This launches the app itself (do not run `launch-app.sh` first), runs up to 8
produce-lane tasks (seeded 1..N so `ui/src/agent/loop/drumPalette.ts`'s
deterministic picker varies the drum kit/Vital presets per run — runs 1-5
Sonnet, 6-8 Opus by default), replays each run's `--swap lab=<manifest>`
sound-matched twin (best-effort — skipped, not failed, if
`~/Library/Mosh/lab-manifests/15drtt-jerk-r0.json` or
`ui/src/agent/loop/produceTemplate.ts` isn't available), replays the W2.7
fixture once, builds the package, restores the owner's last project, and
quits the app. Read `$MOSH_PRODUCE_AB_DIR/MORNING-REPORT-produce.md` first.

## A/B reference facts (W3.3)

- `A-release-<slug>.wav` — `build-package.py` symlinks
  `~/Documents/release-f0a3f525-final.wav` (a Mosh export of the earlier
  release, verified byte-identical in size to a `session/exports/mix-*.wav` —
  **not** a Live bounce; the package/report label it "provisional").
- `A-flywheel.wav` — the corrected reference beat exists ONLY as the Live set
  (`cATHARDIC_trap_r0_gen001.als`) and Live is off-limits overnight, so this
  file is NEVER fabricated — `build-package.py` just notes its absence and the
  morning report asks the owner to bounce it by hand.
- `B-mosh-<runId>.wav` — the produce-lane's own render (palette-v2 sounds).
- `B-labkit-<runId>.wav` — same run's notes, replayed through the owner's lab
  kit (`produceReplay.mts --swap`) — the sound-matched second render.
- `B-reference-notes-moshsounds.wav` — the W2.7 fixture (the corrected
  reference beat's OWN notes) replayed on Mosh's own sounds — a third A/B
  point isolating "notes" from "sounds."

## Owner morning steps (cannot be automated — see MORNING-REPORT-produce.md)

Export `A-flywheel.wav`; open `audition.html`, listen through every pair,
rate + note each candidate; "Copy verdict" and paste over `verdict.json` (or
edit it by hand); run `scripts/produce/capture-correction.py` (W2.8, once it
exists) to turn a filled `verdict.json` into the first
`docs/produce-corrections/<id>.meta.json`; note which Vital presets earned a
veto; decide whether to merge.
