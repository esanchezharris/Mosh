# HANDOFF — DAW hardening pass (2026-06-11)

*Written for the next agent/tool taking over (OpenAI Codex or otherwise). The
mission for this phase: **intensive testing, verification, and hardening of
the DAW itself** — UI interaction quality, edge cases, real-world abuse. No
new features unless a bug demands one. The agent-training / flywheel work is
PAUSED (see "The paused flywheel" below) and resumes only when the owner is
100% confident in the DAW.*

---

## What this is

Mosh: a JUCE 8 / Tracktion Engine hybrid DAW (macOS arm64 ONLY) with a React
WebView UI, plus a data-flywheel for training a producer agent (paused).
Read `CLAUDE.md` (repo root) first — it is the build manifest and the source
of truth for what exists; `docs/DAW_CAPABILITY_AUDIT.md` is the product
capability truth. Specs live in `00…07_*.md` + `mosh-phase0-spec.md`.

State at handoff: branch `claude/laughing-grothendieck-22549c`, 33 build
stages complete, every standing battery green. The DAW is feature-complete
for everyday production **but most of it is machine-verified only** — the
owner's first real session immediately surfaced rough edges. That gap is
this phase's whole job.

## Build + verify (the contract)

```sh
# Build (NEVER --target Mosh alone — UI staging is a stamp rule on the
# default target; --target Mosh ships a STALE web bundle):
cmake --build build-macos-arm64

# The full battery — ALL must pass before any merge:
APP=build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
lsof -ti:8770 | xargs kill   # orphaned generative service trap (see below)
$APP --selftest              # 289/289 ×3 runs, AND zero "JUCE Assertion" lines
$APP --selftest-undo         # 18/18
$APP --live-audio-smoke      # 32/32 (real CoreAudio; add MOSH_SMOKE_RECORD=1 for mic phase)
scripts/harness-conformance.sh   # 11
scripts/flywheel-store-test.sh   # 9
scripts/collab-sync-test.sh      # 18
scripts/agent-smoke-test.sh      # 5
scripts/extract-smoke-test.sh    # 5
python3 moshir/validate.py --self-test   # 73
(cd build-macos-arm64 && ctest)          # Catch2
```

**The bar:** selftest must pass 3× identically with ZERO assertion lines and
no leak reports. Measure each run from ONE invocation (don't grep two
separate runs for two metrics — they're different runs).

### Verification levers
- `Mosh --selftest` (`src/app/SelfTest.cpp`) — headless command-surface
  checks. Add a check per bug fixed: reproduce → fix → check stays.
- `Mosh --harness job.json --harness-out r.json` — scripted replay
  (`{ops:[IR]}` or `{commands:[native]}`); deterministic state hash out.
- `Mosh --live-audio-smoke` — actual audio at the master tap.
- In-app verification: macOS-automation clicks + `screencapture -x` +
  reading the screenshot. Build the UI unminified for readable JS stacks:
  `cd ui && npx vite build --minify false`.

## Invariants — do not break these

1. **One mutation path**: every user-visible change is a MoshOps command
   (`src/moshops/MoshOps.cpp::execute`). UI never mutates the engine
   directly; pure view state (zoom/selection/drawers) never crosses the
   bridge. IR/recorder/collab sit ABOVE MoshOps via hooks.
2. **One undo system**: Tracktion's UndoManager under MoshOps. One undo
   transaction per user gesture (a drag = one undo step). Known semantic:
   parameter/fader moves are NOT undo transactions (DAW convention).
3. **Canonical state hash is v2** (`src/state/StateHash.cpp`, `schema: 2`).
   Any NEW hashed field invalidates stored trajectory hashes → batch future
   fields into one v3 bump + run `python3 -m flywheel.store.restamp_hashes`.
   Never hash: live values of automated params (the curve is canonical),
   wall-clock, sample rate, EditItemIDs (use structural ordinals), file
   paths (use content MD5).
4. **MoshIR is FROZEN at v0.3** (48 ops; `moshir/moshir-0.3.schema.json` ↔
   `src/moshir/MoshIRVocab.h` in lockstep, Catch2-enforced). No vocabulary
   changes without an explicit owner call.
5. **Recorder/collab exclusion lists** (`src/moshir/SessionRecorder.cpp
   isReadOnly`, `src/collab/CollabEngine.cpp isSyncable`): machine-local /
   read-only / playback-aid commands are excluded; every NEW command must be
   classified into these lists deliberately.
6. **Visible-index plugin space**: all plugin index args/results = the
   pluginList minus meter taps; meters pinned to chain end (`ensureMeterLast`).
7. **Plugin/meter lifetime**: graph nodes hold refcounted `Plugin::Ptr`, so
   plugins OUTLIVE their edit — `LevelMeasurer::Client`s must unregister
   through a held `Plugin::Ptr` on every path or it's a UAF.
8. **Render/proxy jobs**: TE background jobs hop to the message thread via
   `callBlocking`; in headless bursts nothing pumps → `MoshEngine::
   drainRenderJobs()` runs in every edit-swap path and after
   `set_clip_reversed`. Any new op that spawns engine render work needs the
   same treatment.
9. **Device policy**: never default to a virtual sink (BlackHole etc.);
   machine-local pref in `~/Library/Application Support/Mosh/audio-device.json`.
10. **macOS arm64 only.** No cross-platform paths.
11. **Non-ASCII (em-dash, §, ·) in C++ string LITERALS asserts** in
    juce_String — ASCII only in literals; comments are fine.
12. **Secrets**: `GEMINI_API_KEY` lives ONLY in `~/.config/mosh/env` (600).
    Grep staged diffs before pushing:
    `git diff --cached | grep -iE "AQ\.|GEMINI_API_KEY=|ANTHROPIC_API_KEY="`.

### Known traps (each cost real debugging time)
- Orphaned generative service squats port 8770 → kill before measuring.
- `Renderer::Parameters.tracksToDo` empty = renders NOTHING (the field
  comment claims empty=all; it lies). Always set bits.
- Stock `te::UIBehaviour::runTaskWithProgressBar` is a NO-OP + assert —
  `MoshUIBehaviour` (MoshEngine.cpp) runs tasks synchronously.
- Deferred MIDI-device apply calls `clearAllContextDevices()` and kills a
  running transport → settle with `rescanMidiDeviceList()` +
  `runDispatchLoopUntil(150)` after device switches.
- Plugins must be created via `edit.getPluginCache().createNewPlugin` (not
  PluginManager) or `pluginList.indexOf` fails.
- `remove_tempo` remaps edit content positions; in tests prefer undoing the
  insert.
- `MOSH_SESSION_DIR` env isolates parallel/headless instances;
  `MOSH_NO_AUDIO=1` skips CoreAudio.

## The hardening backlog (this phase's work)

The honest gap: stages S14–S31 are **selftest-proven** (command surface,
state, determinism) but most UI interactions had at most one scripted or
visual check. The owner's review session ("playing around with the MIDI
editor") confirms interaction-level bugs exist. Priority areas, roughly in
order of user pain:

1. **Piano roll** (`ui/src/components/PianoRoll.tsx`) — the owner's main
   tool. Stress: marquee vs draw disambiguation, batch drags at edges,
   fold-mode vertical moves, velocity lane, the epsilon note-matching in
   `update_notes` (±0.01 beats — does it misfire on dense chords?), zoom
   extremes, clips spanning tempo changes (the roll assumes the clip's
   local tempo segment).
2. **Arrangement interactions** (`Arrangement.tsx`) — drag/trim/split with
   snap at every zoom; automation lanes (offset math, point drag commit
   races vs snapshot refetch); section strip (drag-create vs click-seek
   conflicts); tempo flags; track drag-reorder slot math with open lanes.
3. **Optimistic-update races** — the UI previews locally then commits and
   refetches on `snapshot_invalidated`; rapid gestures can interleave.
   Audit every preview→commit→refetch path for lost updates.
4. **Engine edge cases** — undo/redo across EVERY new command (only a
   subset has focused undo checks); save/reload with all S24–S29 clip state;
   project switching while playing/recording; collab rebase with new
   command types in the oplog.
5. **Recording** — device unplug mid-record, monitoring while armed,
   count-in interaction with loop mode.
6. **Error surfacing** — many commands fail silently into the error bar;
   the UI should degrade visibly, not mysteriously.
7. **Performance** — long sessions (100+ clips), dense automation, peak
   fetch storms on reload.

Workflow suggestion: pick one area → write failing selftest/harness checks
for each found bug → fix → battery → commit per area, message style as in
`git log` (what + why + the proof).

## The paused flywheel (do not delete, do not advance)

Everything under `flywheel/`, `service/agent/`, `moshir/`, the recorder,
collab, and the store is **frozen but load-bearing** — the batteries cover
it, keep them green. State at pause:

- **Rung 1 (trap-03, BWB Rhythm)**: silver, gold-candidate. The owner made
  in-app corrections on 2026-06-11 (808 pattern rework + hat thinning, 35
  musical steps) — preserved verbatim at
  `runs/replication/trap-03/emilio-corrections-2026-06-11.jsonl` (+ the
  session file beside it). These corrections are NOT yet folded into
  `corrected-steps.json`, NOT rescored, NOT imported to the store. That is
  deliberate — first resume step.
- **Store** (`~/Library/Mosh/flywheel/store.sqlite3`): 3 trajectories,
  hash v2 re-stamped; `tut-trap-03-corrected` replays to MATCH
  (`python3 -m flywheel.store.replay_check --app $APP tut-trap-03-corrected`).
- **Resume sequence** (when the owner says go): fold the correction jsonl
  into the trap-03 corrected steps → `python3 -m flywheel.replicate.ladder
  rescore trap-03` → owner's audio sign-off → flip to gold → first L3 CLAP
  calibration pair → rung 2 (`trap-02`) with per-step multimodal inference
  (the queued system change). Then the owner-fired spends: the GEPA campaign
  and the ~40-tutorial extraction pass (`docs/PHASE0_EXIT.md` has commands).
- The operator manual for the ladder is `docs/SKILL.md`.

## Owner workflow notes

- Open the rung-1 session in the app: `python3 -m flywheel.replicate.ladder
  open trap-03` (launches Mosh on a materialized session; the recorder
  captures tweaks as correction data).
- The Gemini key: `source ~/.config/mosh/env` (never in repo/logs).
- Tutorial source media is processed locally only, never redistributed,
  never stored in the corpus; consent gates corpus entry.
