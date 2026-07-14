# Open Lanes (v3) shell — build handoff

**Status:** Stage 1 in progress. Branch `claude/daw-ui-upgrade-317ab2`. Last verified 2026-07-13
(tsc clean, 110 affected vitest green, live-previewed over the dev mock backend).

This doc is self-contained so any agent (Codex, Claude, etc.) can resume without external context.

## What this is

Porting the winning "Designer Arena" mockup — the **Open Lanes Sequencer** (a loop-first,
inline-lane-editor arrangement) + its **Monument companion** — into a REAL production DAW shell
at `ui/src/v3/`. The mockup source of truth is
`scratchpad/fable-candidates/shell-rail-sequencer.html` and `companion-pro-monument-v3.html`
(under the session scratchpad; not committed). The design language: near-black obsidian,
one sacred lime accent (`#ccff36`), desaturated per-track hues, mono micro-caps, hairline seams,
**progressive disclosure** (surface controls only on hover/focus).

The current **v2 shell** (`ui/src/v2/`) is the PARITY CHECKLIST — everything it does must
eventually be covered by v3. Feature surface: topbar (transport/tempo/key/meter/metronome),
left browser (samples + plugin browser), arrangement (song navigator, section ribbon, ruler,
zoom, track headers, clips), right rail (Moshi card, Inspector tabs Mix/FX/Gen/Lyrics/MIDI/
Warp/Takes, collaborators/video), composer bar.

## Owner decisions (locked)

1. **New shell behind the `uiShell` setting** — `classic | v2 | openlanes`. NOT an in-place
   rewrite of v2. v2 + classic stay as fallbacks. C++ backend byte-identical (swappability gate).
2. **Core loop first, then parity** — ship the judged spine (arrangement + inline editors +
   transport + navigator + composer/Moshi + drag-reorder + reactive bg), then layer the heavier
   surfaces (Inspector, browser, sends, lyrics/FMS, collaborators, warp/takes) stage by stage.
3. **Inline-first editing** — each lane IS its own editor; FULL-zoom is the "see everything"
   escape. **Retire the modal PianoRoll/DrumSequencer in v3** (v2/classic keep them); reuse their
   edit LOGIC inline.
4. **Default stays `v2`** until v3 reaches parity, then flip the schema default to `openlanes`.
   Don't ship users into an incomplete default.

## Architecture / seam

Pure client of the existing seam: `store.exec(command, args)` + the snapshot/events feed — same
as v2/classic. **Reuse LOGIC verbatim, port VISUALS.** No new backend except one command (below).

Key seam facts:
- Shell router: `ui/src/App.tsx` → `resolveShell()` in `ui/src/v2/shellQuery.ts` (now 3-way; dev
  override `?shell=openlanes|v3`). `ui/src/v2/shellFlag.ts` `isV2Active`/`useIsV2` were broadened
  to "any modern shell (v2 OR openlanes)" — the store webrtc gate, Moshi composer-ownership, and
  the settings panel all want that; added `isOpenLanesActive`/`useIsOpenLanes` for v3-only needs.
- Settings: `ui/src/settings/schema.ts` `uiShell` enum has the `openlanes` option (default still
  `v2`). `ui/src/settings/effects.ts` pins `data-skin=mosh` for openlanes too.
- Types: `ui/src/types.ts` — `Snapshot` (l.474), `Track` (l.274), `Clip` (l.143), `Section` (l.434).
  **Clip `start`/`length`/`offset` are SECONDS; MIDI note `start`/`length` are BEATS.**
- Store: `exec`, `transport` (live 30Hz), `selectedTrackId` + `setSelectedTrack(id)` (fires MP
  broadcast/lock — track selection MUST route through the store, never mirrored locally).
- Reusable renderers, EXPORTED from `ui/src/ui/Arrange.tsx`: `ClipWave({peaks,width})`,
  `ClipMidi({notes,width,bs,secToPx})`, `ClipDrumGrid({notes,width,bs,secToPx})`, `isDrumClip`.
  Peaks come from `get_clip_peaks` (async). `ui/src/ui/drumGrid.ts` = `DRUM_LANES`/`STEPS`/
  `buildGrid`/`stepStartBeats`. `ui/src/ui/PianoRoll.tsx` + `DrumSequencer.tsx` = the hit-test →
  command logic to reuse inline. `ui/src/v2/lanes/ClipView.tsx` = drag/trim/split math + gesture
  tables (`ui/src/interaction/*`) + `ui/src/ui/clipDrag.ts` `commitClipDrag`.

## The ONE backend change (Stage 2)

No `reorder_track` / `move_track` MoshOps command exists. Add one — a thin wrapper over the
engine primitive `edit.moveTrack(track, te::TrackInsertPoint(folder, preceding))`, already used
internally at `src/moshops/MoshOps.cpp:2728` and `:3128`. Undoable (`beginTxn` →
`snapshot_invalidated`), Track-scoped in `src/multiplayer/LockManager.cpp`, added to the agent
catalog (`ui/src/agent/commands.ts` + `ui/src/agent/smallModel.ts`),
`docs/02_MOSHOPS_CONTRACT.md`, a `--selftest` check (`src/app/SelfTest.cpp`), and the dev mock
(`ui/src/bridge.mock.ts`). Gate: build + `Mosh --selftest ×3` deterministic (count = baseline +
new checks) + Catch2. This is the ONLY C++ the whole build-out touches.

## Files created so far (`ui/src/v3/`)

- `AppV3.tsx` — shell frame (mounted by App.tsx when `uiShell === "openlanes"`). Boot screen when
  not native; topbar + slim nav band (zoom) + centered slab (ruler + lanes) + left/right dock
  rails + composer pill. Reuses `useKeyboardShortcuts`, `useFileDrop`, `RecoveryNotice`,
  `MissingMediaBanner`.
- `shell.css` — scoped `.v3-shell`, `ol-*` classes, graphite tokens (obsidian bg, lime accent,
  MIN_ED/MAX_ED/COMPACT_H geometry). Material themes (Glass/Dithered/Cream) are a later
  `data-material` axis.
- `TopBar.tsx` — real transport/tempo/key/timesig/metronome via existing commands
  (`set_transport`/`set_tempo`/`set_key`/`set_time_signature`/`set_metronome`), AI pill,
  avatar cluster, invite (`mpCreateSession`), overflow (undo/redo, theme, switch to v2/classic).
- `Lanes.tsx` — chrome-off lanes: per-track hue from `palette.ts`, name + M/S revealed on
  hover/focus, click-to-focus accordion (`useOpenLanes.focusIdx`), compact clip preview canvas
  (clips as positioned hue blocks; ResizeObserver-driven so it draws at the correct width).
- `palette.ts` — `trackHue(index)` desaturated OKLCH-ish ramp.
- `state.ts` — `useOpenLanes` zustand slice: `focusIdx`, `zoom` (8/16/full), `fadersEngaged`/
  `fadersLocked`, `leftDock`/`rightDock`. (Track selection is NOT here — it's in useStore.)

## Next steps (finish Stage 1, then 2→5 per the plan)

Stage 1 remaining:
- **Slim navigator minimap** — React over `snapshot.sections` (`Section {startBeat,endBeat}`) +
  30Hz transport playhead + peer beads + a draggable viewport window. Mirror the companion's
  shared `arr-nav` treatment (container-query responsive) so Stage 5 reuses it.
- **Per-lane compositor playhead** — cache each focused lane's `.ol-ph` element + width in a
  `laneGeo` array; in a single rAF `tick()` write `transform: translateX(px)` off the live
  transport position (compositor-only, no per-frame layout reads). Only on focused/expanded lanes.
- **Real fill-all vs accordion layout engine** — if `n*MIN_ED + gaps ≤ availH`, expand ALL lanes
  editable (even split capped at MAX_ED); else single-focus accordion (focused = remaining space,
  others = COMPACT_H). Currently a simplified flex(2/1); make it measured.
- **Zoom bar-window fit** — 8/16/FULL sets the visible bar span → px/sec (mirror v2's
  `sectionZoom` fit-on-ResizeObserver).
- **Composer** — wire the real agent input (`ui/src/v2/Composer.tsx` / `AgentComposer` logic) +
  the prompt-bar Moshi (real creature `window.Moshi(el,{style:'baked',room:false,interactive:true})`
  from `ui/src/vendor/moshi.js`; hold-on-Moshi = talk).

Stage 2: inline editors (drum grid / piano-roll / waveform split-trim reusing the exported
renderers + PianoRoll/ClipView logic), Shift-hold faders (`set_track_volume`), drag-to-reorder
(the `reorder_track` command). Stage 3: reactive PS5 background (energy from the live `--lvl`
feed + transport-playing → slow-mo on pause) + 4 material themes + reduced-motion/no-WebGL
fallbacks. Stage 4: parity surfaces (Inspector/browser/sends/lyrics/collaborators re-skinned).
Stage 5: companion (take-loop remote) + flip the default + ship.

## Run & verify

```sh
# dev preview (mock backend auto-on: MOCK_ENABLED = import.meta.env.DEV)
cd ui && npm run dev          # → http://localhost:5173/?shell=openlanes
npm run typecheck             # tsc --noEmit (src) + tsc -p tsconfig.e2e.json
npm run test                  # vitest
npm run test:e2e              # playwright (isolated config playwright.isolated.config.ts, :5191, if :5173 busy)
```
e2e drives the same mock backend as dev (`bridge.mock.ts`; seeds Drums=drum-grid MIDI,
Bass=MIDI, Keys=wave). When v3 stabilizes, add a v3 e2e spec (mirror `ui/e2e/` v2 specs) asserting
mount + focus-switch + inline edits + reorder over `?shell=openlanes`.

## Gotchas

- Track selection routes through `useStore.setSelectedTrack` (MP lock/broadcast) — never mirror it
  in the v3 state slice.
- The compact-preview canvas needs a ResizeObserver: `.ol-ed` is absolutely positioned and starts
  0×0 until the flex lane settles, so a bare effect draws at width 0. (Same pattern will apply to
  the inline editors.)
- Snapshot/event changes stay ADDITIVE (AGENTS.md hard rule). The only C++ is `reorder_track`.
- No hosted CI — the local `Mosh --selftest` battery is the merge gate (see AGENTS.md).
