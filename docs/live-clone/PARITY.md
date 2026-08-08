# Mosh Live — interaction parity audit (Phase 3 + Wave 0)

Audit of the live shell (`ui/src/live`) against the SPEC's interaction inventory
(§7 editor, §8 arrangement), plus the Wave-0 menu rollout against
`.cache/live-ref/menus.json` (Live 12's complete menu tree, extracted from the real
app's accessibility tree — 338 items; the extractor's modifier decoding has gaps for
function-key/glyph bindings, so alphanumeric chords below are the reliable ones).
Every "wired" row resolves through the ableton keymap preset
(`ui/src/interaction/keymap.ts`) or gesture table
(`ui/src/interaction/gestureTables.ts`) and mutates only through `exec()` — no
ad-hoc key checks. e2e pins: `ui/e2e/live-shell.spec.ts` (one per wired gesture).

**Default bundle (resolve-time, no persistence):** with NO explicit
keymap/gestureTable override, the live shell resolves both to **ableton**
(`effectiveInteractionSetting`, `ui/src/interaction/config.ts` — the effective shell
via `resolveShell`, so `?shell=` e2e/dev boots are honored). An explicit choice —
even an explicit "mosh" — always wins, and every other shell keeps the schema
default. `activeKeymap()` (settings/store.ts) scopes key.* rebinds to the same
resolution, and the Settings panel shows the effective value for these two
pickers. This was the wild "⌘E/⌘L are dead in the clone" bug: uiShell defaulted to
"live" while the bundle defaulted to "mosh" and only the hand-picked template
materialized ableton.

## Arrangement (SPEC §8 + menus.json)

| Gesture | Live 12 behavior | Mosh status | Where wired |
|---|---|---|---|
| Click clip | select | **works** | ableton table `clip.header`/`clip.body` click → SELECT; shared `ClipView` |
| Drag clip | move (whole body) | **diverges** | header strip drags (table `clip.header` drag → MOVE); body drag = time selection (table `clip.body` → TIME_SELECT). Kept deliberately: the strip is visible and matches Mosh's ableton/PT tables; SPEC §8 itself flags whole-body-drag as unverified. |
| Double-click clip | open editor | **works** (and now unnecessary) | table `clip.body` dblclick → OPEN → `editingClipId` → docked editor (Phase 2) |
| Click clip | open its detail view in the dock | **wired** (selection-follow) | `live/selectionFollow.ts` — the dock's clip view tracks the CLIP SELECTION: click opens the MIDI editor or wave audio editor, track-header click and empty-lane click close it, switching clips swaps, and a manually-closed view re-opens on the next click. Generic/absent snapshot clips close rather than leaving a stale editor id. Empty-lane DRAG (time selection) deliberately does NOT close (in-flight suppress) |
| Arrangement-vs-editor key scope | focus decides | **wired** (selection-follow, C004) | the dispatcher and the piano roll's local listener share `editorKeyFocused()` — the docked editor owns Delete/nudge/0/⌘U/⌘1..4/⌘A only while focus is inside it; an arrangement-focused Delete reaches `remove_clip` even while that editor stays open. The modal mounts (classic/v2) focus the roll on open, so their semantics are unchanged by construction |
| ⌘-click additive toggle | toggle clip selection | **diverges** | the ableton gesture table has no additive-toggle rule and `select(additive)` only ever ADDS, so ⌘-click is a plain select. The follow logic's additive-deselect branch is implemented + unit-tested (`selectionFollow.test.ts`) but no gesture reaches it today |
| ⌘E split | split at playhead | **works** (native conflict fixed) | ableton keymap SPLIT → `runAction("split")` → `split_clip`. The native macOS menu's Export Audio key-equivalent swallowed ⌘E in the packaged app — rebound to ⇧⌘R (Live's export binding) in `MenuController.cpp`; FILE_MENU + HelpTool labels agree |
| ⌘J consolidate | merge selected clips | **wired** (Wave 2 MIDI; audio-consolidate wave adds WAVE) | `consolidate_clips` dispatches by type: MIDI note-merge (tempo-map-anchored) · WAVE render-consolidate through the track chain via `bounceRenderToWavImpl` (render before the one transaction, sources removed, rendered clip at span start). Mixed MIDI+audio sets and unselected-overlapping clips refuse plainly; ONE undo restores both paths |
| ⇧⌘J Crop Clip | trim selected clips to the time selection | **wired** (crop wave, engine + keymap + clip menu) | new moshop `crop_clip {clipIds, start, end}` — MIDI notes outside the crop removed, crossing notes clipped to the edge (Tracktion's own `trimBeyondEnds`), audio edge-trims with offset adjust; one transaction = one undo; empty span / no overlap / already-covering are user-facing errors (no playhead fallback). Clip-body drag paints the span (ableton table) without dropping the clip selection; arrangement-context only — a FOCUSED editor keeps the key off |
| ⌘B Bounce to New Track / Bounce in Place | offline-render the track to audio | **wired** (bounce wave, engine + header/clip menus + ⌘B) | new moshop `bounce_track {trackId, mode}` — the whole track's clips through its instrument+FX chain (no master bus), session start → last clip end, 24-bit WAV via the same RenderTask+watchdog path export/auto-bounce use; inPlace replaces the clips (devices stay), newTrack lands below the untouched source; ONE undo; honest refusals: empty / group folder / return / master / stalled render. Bounced clip is plain audio — no generative re-bounce hooks |
| ⌘L activate loop | loop the time selection | **wired** (Phase 3) | keymap LOOP_TOGGLE → `runAction("loop_toggle")`: loops the drawn span, else toggles (collapsed range defaults to 4 bars) |
| Loop brace | drag/keys reshape | **wired** (keymap-audit wave) | `live/LoopBrace.tsx` + `loopBraceGeometry.ts`: body drag moves, edge drags resize, ←/→ move by grid, ⌘←/⌘→ halve/double — one `set_transport` per commit; the brace never touches the time selection (ruler shift-drag still paints it) |
| ⇧⌘L select loop | select the loop range | **wired** (Wave 0) | keymap SELECT_LOOP → `runAction("select_loop")` draws the armed loop as the time span |
| ←/→ clip nudge | move by grid | **works** | shared core NUDGE_LEFT/RIGHT → grid-step `move_clip` |
| ↑/↓ clip nudge | move to adjacent track | **wired** (keymap-audit wave) | NUDGE_UP/DOWN (ableton arrows) → cross-track `move_clip`; group/return excluded, boundary clips stay put |
| ⌘1 / ⌘2 grid | narrow / widen arrangement grid | **wired** (Phase 3) | keymap GRID_NARROW/GRID_WIDEN → steps `snapDivision`; gated while the editor is open |
| ⌘3 triplet grid | triplet arrangement grid | **wired** (Wave 0/2) | keymap GRID_TRIPLET → `snapTriplet` (every snap step × 2/3, tempo-map-aware via `snapTimeMap`). Caveat: snapping only — the lane grid paint has no triplet lines |
| ⌘4 snap toggle | snap on/off | **wired** (Phase 3) | keymap SNAP_TOGGLE → `setSnap` |
| ⌘R rename | rename clip | **wired** (Phase 3) | keymap RENAME → `live/useLiveKeys.ts` → inline input on the lane → `rename_clip` |
| 0 / ⌘0 deactivate | deactivate clip/note | **wired** (Phase 3 + Wave 0) | keymap DEACTIVATE binds BOTH (`["0", "Mod+0"]`, like Live) → `set_clip_mute`. Notes: editor's own 0 |
| ⌘D duplicate | duplicate clip/notes | **works** | shared MOSH core DUPLICATE (⌘D) → `duplicate_clip`; notes: editor's ⌘D |
| ⌘T insert audio track | create audio track | **wired** (Wave 0) | keymap INSERT_AUDIO_TRACK → `runAction` → `addTrackOfKind("audio")` |
| ⇧⌘T insert MIDI track | create MIDI track | **wired** (Wave 0) | keymap INSERT_MIDI_TRACK → `addTrackOfKind("midi")` (track + clip + default instrument) |
| ⇧⌘M insert empty MIDI clip | clip over time selection | **wired** (Wave 0) | keymap INSERT_MIDI_CLIP → `add_midi_clip` over the drawn span, else 1 bar at the playhead |
| ⌘I insert silence | insert time | **wired** (keymap-audit wave) | keymap INSERT_SILENCE → `runAction("insert_silence")` → `insert_time` over the drawn span, else 1 bar at the playhead |
| ⌘U quantize | quantize to grid | **wired** (Wave 0) | keymap QUANTIZE → `quantize_notes` on selected clips (current division; skips empty/wave clips); the open editor keeps ⌘U for its own grid+swing |
| ⌘A / ⇧⌘A | select all / invert | **wired** (Wave 0) | keymap SELECT_ALL / INVERT_SELECTION, arrangement (clip) scope; the editor keeps both for notes |
| ⌘G / ⇧⌘G group / ungroup | group tracks / unwrap | **wired** (fixed) | ⌘G groups clip-derived tracks, falling back to the track-header selection when no clips are selected (was inert). ⇧⌘G → `ungroup_track` on the selected group or the selected track's parent; mock mirrors |
| ⌥⌘F create fade | default edge fade | **wired** (keymap-audit wave) | keymap CREATE_FADE → `set_clip_fade` 0.004s (Live's default fade length) on selected WAVE clips only |
| 1 / 2 / 3 | (modal tools) | **dropped** (ableton only) | Live binds nothing there; the MOSH core's Move/Split/Range tool digits were inherited and silently switched tools — removed from the ableton preset, kept elsewhere |
| ⌥⇧⌘F freeze track | freeze | **wired** (freeze wave) | `freeze_track`/`unfreeze_track` moshops — renders [0, last clip end] via the bounce wave's offline path, replaces the clips with the render, parks every device (`te::Plugin::setEnabled` — undoable, serialized, zero-CPU), and records each device's additive `moshPreFreezeEnabled` state alongside the persistent `moshFrozen` track marker. A central guard at the command seam refuses clip-content + device mutations on a frozen track (move/duplicate/remove/mixer stay allowed — Live's rule). Unfreeze restores each captured device state (legacy frozen sessions default enabled) and drops the marker; the rendered clips STAY (undo(freeze) is how the originals return; undo(unfreeze) re-freezes). Menus + keymap toggle (Live's same-key unfreeze); frozen lane/header/device-strip visual treatment; mock mirrors |
| ⌘B bounce to new track | bounce | **wired** (bounce wave) | `bounce_track` moshop — see the Bounce row above |
| X zoom back | pop the zoom history | **wired** (zoom-history wave) | `live/zoomHistory.ts` (pure stack, unit-tested): recorded at every zoom mutation (⌘+/⌘− via menuActions, ruler drag-zoom, fit-to-span), 300ms burst coalescing, 50-entry cap; X pops one view per press, empty stack = no-op (Live) |
| ⌘+ / ⌘− | zoom arrangement | **wired** (+fix) | keymap ZOOM_IN/OUT → `pxPerSec` ×/÷ 1.25. Zoom-in binds BOTH physical forms (`Mod+=` and `Mod+Shift+=`) — the ⇧= chord used to fall through |
| Z zoom to time selection | fit the drawn span, else fit content | **wired** (zoom-history wave) | keymap ZOOM_TO_SELECTION → `live/useLiveKeys.ts`: `useShell.timeRange` → `zoomToFitSpan`; no span → `contentFitSpan()` (whole arrangement). Records itself into the X history |
| Ruler-drag zoom | drag in beat-time ruler zooms | **wired** (Wave 2) | `live/LiveRuler.tsx` (replaces the shared BarRuler in this shell only): click = seek, vertical drag = anchored zoom (down = in), Shift-drag = time range. v2's held-drag scrub is a live-shell casualty by design — documented divergence |
| Double-click empty lane | create clip + open editor | **wired** (Phase 3; C003 P1 guard) | ableton table `empty` dblclick → CREATE_CLIP → `add_midi_clip` + `openPianoRoll`, but ONLY when the rendered lane's track is MIDI-capable (`isInstrument` or `drum`). The handler resolves the real `.live-lane` bounding box with half-open vertical bounds, so resized lanes, shared lane edges, and take rows cannot misroute the gesture; ordinary Audio ground is unchanged and never opens the MIDI editor. The isolated C003 baseline F10 reported the prior wrong-editor behavior; focused Playwright now pins both ordinary Audio refusal and a resized Bass instrument-lane creation. |
| Drag empty lane | time selection | **wired** (Phase 3) — it did NOT exist | ableton table `empty` drag (MARQUEE) maps to the shared `timeRange` span; ⌘L consumes it. The pointer-down deselect does NOT close the clip view (selection-follow's in-flight suppress); the plain empty click DOES close it |
| Shift-drag ruler | time-range span | **works** | `LiveRuler` (Wave 2) — same RULER_RULES resolution |
| MIDI clip loop | Live's brace: repeat the loop region across the clip | **wired** (midi-loop wave) | `set_clip_loop` gains a MIDI branch (content-relative seconds → beats at the clip tempo via TE's own `setLoopRange`; deactivate = empty range, notes play once). Additive snapshot `midiLoopStart/LengthBeats`; repeat proven by bounce onset counts. `ClipLoopBar` mounts in the docked MIDI editor (toggle + draggable brace); ghost repeats in the arrangement canvas (`ClipView` via `expandLoopedNotes`) AND the roll (`pr-loop-ghost`, display-only) |
| Clip right-click | context menu | **wired** (Wave 2, honest enablement in 2b) | `live/LiveClipMenu.tsx` — Zoom Back X · Rename ⌘R · Split ⌘E · Consolidate ⌘J (MIDI) · Crop ⇧⌘J (crop wave) · Bounce to New Track ⌘B (bounce wave) · Activate Loop ⌘L · Freeze/Unfreeze Track ⌥⇧⌘F (freeze wave — the row flips on a frozen track) · Reverse R (wave clips) · Deactivate 0 · grid section (Snap ⌘4, Triplet ⌘3, Narrow ⌘1, Widen ⌘2) · Remove |
| Browser search | ⌘F filters the browser | **wired** (Wave 2) | keymap FIND → focuses `live-bsearch`; cross-category case-insensitive name filter, Esc clears |
| Cursor affordances | per-region cursors | **wired** (Wave 2) | CSS-only in live.css off shell data-attrs: grab/ew-resize (inherited), ruler ns-resize, draw-mode crosshair, ⌥ copy-drag, dock splitter row-resize |
| Space | play / stop-returns-to-insert-marker | **wired** (continue-play wave) | `cmdSetTransport` owns Live's model: a normal stop RETURNS the playhead to the insert marker (last play-start or explicit seek; machine state, not undoable, not in the snapshot). Note: stop previously just stayed — now Live-accurate |
| ⇧Space | Continue Playback | **wired** (continue-play wave) | `set_transport {action:"continue"}` + keymap CONTINUE_PLAY (`Shift+Space`) → `continue_play`: plays from the current position and the stop LEAVES the playhead where it halted. Mock mirrors the marker/flag |
| ⌥Space | play from insert | **unbound** | the insert marker exists (see Space row) but play-from-insert as a separate action isn't wired — noted |
| ⌘, | Preferences (Settings) | **wired** (settings-overlay wave) | `EA.SETTINGS` (`Mod+,`) → `useLive.settingsOpen` → the shared `SettingsPanel` as a modal overlay in AppLive (never forked; Esc/backdrop close through the escape stack). Only the classic visual `skin` descriptor hides under live (`settings/shellVisibility.ts`); audio routing, keys, feel, layout, templates stay reachable — set_audio_device works end-to-end from here |
| A | Automation Mode (view toggle) | **wired** (view toggle; lanes later) | keymap AUTOMATION_VIEW (`A`) → `useLive.automationView` + the control-bar automation button (Live's top-bar toggle). UI-local view state, not engine record-mode (`set_track_automation_mode` is a different thing — read/write/touch/latch recording). Automation LANE rendering = later wave |
| Playback glyph rows (menus.json) | record-to-arrangement etc. | **unverifiable** | the extractor decodes function-key/glyph shortcuts as bare "⌘" — those rows were NOT actioned |

## Editor (SPEC §7) — the docked clip editor

| Gesture | Live 12 behavior | Mosh status | Where wired |
|---|---|---|---|
| Draw mode ON: drag paints note of drag length | floor-snapped start, snapped length | **works** (Phase 2) | `liveState.drawMode` → `drawNoteSpan` (pure, unit-tested); ghost preview |
| Draw OFF: dblclick creates grid note | — | **diverges** | single click paints a grid-step note (Mosh's existing, faster idiom); dblclick on a note deletes it |
| Note drag / edge drag / Delete / marquee | move / resize / remove / select | **works** | shared PianoRoll gestures (`pianoRollEdit.ts`) |
| Velocity drag | marker height | **works** | shared velocity lane |
| Velocity tool row | Randomize / Ramp / Deviation | **wired** (velocity-tools wave) | docked piano roll strip above the VEL lane (`PianoRoll.tsx` `pr-veltools`, docked mount only); one moshop `transform_velocities {clipId, mode, amount?, lo?, hi?, noteIndexes?}` — targets = selection else all notes (Live's rule), deterministic-seeded randomness (FNV-1a args hash → mt19937_64, replay-stable), ONE transaction/undo; mock mirrors via `midi/velocityTransform.ts` |
| Transform tool row | Reverse / Invert / Legato / Humanize / ×2 / /2 / Set Length / Add Interval / Fit to Scale | **wired** (transform-tools + stragglers waves) — panel complete, 9/9 | docked piano roll strip above the velocity row (`PianoRoll.tsx` `pr-transformtools`, docked mount only); one moshop `transform_notes {clipId, mode, amount?, lengthBeats?, semitones?, noteIndexes?}` — targets = selection else all, deterministic modes work inside the TARGETS' own span, humanize deterministic-seeded (same FNV/mt19937_64 contract), ONE transaction/undo; mock mirrors via `midi/noteTransform.ts`. Set Length's field follows the current grid step until typed; Add Interval (signed semitones, Live's fifth default) skips duplicate chord tones; Fit to Scale snaps to the session key (`session.key` — the engine ports the voice.js SCALES mask; nearest in-scale, ties downward, same as `musicalKey.ts`'s scale lock) |
| Fold / Scale / Highlight Scale | row filtering | **works** | editor header (F / G / K) |
| Adaptive grid / ⌘1..4 editor grid | grid follows zoom or fixed | **works** | editor's own keyboard layer + settings |
| 0 deactivate note | silence note | **works** | editor layer → `toggleActiveEdits` |
| Wave clip editor | waveform plus non-destructive gain, fades, reverse, normalize, and source loop | **wired** (C003 P1) | `live/AudioClipEditor.tsx` opens from the arrangement's normal selection/double-click path, requests cached `get_clip_peaks` ink, shows basename/duration or an honest missing-source state, and sends `set_clip_gain`, `set_clip_fade`, `set_clip_reverse`, `normalize_clip {targetDb:0}`, and the existing `ClipLoopBar` commands. Warp remains in the v2 Inspector; no second warp UI is claimed here. |
| Clip loop brace drag (editor) | drag sets clip loop | **wired** (Wave 2, wave clips) | `live/ClipLoopBar.tsx` on the wave clip view: brace render + drag/arrow-key move + toggle via `set_clip_loop`. MIDI clips have no engine loop concept, so the note editor shows no brace |
| Keys-strip hover plays note | audition | **works** | gutter click audition (hover is not wired) |
| Generate tab (clip panel) | Live 12's rhythm/melody generators (seeded pattern creation inside the clip panel) | **covered elsewhere — 1:1 clone deliberately NOT planned** | Live's Generate tab creates seeded rhythms/melodies into the clip. Mosh covers the same capability through its OWN generative surface rather than a panel clone: `generate_beat_recipe` (real-recipes beat generator), `add_drum_pattern` (lane-string drum grids, DRM-002), the sample/loop browser, and the agent stack (the Moshi drawer + `transform_notes`/`transform_velocities` for after-the-fact shaping). A 1:1 Generate-tab replica would fork a second, weaker generative UI into the clip panel; a Mosh-native creation panel may land in the Moshi drawer later. No UI placeholder is shown — the row exists to record the decision, not to promise the tab |

## Dock & browser (Wave 0/2 additions)

| Surface | Live 12 behavior | Mosh status | Where wired |
|---|---|---|---|
| Dock height | divider drag resizes | **wired** (Wave 0, refined Wave 2b) | splitter on the clip panel's top edge (pointer + ↑/↓, role="separator"), persisted via the `liveDockHeight` setting; clamp in `live/dockGeometry.ts` |
| Clip panel min / drag-to-close | min 226pt; a LONG pull past min dismisses | **wired** (Wave 2b) | `DOCK_MIN` 226 + `dockDragDismisses` (48pt past the floor) in the splitter release |
| Device panel | FIXED ~212pt below the clip panel | **wired** (Wave 2b) | `live-devpanel` stacks under the clip panel (or IS the dock when no clip is open); its edge never drags |
| Expanded Clip View | ⌥⌘E — editor fills the window, sticky | **wired** (Wave 2b) | keymap EXPAND_CLIP (ableton ⌥⌘E) + the editor header's ⤢ (`pr-expand`); hides browser/arrangement via `data-clip-expanded`; persists in the `liveClipExpanded` setting |
| Lane height | header divider drags one lane, 86 default, 17–443, compact at min | **wired** (Wave 2b) | `live-lane-resize` handle per header (pointer + ↑/↓); `live/laneGeometry.ts`; session state in liveState |
| Track-header context menu | right-click the header | **wired** (Wave 2b) | `live/TrackHeaderMenu.tsx`: Rename ⌘R (inline), Insert Audio ⌘T / MIDI ⇧⌘T, Group Tracks ⌘G, Bounce in Place / Bounce to New Track ⌘B (bounce wave), Freeze/Unfreeze Track ⌥⇧⌘F (freeze wave — the row flips on a frozen track), the full 70-swatch Colors grid (measured hexes, `live/trackColors.ts` → `set_track_color`) |
| Header input source | popup menu (NOT a `<select>`); wave inputs + MIDI on instrument tracks, "None" leads | **wired** (header-I/O wave) | `live/TrackIoSection.tsx` — catalogs lazy (`list_wave_inputs`/`list_midi_inputs`), current value from `track.input`, pick → `set_track_input {trackId, deviceID}` ("" clears; a routing preference, undoable:false) |
| Header output destination | popup menu: default / hardware outs / other tracks | **wired** (header-I/O wave) | `trackOutputOptions` → `set_track_output` (`{output:"default"}` / `{destTrackId}` / `{deviceID}`); cycle guard lives in the engine + mock |
| Header volume / pan | sliders drag, double-click resets | **wired** (header-I/O wave) | `set_track_volume` (dB, −70…+6) / `set_track_pan` (−1…1); double-click resets 0 dB / centre (Live's reset gesture) |
| Header per-channel pickers | Live's finer in/out channel cell beside each routing popup | **engine-gated** | honestly disabled with the reason on hover — `set_track_input`/`set_track_output` take a whole device/pair; no per-channel command exists |
| Browser width | divider drag; far-left hides, remembering width | **wired** (Wave 2b) | `BrowserDivider` (AppLive): 165pt floor, hide < 120pt restores the drag-start width, ▸ strip reopens |
| Overview strip | ~11pt mini-arrangement | **wired** (Wave 2b) | `live/OverviewStrip.tsx`: clip blocks by track colour + playhead; click seeks + scrolls the lanes |
| Zone measurements | cb 30 / overview 11 / ruler 19 / status 16 / browser 331 / headers FIXED 279 | **wired** (Wave 2b) | renamed tokens in live.css (`--live-cb-h`, `--live-overview-h`, `--live-head-w`, …) |
| Devices view | dock shows the selected track's devices | **wired** (Wave 0) | `live/DeviceStrip.tsx` — chips from `track.plugins`; name → `open_plugin_editor`, ⏻ → `bypass_plugin` |
| Plugin rescan | the browser can re-catalog plugins | **wired** (Wave 0) | live browser footer (Instruments/Audio Effects): Rescan + AU opt-in + live progress via the store's `scanProgress` slice; the deep sweep grows the catalog (the mock simulates it) |
| Load without a selected track | — | **fixed** (Wave 0) | select-then-load (falls back to the first track) + a visible "Loaded X onto Y" hint — no more silent no-op |
| Browser load gesture | click selects, double-click loads | **wired** (Wave 3) | single-click selects (samples also audition); double-click loads/imports; visible `sel` row state. Prevents accidental multi-loads (the Serum×4 bug) |
| Instrument on an audio track | refused | **wired** (Wave 3, engine) | `cmdLoadPlugin` refuses `isInstrument` plugins on tracks holding WAVE clips ("…goes on instrument tracks (⇧⌘T)") — an instrument there is silent-by-construction. Empty/MIDI-only tracks stay loadable (that IS how an instrument track starts); `load_builtin` unguarded (the default-instrument paths drive it). Mock mirrors; selftest case added |
| Device strip removal | Delete removes a device | **wired** (Wave 3) | chip click selects, double-click opens the editor, Delete/Backspace on a focused chip → `remove_plugin` (focus-scoped, never fights the editor's Delete), right-click → chip menu (Open/Bypass/Remove) |
| Take lanes | sub-lanes under the track lane, one per take; click switches, header ▸/▾ collapses | **wired** (take-lanes + per-take-waveforms waves) | `live/TakeLanes.tsx` + `live/takeLanesLayout.ts` + `live/takeWave.ts` (pure, unit-pinned): a wave clip with `numTakes > 1` paints one row per take INDEX under its lane (clips share rows by index; sibling of the lane in the same `.live-lanes` stack, so pxPerSec/scroll sync is free). Each bar draws the take's WAVEFORM (dimmer than the main lane, current keeps the accent) from `list_takes`' additive per-take `peaks` field — resolved engine-side through SourceFileReference (covers TE's direct-file AND project-item take forms) and bucketed by the same `bucketedPeaks` the main lane uses; a take with an unreadable source falls back to the labeled bar (absence of ink, never a blank). Click a take bar → `set_current_take` (undoable); the current bar's Keep button → `keep_take` (Live's flatten, undoable); the header's ▸/▾ toggles per track (UI-local, default expanded; no takes = zero visual change; MIDI clips never). `list_takes` fetched lazily per clip with takes, refetched on the snapshot's numTakes/currentTakeIndex |

## Expensive gaps — deliberately NOT built (noted, not scheduled)

- **⌥Space play-from-insert** — the insert marker now exists (the Space row's
  continue-play wave), but a separate play-from-insert action isn't wired.
- **Automation lane rendering** — A toggles the automation VIEW state (control-bar
  button); the per-track automation lanes themselves are a later wave.
- **Triplet grid paint** — ⌘3 affects SNAPPING only; the lane grid still draws
  straight divisions. A triplet line pattern is a LaneGrid/gradient change.
- **Ruler scrub** — the live ruler spends its plain drag on zoom (Live's idiom);
  v2's hold-to-scrub is not in this shell. Click-to-seek is preserved.
- **Region comping across takes** — Live assembles one comp from take REGIONS;
  the lanes above are whole-take display + switch + keep. Region comping needs a
  comp-region edit model (region selections over the take tree, a comp clip that
  references them) — later wave.
- **Take-lane expand-state persistence** — the per-track ▸/▾ is UI-local
  (Arrangement state); making it a session/setting value is a later decision.
- **MPE tab** — out of scope (SPEC §10).
- **Editor Tool Tabs / Clip Tabs** (Transform/Generate panels, Main/Launch
  Properties) — Live 12's tabbed panels; our editor header predates them. Later phase.
- **menus.json glyph rows** — the extractor's modifier gaps (bare "⌘" for F-keys and
  symbols) were left unactioned rather than guessed.
