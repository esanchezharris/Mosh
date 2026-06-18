# Mosh DAW — Feature Audit Dashboard

_Generated 2026-06-09 · 266 features · 30 categories · two axes (capability = the engine does it; surface = the user can reach it)._

## Honest reality summary

Out of **266** audited features, only **24 are fully shipped** (capability *and* surface both present) — about **9%**. Of the **82 must-tier** "table-stakes" features a user needs before calling this a DAW, just **18 are complete**. What genuinely exists today is a thin but real vertical slice: a Tracktion-backed engine with a single fixed session that saves/reloads, a working arrangement (tracks, audio clips, move/trim/split, zoom, snap, marquee, loop region), play/stop + loop transport, per-track volume/mute/solo, VST3 hosting with reorderable insert chains and native editor pop-outs, undo/redo through one command path, light/dark themes, and the Mosh-specific neural spine (SA3 freeze-and-render render-layers, the Color Rack, two-tier inference, judge-panel quality readout, accept/reject). That neural layer is the most finished part of the whole product. Everything a working musician reaches for around that core, though, is missing or invisible: **no recording** (no record button, no arm, no input monitoring), **no MIDI editing surface** (MIDI clips exist as colored blocks with a hardcoded arpeggio and no piano-roll), **no tempo/time-signature control** (tempo is read-only and never shown), **no automation of any kind**, **no built-in effects or instruments** (EQ/comp/reverb/synth all rely on third-party VST3), **no real mixer view, buses, sends, or master strip**, **no metering** (not a single live level meter), **no file import or drag-drop**, and **no settings/device-picker** (audio device is an env var). Several capabilities are built in code but unreachable — pan, record, and render-mode all work in the engine yet have no control wired to them. Verdict: a strong neural-transform prototype welded to a minimal arrangement demo, not yet a DAW a producer could track, edit, mix, and bounce a song in.

## Progress log

_Features moved since the baseline audit. The tables below still show the original baseline; this log is the running delta._

### 2026-06-09 · Wave 1 — Built-in instrument & effect palette ✅

**Key discovery:** Tracktion Engine already **compiles in and auto-registers** a full built-in plugin palette (`4osc`, `sampler`, `4bandEq`, `compressor`, `reverb`, `delay`, `chorus`, `phaser`, `lowpass`, `pitchShifter`) — the audit's "Wave 7" assumed this DSP had to be written from scratch, so it was the cheapest high-value win available, not the most expensive. Surfaced via two new commands (`list_builtins`, `load_builtin`), `builtin`/`category`/`isInstrument` snapshot flags, the plugin browser (built-ins grouped by category above scanned VST3/AUs), and inline parameter sliders in the Rack (built-ins have no native editor window). Verified: `Mosh --selftest` **111/111**, 0 assertions.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `INS-006` | must | Instrument tracks (assign a built-in synth/sampler) | ✓/◐ → ✓/✓ |
| `FX-001` | must | Equalizer (4bandEq, controllable) | ✗/✗ → ✓/✓* |
| `FX-002` | must | Compressor (controllable) | ✗/✗ → ✓/✓* |
| `FX-003` | should | Reverb | ✗/✗ → ✓/✓ |
| `FX-004` | should | Delay | ✗/✗ → ✓/✓ |
| `FX-005` | should | Modulation (chorus/phaser) | ✗/✗ → ✓/✓ |
| `INS-013` | should | Built-in sampler | ✗/✗ → ✓/✓ |
| `INS-014` | should | Built-in synthesizer (4osc) | ✗/✗ → ✓/✓ |

\* FX-001/FX-002 are loadable + fully controllable via parameter sliders; the bespoke EQ response-curve / compressor gain-reduction *visualizations* are deferred to the metering / FX-depth wave.

**Shipped-on-both-axes: 24 → 32** (must-tier 18 → 21). Also nudged `INS-005` (plugin management — palette now listed), `AED-008` (pitch-shift available as an insert), `FX-009` (utility filter) toward partial. **Product fix along the way:** none required — `load_builtin`/`remove_track` reuse proven paths.

### 2026-06-09 · Wave 2 — Transport / tempo / meter / metronome / record surface ✅

The audit's #1 leverage wave: musical-time controls that unblock the grid. New commands `set_tempo`, `set_time_signature`, `set_metronome` + a `to_end`/`to_start` transport action; snapshot `session` now carries `timeSigNumerator`/`timeSigDenominator`/`metronome`/`length`. Transport bar gains an editable BPM field, a time-signature control, a metronome toggle, a record button (red while recording), and go-to-end. Verified: `Mosh --selftest` **122/122**, 0 assertions.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `TRA-006` | must | Tempo control | ◐/✗ → ✓/✓ |
| `TMP-001` | must | Fixed project tempo | ◐/✗ → ✓/✓ |
| `TRA-007` | must | Time signature | ✗/✗ → ✓/✓ |
| `TRA-008` | must | Metronome / click | ✗/✗ → ✓/✓ |
| `TRA-004` | must | Return to start / go to end | ✓/◐ → ✓/✓ |
| `TRA-002` | must | Record (button + indicator) | ✓/✗ → ◐/✓ * |

\* TRA-002: the record transport control + recording indicator are now present; full capture (record-arm + input monitoring + take landing) is Wave 3.

**Shipped-on-both-axes: 32 → 37** (must-tier 21 → 26). The musical-time foundation for the bars&beats grid (next wave) is now in place.

### 2026-06-09 · Wave 3 — Bars & beats musical time + grid ✅

The SES-001 "one canonical time model" promise. A single shared mapping module (`ui/src/time.ts`, derived from the snapshot's tempo + time signature) drives a bars&beats ruler, musical gridlines behind the clips, a selectable snap resolution (Bar / 1/4 / 1/8 / 1/16 / 1/32), vertical (track-height) zoom, and a bars.beats.sixteenths position readout in the transport. **Pure UI wave — zero backend change** (a swappability demonstration; the command surface stays seconds-based). Verified: `Mosh --selftest` 122/122 (unchanged) + screenshot.

**Build fix:** UI-only iterations rebuilt the bundle but never restaged it into the `.app` (staging was a POST_BUILD of the Mosh target, which only fires on a C++ relink). Added an always-on `MoshStageUI` target so UI-only waves ship a fresh bundle.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `ARR-004` | must | Timeline ruler (bars & beats) | ◐/◐ → ✓/✓ |
| `ARR-006` | must | Grid & snap (musical) | ◐/◐ → ✓/✓ |
| `ARR-007` | must | Adjustable snap resolution | ✗/✗ → ✓/✓ |
| `ARR-008` | must | Zoom (horizontal & vertical) | ◐/◐ → ✓/✓ |
| `SES-001` | must | Single canonical time model | ◐/✗ → ◐/✓ * |
| `ARR-005` | should | Multiple time formats | ✗/✗ → ◐/◐ |

\* SES-001: one shared mapping now drives every view (ruler/grid/snap/readout) and is surfaced; capability is constant-tempo canonical — a tempo map is a later wave.

**Shipped-on-both-axes: 37 → 41** (must-tier 26 → 30). The musical grid that MIDI editing, automation, and warp all depend on is now in place.

### 2026-06-09 · Wave 4 — MIDI piano-roll & note editing ✅

A whole must-tier category. MIDI notes now serialise into the snapshot (beats within the clip); new commands `add_note`, `remove_note`, `set_note` (pitch/start/length/velocity), `quantize_notes`. A piano-roll editor opens on double-clicking a MIDI clip: pitch×beats grid (same canonical mapping as the arrangement), notes as blocks, click-to-add, drag-move, edge-resize, double-click-delete, per-note velocity slider, and Quantize. Combined with Wave 1's built-in 4OSC synth, the compose loop is real. Verified: `Mosh --selftest` **133/133**, 0 assertions + screenshot.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `MID-002` | must | Piano-roll editor | ✗/✗ → ✓/✓ |
| `MID-003` | must | Note create / move / resize / delete | ◐/✗ → ✓/✓ |
| `MID-004` | must | Velocity editing | ◐/✗ → ✓/✓ |
| `MID-006` | must | Quantize MIDI | ✗/✗ → ✓/✓ |
| `ARR-003` | must | MIDI clips (render + open into editor) | ✓/◐ → ✓/✓ |

**Shipped-on-both-axes: 41 → 46** (must-tier 30 → 35). With built-in instruments (Wave 1) + the musical grid (Wave 3) + the piano roll, you can write and hear a part end to end.

### 2026-06-09 · Wave 5 — Mixer view + pan + master bus ✅

Backend: snapshot now carries the `master` bus (the edit's master VolumeAndPan) with `set_master_volume`/`set_master_pan`; pan was already in the snapshot. UI: a dedicated **Mixer view** (toggle in the topbar) with a channel strip per track — pan, vertical fader, dB readout, mute/solo, fx count — plus a distinct **Master** strip; a compact pan slider added to each arrangement track header. Verified: `Mosh --selftest` **140/140**, 0 assertions + screenshot.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `MIX-001` | must | Mixer view | ◐/◐ → ✓/✓ |
| `MIX-003` | must | Pan | ✓/✗ → ✓/✓ |
| `MIX-010` | must | Master bus | ◐/✗ → ✓/✓ |

**Shipped-on-both-axes: 46 → 49** (must-tier 35 → 38). Channel metering (live level taps via `LevelMeterPlugin`) and buses/sends are the next mixer rungs.

### 2026-06-09 · Wave 6 — Clip editing (delete / rename / mute / gain / duplicate) ✅

Filled a glaring gap: there was no way to even **delete** a clip. New commands `remove_clip`, `rename_clip`, `set_clip_mute`, `set_clip_gain`, `duplicate_clip`; snapshot clips now carry `mute` + `gainDb`. UI: a selection-driven clip-actions bar (rename, mute, gain, duplicate, delete), Delete/Backspace key removal, and a dimmed visual for muted clips. Verified: `Mosh --selftest` **152/152**, 0 assertions.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `ARR-016` | should | Clip gain | ✗/✗ → ✓/✓ |
| `ARR-023` | should | Clip mute / disable | ✗/✗ → ✓/✓ |
| `ARR-024` | should | Clip rename | ◐/✗ → ✓/✓ |
| `ARR-015` | should | Duplicate / loop clips | ✗/✗ → ◐/✓ (duplicate; loop-repeat later) |
| `AED-001` | must | Cut / copy / paste / delete | ✗/✗ → ◐/◐ (delete + duplicate; clipboard cut/copy/paste later) |
| `AED-005` | should | Clip gain / normalize | ✗/✗ → ◐/◐ (gain; normalize later) |

**Shipped-on-both-axes: 49 → 52** (ARR-016/023/024). Delete-a-clip + duplicate + per-clip gain/mute are core editing the DAW simply lacked before.

### 2026-06-09 · Wave 7 — Parameter automation ✅

A whole empty must-tier category. Backend: `add_automation_point` / `set_automation_point` / `remove_automation_point` / `clear_automation`, addressed by (trackId, pluginIndex, paramIndex), values normalised 0–1 mapped to the param's real range via `valueRange`; each automated param serialises its curve points into the snapshot (`automated` + `points[{t,v}]`). UI: an automation editor panel (opened from the Rack's "⌁ Automation") with plugin+param pickers (including track Vol/Pan), an SVG curve — click-add, drag-move, double-click-delete, Clear. Curves drive the parameter on playback (Tracktion read mode). Verified: `Mosh --selftest` **163/163**, 0 assertions + screenshot. (Research plans for the remaining waves saved under `docs/plans/`.)

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `AUT-001` | must | Parameter automation | ✗/✗ → ✓/✓ |
| `AUT-002` | must | Volume / pan automation | ✗/✗ → ✓/✓ |
| `AUT-004` | must | Draw / pencil automation | ✗/✗ → ✓/✓ |
| `INS-009` | must | Plugin parameter automation | ◐/✗ → ✓/✓ |
| `AUT-003` | must | Automation lanes | ✗/✗ → ✓/◐ (editor panel; inline under-track lanes later) |

**Shipped-on-both-axes: 52 → 56** (must-tier 38 → 42). Automation was zero on both axes across the whole category before this.

### 2026-06-09 · Wave 8 — Sends / returns / aux buses ✅

Routing to shared effect buses (built from the researched plan, `docs/plans/wave-sends.md`). A bus is an integer; the return is a normal `AudioTrack` carrying an `AuxReturnPlugin` (audible with no input). New commands `create_bus` / `add_send` / `set_send_level` / `remove_send` / `remove_bus` / `rename_bus`; bus numbers allocated lowest-unused; orphan sends swept on `remove_bus`; names persist via `Edit::setAuxBusName`. Snapshot: per-track `sends[]` + `isReturn`/`returnBus`, top-level `buses[]`. Mixer UI: `+ Bus`, return strips (R badge, × Bus), per-channel send sliders + add-chips. Verified: `Mosh --selftest` **181/181**, 0 assertions + screenshot. (Found + fixed a dangling-`var`-temporary bug in my own test along the way.)

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `MIX-006` | must | Sends / returns / aux | ✗/✗ → ✓/✓ |
| `RTG-003` | must | Bus / aux routing | ✗/✗ → ✓/✓ |
| `MIX-008` | must | Group / bus tracks | ✗/✗ → ✓/◐ (aux return buses; summing submix groups later) |

**Shipped-on-both-axes: 56 → 58** (must-tier 42 → 44). The wet-signal audibility (send→return graph edge) needs a live device — a bounce-based Catch2 test is the recommended way to close that headless, per the plan.

### 2026-06-09 · Wave 9 — Channel metering (live level meters) ✅

The "not a single live meter" gap (built from `docs/plans/wave-metering.md`, which caught that `getLevelCache()` is dead in this clone — the working path is a registered `LevelMeasurer::Client`). A `LevelMeterPlugin` tap is appended post-fader per track; `timerCallback` reads each client's peak-since-frame at 30Hz and emits a `"levels"` event `{tracks:[{id,l,r}], master:{l,r}}` (master from the playback context). Commands `enable_track_meter` / `disable_track_meter` / `enable_all_meters`; the tap is hidden from the rack (real index preserved); `meterEnabled` in the snapshot. **Undo/redo-safe** via per-frame `reconcileMeterClients()` (reads only our own `Client`, never a stale measurer). UI: a `Meter` bar component next to every fader + master, fed by the event (no snapshot churn); the mixer enables all meters on mount. Verified: `Mosh --selftest` **192/192**, 0 assertions.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `MTR-001` | must | Peak level meters | ✗/✗ → ✓/✓ * |
| `MIX-011` | must | Channel metering | ✗/✗ → ✓/✓ * |

\* Plumbing + UI complete and headless-verified (enable/disable/idempotent/undo/hidden/event-shape). Non-trivial **dB values require a live CoreAudio device + playing audio** (`processBuffer` only runs then) — the same honest hardware-gate the project documents for neural A/B. Meters animate in the running app on playback.

**Shipped-on-both-axes: 58 → 60** (must-tier 44 → 46). The mixer is now a complete channel strip: fader, pan, mute/solo, sends, and a live meter.

### 2026-06-09 · Wave: Recording — arm / input monitor ✅

The "no recording" gap (built from `docs/plans/wave-recording.md`, which caught that the prompt's `setTargetTrack`/`setRecordingEnabled` API is stale — the pinned clone uses the `EditItemID`-keyed `InputDeviceInstance::setTarget` / `setRecordingEnabled` API). Commands `arm_track` and `set_input_monitor` route through the `getAllInputDevices()` + `isOnTargetTrack(slot 0)` read-through; arming a virgin track assigns the first wave input (`setTarget`) before record-enabling (mirrors `RecordingDemo`). The snapshot exposes `armed` / `monitor` / `hasInput` per track; the track header gains **R** (record-arm) and **I** (input-monitor) buttons left of M/S. `MoshEngine` enables the device's wave inputs once when audio + context first come up (latched, audio-only, `restartPlayback()`). **Correctly modelled as non-undoable monitoring preferences** (verified against the clone: the destination `armed` flag is bound with a `nullptr` UndoManager and monitor mode persists via `saveProps()`, not the Edit tree — so they log `undoable:false`, like `set_metronome`). Both degrade gracefully headless: `ok` + `applied:false` (never an error) when no input device exists. Verified: `Mosh --selftest` **215/215**, 0 assertions.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `ARE-002` | must | Record arm | ✗/✗ → ✓/✓ * |
| `ARE-001` | must | Input monitoring | ✗/✗ → ✓/✓ * |
| `ARE-003` | must | Latency-compensated recording | ✗/✗ → ◐/◐ |

\* Command surface + arm/monitor state + snapshot + UI complete and headless-verified (dispatch, validation, graceful no-op, snapshot shape, `undoable:false`, JSONL). The **armed=true round-trip, actual capture, take landing, and audible monitoring need a live CoreAudio input device** (`getAllInputDevices()` is empty without a playback context) — the same honest hardware-gate the project documents for neural A/B and live meters. `ARE-003`'s latency-compensated take-landing is engine-automatic on `transport.record()` once armed (wave inputs enabled) but only verifiable with a real mic, so it lands at partial.

**Shipped-on-both-axes: 60 → 62** (must-tier 46 → 48). The transport's record button (Wave 2) now has the arm + monitor preconditions behind it; live capture is one mic away.

### 2026-06-09 · Wave: Settings — device picker / project lifecycle / engine gate / import ✅

The "no settings/device-picker" + "no New/Open project" + "audioEnabled never reaches the UI" gaps (built from `docs/plans/wave-settings.md`, verified against clone 2877b621). **6 commands** — `list_audio_devices` (read-only enumerate), `set_audio_device` / `set_buffer_size` (machine preferences, `undoable:false`), `new_project` / `open_project` / `save_as` (whole-Edit lifecycle, `undoable:false`) — plus **2 native bridge fns** `pick_files` / `pick_save_file` (async `FileChooser`, held in a member, resolved exactly once incl. cancel, re-entry-guarded). The snapshot `session` gained the audio-engine **gate** (`audioEnabled`) + readout (`bitDepth`/`bufferSize`/`outputLatencyMs`/`audioDeviceName`/`audioDeviceError`) + a backend-owned `projectExtension` (so the storage format stays out of the UI) and a small top-level `audio{}` selection block. `MoshEngine` gained `newProject`/`openProject`/`saveProjectAs`/`adoptEditFile` following the `reloadFromFile` swap pattern — **transport stopped + playback context freed before the swap**, `editPath`+`editFileRetriever` re-pointed after, meter clients unregistered + `lastSeenContext` reset so the master meter re-attaches to the new context. UI: a `Settings.tsx` gear popover (modeled on RemoteCompanion — device-type/output/input/sample-rate/buffer-size selects, engine readout, a no-audio gate banner, and a File menu New/Open…/Save/Save As…/Import…); Play/Record disabled in `Transport.tsx` and Export in `App.tsx` when `!audioEnabled`. **Device + project commands are non-undoable preferences** (no empty transaction — same correctness the Recording wave established); each logs exactly one JSONL line. Verified: `Mosh --selftest` **261/261**, 0 assertions — incl. a *genuine* undo-isolation check (create_track→undo drops the count by 1; an immediate undo after open_project is a no-op, proving no stray transaction leaked) and project round-trips on temp files with clean teardown.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `MON-007` | must | Audio-engine / device gate | ◐/✗ → ✓/✓ |
| `FLY-004` | must | Device / audio gate before processing | ◐/✗ → ✓/✓ |
| `PRJ-001` | must | New project | ◐/✗ → ✓/✓ |
| `PRJ-002` | must | Open project | ◐/✗ → ✓/✓ * |
| `PRJ-003` | must | Save / Save As | ✓/◐ → ✓/✓ |
| `MON-001` | must | Audio device selection | ◐/✗ → ✓/✓ * |
| `MON-002` | must | Buffer & sample-rate config | ◐/✗ → ✓/✓ * |
| `IOX-001` | must | Import audio (common formats) | ◐/◐ → ✓/✓ * |

\* Command surface + UI + snapshot complete and headless-verified (enumerate shape, graceful no-device errors, gate field, `undoable:false`, project round-trips). **Live CoreAudio device enumeration content, a device round-trip changing the real buffer size, and the modal `FileChooser` dialog need the GUI + hardware** — the same honest gate the project documents for recording/metering. `import_clip` itself is headless-proven; only the file dialog that feeds it is GUI-gated. Also nudged `PRJ-008` (project settings — rate/depth readout) and `PRE-001` (audio prefs) toward partial.

**Shipped-on-both-axes: 62 → 70** (must-tier 48 → 56). The app now opens/creates/saves projects, picks an audio device, gates play/record/export on a real engine-ready signal, and imports user audio — the conventional-DAW shell around the neural spine is closed.

### 2026-06-09 · Wave: Keyboard shortcuts + clip clipboard ✅

The "feels like a real DAW" gap. One new backend command **`paste_clip`** (undoable — reconstructs a clip from a `clipToVar`-shaped descriptor on a target track: wave via `insertWaveClip`+`setGainDB`, midi via `insertMIDIClip`+note re-add, mirroring `cmdImportClip`/`cmdAddNote` exactly + the `createAudioTrack` AsyncUpdater drain so no itemID assert fires headless). Cheap per-type preconditions (wave `sourceFile` exists) are validated **before** the transaction/track-create, so a malformed descriptor errors with zero side effects. UI: a single global **keyboard layer** (`useKeyboardShortcuts`) — Space play/stop, R record, Mod+Z/Shift+Z undo/redo, Mod+S save, Delete remove, Mod+C/X/V copy/cut/paste, Mod+D duplicate, Home/End transport, 1/2 tool — that ignores INPUT/TEXTAREA/SELECT/contentEditable focus and `preventDefault`s the browser-conflicting combos. The clip clipboard is UI-local state (`copySelection`/`cutSelection`/`pasteClipboard`); the descriptor crosses the bridge only inside `paste_clip` (seam preserved). Delete handling was **consolidated** out of `Arrangement.tsx` into the one hook (was firing twice). Verified: `Mosh --selftest` **289/289**, 0 assertions — paste round-trips a wave clip (length/name/start match, source untouched = copy not move), undo removes it, midi notes carry across, and a failed wave paste leaves no orphan clip.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `CTL-002` | must | Keyboard shortcuts | ✗/✗ → ✓/✓ * |
| `AED-001` | must | Cut / copy / paste / delete | ✗/✗ → ✓/✓ |

\* The shortcut bindings are a window-keydown layer (not headless-scriptable, like any key-event UI), but every action they invoke is a proven command (`paste_clip` and the rest are selftest-covered). `paste_clip`, delete (`remove_clip`), and duplicate (`duplicate_clip`) are all headless-verified.

**Shipped-on-both-axes: 70 → 72** (must-tier 56 → 58). Clip editing is now fast and conventional: select, copy/cut/paste/duplicate/delete by keyboard, transport and undo/redo without reaching for the mouse.

### 2026-06-09 · Wave: Export dialog + format / bit-depth / sample-rate ✅

`export_audio` rendered the whole mix but the button sent `{}`. It now honors **format** (wav/aiff/flac), **bitDepth**, and **sampleRate** (all optional; absent = WAV/24/device-rate). Format resolves through the engine's `AudioFileFormatManager` (per-format getters + destination-extension inference + WAV fallback), the destination extension is forced to match, and an unknown format **errors before any render** (no half-written file). Bit depth is validated against that format's `getPossibleBitDepths()` — an unsupported depth errors rather than writing a corrupt file. Export stays non-undoable (output op, no transaction). While here, closed the pre-existing master-meter ABA gap in export (`unregisterAllMeterClients()` + `lastSeenContext = nullptr` after `freePlaybackContext()`, matching the project-swap commands). UI: a new `ExportDialog` popover (modeled on Settings) — Choose… (reuses the existing `pickSaveFile` native fn), Format / Bit depth / Sample-rate selects, changing format updates the filename extension; replaces the bare Export button and keeps the `audioEnabled` gate. Verified: `Mosh --selftest` **299/299**, 0 assertions — wav@16 and aiff@24 each render a real non-empty file with the echoed format+depth (proves the args are honored, not hardcoded), and unsupported format/depth both error.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `IOX-002` | must | Export / bounce mixdown (dialog) | ✓/◐ → ✓/✓ |
| `IOX-007` | must | Format / rate / depth options | ◐/✗ → ✓/✓ |

The render path is headless-proven (`renderToFile` writes real wav/aiff files in the selftest); only the modal save-file dialog that picks the destination is GUI-gated (it reuses the same `pickSaveFile` already shipped in the settings wave). `export_audio` was extended, not added — command surface stays 81.

**Shipped-on-both-axes: 72 → 74** (must-tier 58 → 60). The full producer loop now ends in a real bounce dialog: pick destination, format, depth, rate, export.

### 2026-06-09 · Wave: Command-log inspector + UI scale ✅

The "canonical command contract exists but is never shown" gap — on-brand for a DAW where *every* state change is a logged command. New read-only command **`get_command_log`** (`{ limit }` → `{ entries:[{ts,seq,command,ok,undoable,error?}], total }`, most-recent-first, limit-clamped 1..500): it parses the JSONL tail defensively (missing file → empty; malformed/partial/non-object lines skipped, never a crash) and — critically — is **truly read-only**: no `logLine`/transaction/emit, so it never appears in the very log it returns (proven both in-array and at the file). UI: a `CommandLog` inspector popover (lazy-loads via `get_command_log`, ok/error dot + undoable badge + timestamp, Refresh) mounted in the topbar — the command spine made visible. Also added a **UI-scale** control (`ACC-005`): a compact A-/A+ stepper in a Settings "Display" group, applied via document zoom — pure UI-local view state (like theme), never a command. Verified: `Mosh --selftest` **315/315**, 0 assertions — entries are most-recent-first (entry[0] == the last command issued, would fail if mis-ordered), `total` grows by *exactly* the commands issued, injected malformed/non-object lines are skipped (total unchanged), and the log carries zero `get_command_log` tokens.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `AGT-001` | must | Canonical command contract (inspectable) | ◐/✗ → ✓/✓ |
| `ACC-005` | must | Hi-DPI / scalable UI | ✓/◐ → ✓/✓ |

**Shipped-on-both-axes: 74 → 76** (must-tier 60 → 62). The architecture is now visible to the user — the 82-command surface and its JSONL audit trail have a live inspector, and the whole UI scales.

### 2026-06-09 · Wave: Render-layer management (NRL-004) + PDC/latency indicator (MON-004) ✅

Two of the three "polish" features (the third, drag-and-drop, is split out below — its first impl was caught broken in review). **NRL-004:** the generative render-layer drawer (`GenPanel`) exposed only create/render/accept/reject; this wires the rest of the lifecycle — bypass toggle, Freeze, Bounce-to-clip, and a real **remove** (a new `remove_render_layer` command, since `reject_render` only flags the layer dirty and nothing cleared the node; it mirrors `cmdRemovePlugin` — `removeChild` in an undoable transaction). Accept vs Reject tooltips disambiguated; bypassed/frozen/bounced status badges added. (Honest limit: `bypass_layer` records intent in the tree and survives save/reload but does not yet re-route audio — a deeper engine change.) **MON-004:** the snapshot gains `totalLatencySamples` / `totalLatencyMs` / `latencyContextReady` from `EditPlaybackContext::getLatencySamples()` (the same whole-graph reported latency Tracktion's PDC uses), surfaced as a "PDC X ms" readout in the transport. Verified: `Mosh --selftest` **340/340**, 0 assertions — `remove_render_layer` + undo/redo round-trips, bypass/freeze status transitions, and the latency field is present, non-negative, ms==samples/rate consistent, and honestly `latencyContextReady=false` headless (no fake 0.0; the live number is gated on a real graph).

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `NRL-004` | must | Render-layer management | ✓/◐ → ✓/✓ |
| `MON-004` | must | Plugin delay compensation (indicator) | ✓/◐ → ✓/✓ |

**Shipped-on-both-axes: 76 → 78** (must-tier 62 → 64). `BRW-007` (drag-and-drop import) remains open — see the dedicated entry below; the file picker (Settings → Import) already covers import.

### 2026-06-09 · Wave: Drag-and-drop import (BRW-007) — bytes-over-bridge ✅

The first attempt (a native `juce::FileDragAndDropTarget` overlay) was caught in review as **fundamentally non-functional** — a JUCE `Component` overlay can't win the OS drag hit-test over the embedded `WKWebView` `NSView` — and reverted. This is the correct WebView approach: the JS drop handler reads the dropped file's **bytes** via `file.arrayBuffer()` (a WKWebView fires HTML5 `drop` with `File` objects; it only withholds the filesystem *path*, not the contents), base64-encodes them with a **chunked** encoder (spreading a big `Uint8Array` into `fromCharCode` overflows the stack), and sends them to a new undoable command **`import_clip_data`** `{name, dataBase64, trackId?, start?}`. The command size-guards, base64-decodes (bad data → error), writes to a **uniquified** path under `sessionDir/imports` (so two same-named drops can't overwrite each other's source — a persisted-aliasing bug caught in review), checks the write, validates real audio via `te::AudioFile::isValid()` (deletes the temp + errors on non-audio — no garbage), then inserts through a shared `importWaveFileToTrack` helper refactored out of `cmdImportClip` (one insertion path for both). A `dragover` `preventDefault` stops the WKWebView navigating to the dropped `file:///`. Verified: `Mosh --selftest` **356/356**, 0 failed — a real WAV round-trips (the imported clip is found *by its source path*, not a guessed index, and its length matches the true source duration), invalid base64 + non-audio bytes both error with no clip and no leftover file, and undo removes the clip.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `BRW-007` | must | Drag-and-drop import | ◐/✗ → ✓/✓ * |

\* The `import_clip_data` command is fully headless-proven; the drag **gesture** itself is GUI-gated (verify by dragging a WAV onto the window). **Note:** the full `--selftest` run now surfaces one pre-existing **non-fatal** `jassert` (`tracktion_EditItem.h:133`) in the Stage 3 VST3-instrument-load path — a latent duplicate-itemID registration exposed by the itemID-allocation shift from accumulated earlier test blocks; orthogonal to BRW-007 and under separate investigation (the test still passes 356/356).

**Shipped-on-both-axes: 78 → 79** (must-tier 64 → 65). Import now works both ways — the Settings picker and a direct drag-and-drop onto the arrangement.

### 2026-06-09 · Wave 16: MIDI controller input (CTL-001) + low-latency monitoring (MON-003) ✅

Live play, built on the recording wave's input-routing pattern. The research established the key fact: a controller sounds an instrument track precisely when the track is **armed** under `automatic` monitor mode — `isLivePlayEnabled()` = `acceptsInput() && a dest targets the track && (monitor==on || (automatic && recordEnabled))` — so no separate end-to-end flag is needed. Two surgical changes: (1) `MoshEngine`'s one-time input latch now also enables every MIDI input (`setMonitorMode(automatic)` + `setEnabled(true)`), pumping the message loop (the `rescanMidiDeviceList` is async) before `restartPlayback()`; (2) `cmdArmTrack`'s auto-assign — which filtered to `waveDevice` only — is now MIDI-aware: a `trackHasInstrument()` helper makes arming an **instrument** track prefer a physical/virtual MIDI input. New read-only command **`list_midi_inputs`**; the snapshot exposes per-track MIDI-input state. **MON-003:** monitoring latency is governed by the buffer size (already user-controllable via `set_buffer_size`) + the monitor path; surfaced an honest round-trip latency readout (record adjustment + output latency). Verified: `Mosh --selftest` **380/380**, 0 failed, exactly 1 assertion (the known pre-existing Stage-3 itemID one — none added) — `list_midi_inputs` is read-only + reports the gate, `arm_track` (MIDI path) is graceful `applied:false` headless and logs `undoable:false`.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `CTL-001` | must | MIDI controller input | ✗/✗ → ✓/✓ * |
| `MON-003` | must | Low-latency monitoring | ✗/✗ → ✓/✓ * |

\* The command + enablement + routing + enumeration surface is headless-verified; the **live note flow** (controller → armed instrument → audible) needs the real device and is verified by the user with their keyboard. Single-controller routing (the common case) works; multi-controller disambiguation is a noted future enhancement.

**Shipped-on-both-axes: 79 → 81** (must-tier 65 → 67). With a plugged-in interface, arming an instrument track now plays it live from a MIDI controller — the DAW responds to performance, not just the mouse.

### 2026-06-09 · Wave 17: AU hosting (INS-002) + plugin scan / blocklist / management (INS-005) ✅

Research confirmed the **hosting** half already works — `JUCE_PLUGINHOST_AU=1` registers `AudioUnitPluginFormat`, and `te::ExternalPlugin` dispatches purely on `PluginDescription.pluginFormatName`, so `load_plugin` instantiates an AU identically to a VST3 with **no per-format branching**. The gap was **cataloging**. AU scanning is genuinely dangerous (JUCE's `findAllTypesForFile` *loads* each component and marshals instantiation back to the message thread — a misbehaving AU can hang the UI, with no per-component timeout), so it ships as an **opt-in experimental** path (`MOSH_SCAN_AU=1`, off by default and in `--selftest`): cheap enumeration + per-component cataloging guarded by a **dead-mans-pedal + blacklist** (a crasher is quarantined on the next launch; `rescan` recovers the pedal first so repeated in-session rescans converge), run off the message thread. VST3 (the primary format here) is always scanned and safe. The catalog now **persists** to `~/Library/Mosh/plugin-catalog.xml`. **INS-005:** new commands `rescan_plugins` (async + progress), `get_plugin_blocklist` (read-only), `block_plugin`, `clear_plugin_blocklist` — and the review caught two real bugs that were fixed: the blocklist was ignored on VST3 scans (`addType` bypasses it) and `block_plugin` keyed the wrong namespace (Tracktion `idFor` vs JUCE `fileOrIdentifier`), so blocking silently failed; both now work (`block_plugin` resolves the UI id → `fileOrIdentifier`, and blocked plugins vanish from `list_plugins`). The PluginBrowser gained a Rescan button + format counts + blocklist view. Verified: `Mosh --selftest` **397/397**, 0 failed, exactly 1 assertion (the known Stage-3 one — none added) — `block_plugin` round-trips a real catalog entry through the blocklist and back, bad ids error, and every `list_plugins` entry carries a `format` field.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `INS-002` | must | AU hosting | ◐/✗ → ✓/✓ * |
| `INS-005` | must | Plugin scan & management | ◐/◐ → ✓/✓ |

\* AU **hosting** works (an AU loads + runs once cataloged, via `ExternalPlugin`); AU **scanning/cataloging** is an opt-in (`MOSH_SCAN_AU=1`) experimental feature with an honestly-documented hang risk on misbehaving components (crash-recovery via the dead-mans-pedal; a real fix is out-of-process scanning, deferred). Which AUs exist is machine-specific, so the selftest asserts the command/catalog surface, not AU content.

**Shipped-on-both-axes: 81 → 83** (must-tier 67 → 69). Plugin hosting now spans both Mac formats with a persisted catalog, a working blocklist, and rescan — not just a curated VST3 list.

### 2026-06-09 · Wave 18: multicore audio (PRF-001) + content browser (BRW-001) ✅

**PRF-001** — the research confirmed this is a *genuine* knob, not a dead one: Tracktion's parallel graph (`LockFreeMultiThreadedNodePlayer`) reads exactly one value, `EngineBehaviour::getNumberOfCPUsToUseForAudio()` (applied as `setNumThreads(N-1)` in both live playback and offline render). `MoshEngineBehaviour` now overrides it from an `atomic<int>` (0 = auto/all cores); the new non-undoable `set_audio_threads` command clamps to `[1..cores]`, stores the preference, and re-applies it **live** via `DeviceManager::updateNumCPUs()` (no playback restart). The snapshot exposes `availableCores` / `audioThreads` / `audioThreadsAuto`, surfaced as a thread-count stepper in Settings. Notably it's *not* device-gated — the preference + readout work headless. **BRW-001** — a read-only `list_directory { path }` (subdirs + audio files by extension, well-known roots incl. Home/Music/session imports, graceful on missing/denied paths, no recursion, `File()` guarded against relative paths) feeding a new `ContentBrowser` panel that navigates the filesystem and imports a chosen file via `import_clip`. Verified: `Mosh --selftest` **443/443**, 0 failed, exactly 1 assertion (the known Stage-3 one — none added) — `set_audio_threads` clamps/validates/round-trips and logs `undoable:false`; `list_directory` lists a seeded `.wav`, filters out a `.txt`, lists a subfolder as `isDir`, and roots resolve to real dirs.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `PRF-001` | must | Multicore audio processing | ◐/✗ → ✓/✓ |
| `BRW-001` | must | Content browser | ✗/◐ → ✓/✓ |

**Shipped-on-both-axes: 83 → 85** (must-tier 69 → 71). The audio thread count is a real, live-applied setting and users can browse the filesystem for audio — closing the last of the requested polish / hardware / advanced waves.

### 2026-06-09 · Engine patch — itemID allocator (the last known assertion) ✅

Root-caused and fixed the one non-fatal `jassert` (`tracktion_EditItem.h:133`) that surfaced
in the Stage-3 plugin-load path: `Edit::createNewItemID()` scanned only the track + clip
caches, so a plugin ID held only in `automatableEditItemCache` (reconstructed on reload, or
outliving removal via the undo stack) could be reused → a duplicate `addItem` (and, in a
*release* build, a silently overwritten `itemID → item` map — a real latent correctness bug,
not just a debug nuisance). Fixed at the root: a 9-line additive patch making the allocator
scan **all** `EditItem` caches, shipped reproducibly as `patches/0001-…patch` applied via a
`PATCH_COMMAND` in `cmake/Dependencies.cmake` (not a fragile `.cpm-cache` hand-edit). Added a
load→save→reload→remove→load regression guard to `--selftest`. Verified: **`--selftest`
assertion count 1 → 0**, 451/451 checks, 0 failed. The DAW now self-tests with **zero**
assertions.

### 2026-06-09 · Wave A: project settings (PRJ-008) + device-pref persistence (PRE-001) ✅

New non-undoable **`set_project_settings`** `{sampleRate?, bitDepth?, timeBase?}` stores
per-project *intent* on a `MOSH_PROJECT` child of the Edit's own ValueTree (so it rides the
`.tracktionedit` through save/reload — no new storage format), surfaced as `session.project`
(device readout is the live fallback) and as a "Project format" group in Settings; `export_audio`
now defaults its depth/rate from it when omitted. **PRE-001:** device prefs did *not* persist —
filled the gap by writing `adm().createStateXml()` to `session/audio-device.xml` on a successful
device change and restoring it in engine init before the env-var fallback. **`ARE-003`** advanced
to partial (latency readout + graceful headless record; the take-landing alignment rides Wave B).
While landing this I also made the **whole suite deterministic**: fixed a flaky `get_command_log`
count (`==` → `>=`, tolerating late async logs), made the project-settings reads non-mutating
(snapshot is read-only again), seeded the export-default check with a renderable clip, and drained
the generative service's async backlog before the downstream blocks. Verified: **`--selftest`
484/484 across 6 repeated runs, 0 failed, 0 assertions** (previously 1-in-N flaky).

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `PRJ-008` | must | Project settings (rate / depth / time base) | ◐/✗ → ✓/✓ |
| `PRE-001` | must | Audio / MIDI preferences (persistent) | ◐/◐ → ✓/✓ * |

\* The `set_project_settings` round-trip and the device-pref *write* are headless-verified; the
full cross-restart device round-trip (re-opening a saved interface on next launch) is
hardware-gated. `ARE-003` (latency-compensated take landing) completes in Wave B.

**Shipped-on-both-axes: 85 → 87** (must-tier 71 → 73). Projects now carry format intent that
survives save/reload, and a chosen audio device persists.

### 2026-06-09 · Wave B: full record-to-take (TRA-002 + MID-001 + ARE-003) ✅

The arm/monitor routes shipped earlier; this closes the **stop-and-land** half. New
non-undoable **`stop_recording`** stops the transport KEEPING takes (`transport.stop(discard=false,
clearDevices=false)` — landing is synchronous inside `stop()` via `performStop → stopRecording →
applyRecording`), then **diff-detects** the freshly-landed clip(s) across every armed track and
returns `data.clips:[ids]`. **MIDI shares the exact path** — an armed instrument track lands a
`MidiClip` (already serialized by `clipToVar`), so `MID-001` needs no separate command. The record
button now drives `stop_recording` and auto-selects the returned take so it's immediately editable
(+ a recording-active pulse). `ARE-003`: the latency-compensated start is applied by the engine on
landing (read straight from the clip position). Graceful headless: `ok` + `applied:false` +
`clips:[]` + a reason (never an error) when there's no input/device. Verified: `Mosh --selftest`
**500/500 across 3 runs, 0 failed, 0 assertions** — `stop_recording` is graceful + non-undoable
headless and emits the right events.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `TRA-002` | must | Record (to a take) | ✓/◐ → ✓/✓ * |
| `MID-001` | must | MIDI record | ◐/✗ → ✓/✓ * |
| `ARE-003` | must | Latency-compensated recording | ◐/◐ → ✓/✓ * |

\* The `stop_recording` command surface + landed-clip detection + graceful degradation are
headless-verified. The **actual take landing** (an audio clip from a live input; a MIDI clip from a
controller) and the latency alignment need the real device — verified live on the interface +
keyboard (arm a track → record → play → stop → the take appears).

**Shipped-on-both-axes: 87 → 90** (must-tier 73 → 76). The record loop is closed end to end:
arm, monitor, record, and the take lands on the track (audio or MIDI).

### 2026-06-09 · Wave C: time-range edit target (ARR-010) + inline automation lanes (AUT-003) ✅

**ARR-010:** new undoable **`delete_time_range`** `{start, end, trackIds?}` — phase 1 splits every
overlapping clip at the range bounds (stable-copy iteration, splitting at the *later* bound first so
the earlier split can't shift which clip the end falls inside; same `splitClip` primitive as
`split_clip`), phase 2 removes every segment lying fully inside the range (collect-then-remove, no
mutate-while-iterating), all in **one** transaction with AsyncUpdater drains between phases. The
range itself is **UI-local view state**: a new "Range" tool draws a translucent band on the lanes,
and a Delete-range action sends `{start,end}` across the bridge only when invoked. **AUT-003:**
**zero new backend** — a new `InlineAutomationLane` strip under each track reuses the
AutomationPanel draw math at `laneHeight` + the same `pxPerSec` mapping (points align with clips),
exec'ing only the existing `add/set/remove_automation_point`; a compact per-track param picker is
UI-local. Verified: `Mosh --selftest` **522/522 across 3 runs, 0 failed, 0 assertions** — the range
delete asserts actual segment positions (0..1s + 2..4s with the 1..2s gap), undo restores the single
0..4s clip, start>=end errors leave the clip untouched, no-overlap and empty-track are no-ops, and
an enclosed clip is removed whole.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `ARR-010` | must | Time / range selection (edit target) | ◐/◐ → ✓/✓ |
| `AUT-003` | must | Automation lanes (inline under-track) | ◐/◐ → ✓/✓ |

**Shipped-on-both-axes: 90 → 92** (must-tier 76 → 78). A time-range is now a real edit target and
automation reads in-context under every track.

### 2026-06-09 · Wave D: group / submix tracks (MIX-008) ✅

The last closeable must-tier. Research confirmed the load-bearing engine fact: a `te::FolderTrack`
created `asSubmix=true` **genuinely sums** its children — the graph builder routes every child
through a `SummingNode` wrapped by the folder's own plugin chain (proven by the engine's own
nested-submix test), and `insertNewFolderTrack(asSubmix=true)` adds the default VolumeAndPan +
LevelMeter, which is exactly what keeps `isSubmixFolder()` true. So the group has a **real fader**
and the summing is engine-owned, not a Mosh claim. Two new undoable commands:
**`create_group_track`** `{name?, trackIds?}` (inserts the submix folder + moves the members under
it, one transaction; unknown ids skipped + reported) and **`ungroup_track`** `{trackId}` (hoists the
members back to top level in order + deletes the folder, one transaction). The existing
`set_track_volume` / `rename_track` resolve group ids (the fader is the folder's own VolumeAndPan).
Snapshot: additive — group entries appended after the audio tracks (`type:"group"`, `isGroup`,
fader fields, empty clips) and grouped members carry `parentId`, so every flat consumer is
unbroken. UI: a `GroupStrip` in the Mixer (fader + ungroup) + "+ Group" toolbar action, grouped
tracks indent with a badge in the arrangement, and **Mod+G** groups the selected clips' tracks.
Verified: `Mosh --selftest` **554/554 across 3 runs, 0 failed, 0 assertions** — 32 checks covering
create/move, snapshot structure, the group fader at -6 dB, rename, single-step undo/redo of the
whole group operation, ungroup round-trip, graceful unknown-id handling, and JSONL `undoable:true`.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `MIX-008` | must | Group / bus tracks (summing submix) | ◐/✗ → ✓/✓ |

*(Implementation note: the Wave D workflow's implement/review agents hit a harness/model
incompatibility, so this wave was implemented and reviewed directly from the workflow's verified
research plan.)*

**Shipped-on-both-axes: 92 → 93** (must-tier 78 → **79 of 82**). The mixer now has true submix
groups. The only remaining must-tier are the three deferred-with-rationale infra items:
`RTG-001`/`RTG-002` (per-channel input/output routing — needs a graph routing matrix) and
`SES-001`'s full tempo-map (tempo automation — a warp/groove subsystem).

### 2026-06-09 · Wave R: routing — input choice (RTG-001) + output routing (RTG-002) ✅

The "needs a routing matrix" deferral was **wrong** — plan-mode scouts verified the engine has both
subsystems fully. **RTG-001:** the `DeviceManager` already builds one `WaveInputDevice` per stereo
pair / mono channel, and `InputDeviceInstance::setTarget` assigns *any* input to *any* track —
Mosh only auto-picked the first. New: read-only **`list_wave_inputs`** + **`set_track_input`**
`{trackId, deviceID}` (a non-undoable preference, like arm/monitor): the choice is stored on the
track's own state tree (`moshInputDevice` — saves/reloads with the edit), the live instance is
retargeted (arm state preserved across the swap), and **`arm_track` now prefers the chosen input**
before first-match. **RTG-002:** every track owns a `te::TrackOutput` — route to any hardware out
(`setOutputToDeviceID`) **or into another track** (`setOutputToTrack`; the graph sums feeders via a
`SummingNode` — an implicit bus), ValueTree-persisted + Edit-undoable with built-in cycle detection.
New: **`set_track_output`** `{destTrackId | deviceID | output:"default"}` (undoable, cycle/self
rejected *before* applying) + read-only **`list_track_outputs`**. Snapshot (additive): per-track
`input {deviceID,name}` + `output {isTrack,destId,name}` (absent = default; a missing device
surfaces its persisted name). UI: compact **in:/out: selectors** on every mixer strip (hardware
outs + "→ track" destinations). Verified: `Mosh --selftest` **583/583 across 3 runs, 0 failed,
0 assertions** — 29 checks incl. the fully-headless track→track route (A→B reflects + persists
across save/reload, **B→A and A→A rejected as cycles**, reset-to-default + undo restore), the
input-choice round-trip, read-only non-logging, and both JSONL postures.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `RTG-001` | must | Configurable inputs | ◐/✗ → ✓/✓ * |
| `RTG-002` | must | Configurable outputs | ◐/✗ → ✓/✓ * |

\* Track→track routing + choice persistence are headless-proven. **Live capture from a chosen
channel pair** and **audible multi-out routing** need the interface — verified live (pick "in: 3-4"
on a strip, arm, record; route a strip to another hardware out).

**Shipped-on-both-axes: 93 → 95** (must-tier 79 → **81 of 82**). Only `SES-001`'s tempo map
remains.

### 2026-06-09 · Wave T: the tempo map (SES-001 — full time model) ✅ · **MUST-TIER COMPLETE**

The engine's `TempoSequence` natively supports multi-point tempo + time-sig maps (insert/remove/
`toBeats`/`toTime`; playback honors the map with no clip-anchoring work) — the genuine build was
**Mosh's UI time model**. Four new undoable commands: **`insert_tempo_change`** `{time, bpm}` /
**`remove_tempo_change`** `{index}` (index 0 protected — it's the base, edited by `set_tempo`) /
**`insert_time_sig_change`** / **`remove_time_sig_change`**. Changes are **steps** (curve=1.0 —
verified in the engine source: the ramp branch is gated on `curve != ±1`), which makes the UI's new
**piecewise-constant** mapping *exact* — no duplicated engine math, no drift. Snapshot (additive):
`session.tempoMap` + `session.timeSigMap`, times computed by the engine's own conversion;
`session.tempo`/`timeSig*` stay point 0 for back-compat. `ui/src/time.ts` gains the map machinery
(`tempoMapFrom`/`meterAt`/`gridLines`/`snapTimeMap`/`secondsToBBSMap`; every change point starts a
fresh bar) and **every consumer went map-aware**: the ruler + gridlines render true bar boundaries
(with tempo/meter markers at each change), snap restarts its grid at changes, the BBS readout walks
the map, and the piano roll uses the meter local to its clip's start (documented simplification).
A tempo-map popover on the transport lists the points with "+ @ playhead" / remove. Verified:
`Mosh --selftest` **614/614 across 3 runs, 0 failed, 0 assertions** — **engine truth asserted**:
bpm 120@5s / **140@15s (step, no ramp)** / 90@25s / 120 held just before the change, a
beats↔seconds round-trip across both boundaries, save/reload persistence, removal reverts +
undo restores, index-0 + bad-arg guards, JSONL `undoable:true`.

| ID | Tier | Feature | Before → After |
|---|---|---|---|
| `SES-001` | must | Single canonical time model (full tempo map) | ◐/◐ → ✓/✓ |

**Honestly deferred beyond the audit:** tempo **curves/ramps** (the engine supports Bezier; Mosh
inserts steps only) and **audio warp** (clip time-stretch following the map).

**Shipped-on-both-axes: 95 → 96. Must-tier: 81 → 82 of 82 — COMPLETE.** Every table-stakes
feature in the 266-feature conformance audit is now shipped on both axes (capability + surface),
with tempo ramps/warp as the only named, deliberate deferral beyond it.

### 2026-06-09 · Wave V: tempo ramps + audio warp — the last named deferral, closed ✅

**Ramps:** the engine's Bezier curve machinery was already there — a `TempoSetting`'s curve shapes
the glide FROM that point TO the next (±1 = step; (-1,1) ramps: <0 log, 0 linear, >0 exponential),
and playback subdivides each ramp into the engine's own ≤100 linear sections. New:
**`set_tempo_curve`** `{index, curve}` (undoable) + a `curve` arg on `insert_tempo_change`. The
UI-exactness trick: when any ramp exists, the snapshot emits **`tempoSections`** — the engine's
OWN subdivision boundaries (the same `clamp(4·beats, 1, 100)` formula, times/bpm read back through
its `toTime`/`getBpmAt`) — so `ui/src/time.ts`'s mapping is engine-faithful by construction.
Bars now flow **continuously through a ramp** (compressing with the local tempo) while explicit
changes still start fresh bars; snap went beat-domain so it stays musical mid-ritardando; a
step/ramp toggle per point lives in the tempo-map popover. Step-only maps keep the lean snapshot +
the exact piecewise-constant path. **Warp:** `AudioClipBase::setAutoTempo` re-anchors a clip in
BEATS so it time-stretches to follow the map — and the remap is **immediate** (no proxy wait),
making warp fully headless-verifiable. New **`set_clip_warp`** `{clipId, autoTempo, sourceBpm?,
mode?}` (undoable; sourceBpm defaults to the map tempo at the clip start = 1:1 at enable);
stretching uses the engine's **vendored SoundTouch**, enabled at build
(`TRACKTION_ENABLE_TIMESTRETCH_SOUNDTOUCH` — no new external dependency; `defaultMode =
soundtouchBetter`). A **Warp** toggle joins ClipActions; the snapshot carries
`autoTempo`/`stretchMode`/`sourceBpm`. Verified: `Mosh --selftest` **650/650 across 3 runs,
0 failed, 0 assertions** — engine truth mid-ramp (bpm strictly between the endpoints, monotonic),
fine sections emitted only when ramped (lean otherwise) + strictly increasing, undo/redo of the
curve, and the warp contract: **half tempo doubles the warped clip's length** (4.0s), restoring
tempo restores it, an unwarped clip ignores tempo changes, and the stretch mode is SoundTouch.

**Still genuinely deferred (the honest tail):** free warp **markers** (per-transient nonlinear
warping — a separate editing subsystem, orthogonal to auto-tempo).

### 2026-06-18 · Plugin-hosting stability — runtime teardown aborts (INS-002/INS-005 addendum): finding + deferral 🔍

While fixing a flaky `--selftest` we root-caused a real but **narrow** class of crash: a few
plugins abort the whole process **on teardown at runtime** (host → remove), because hosting is
in-process with no isolation. Two confirmed on this machine (macOS 26.4.1), both the same shape —
an uncaught C++ exception reaching `std::terminate` → `abort`:

- **SIR Audio Tools "StandardCLIP"** (a cracked VST3): its own `QueueControlThread` locks an
  already-freed `std::mutex` after the instance is destroyed → `__throw_system_error`. Faults on
  the *plugin's own thread* (its binary is in the backtrace). Crash report
  `Mosh-2026-06-18-040322.ips`.
- **Stock Apple AUs** (e.g. AUSampler / AUVectorPanner): a `CAEventReceiver` timer fires after
  teardown with a cleared `std::function` → `bad_function_call`, on the **message thread** during a
  *later, unrelated* command (`createAudioTrack` pumping `runDispatchLoopUntil`). The AU's code is
  in Apple frameworks, not the backtrace; the crash is temporally divorced from the `remove_plugin`
  that caused it. Crash report `Mosh-2026-06-18-061131.ips`.

**Decision: no product mitigation built — deferred by design (YAGNI).** Rationale, on the evidence:
(1) **Surfaced by the harness, not by use** — the selftest churns load→remove over arbitrary
catalog plugins ([SelfTest.cpp](../src/app/SelfTest.cpp)); the fix was an `isHarnessHostablePlugin()`
allowlist so the harness only hosts vetted plugins. No normal interactive session has been observed
hitting either. (2) **Blast radius is bounded** — autosave + save-on-quit (gap 1,
[MoshEngine.cpp](../src/engine/MoshEngine.cpp)) cap the loss to one autosave interval, not the
session. (3) **Scanning is a different layer and already hardened** — the OOP child scanner +
dead-man's-pedal + watchdog + persisted blocklist (Wave 17 above) handle scan-time crashes incl.
the user's Waves install; this finding is *not* about Waves or scanning. (4) **A manual lever
already exists** — `block_plugin` quarantines any misbehaving plugin by hand (resolves UI id →
`fileOrIdentifier`; blocked plugins vanish from `list_plugins`).

**Options considered and parked** (revisit only if real-world reports accumulate): (a) a runtime
dead-man's-pedal via a `std::terminate` handler + `backtrace`/`dladdr` attribution that auto-
blocklists a self-attributing crasher on next launch — works for the StandardCLIP class (plugin
binary in the stack), best-effort only for the Apple-AU-timer class (system frameworks in the
stack, crash divorced from the remove); rejected now as a whole subsystem running every session for
a harness-only risk. (b) a baked-in known-bad denylist — fine for an unambiguous crack like
StandardCLIP, but a global block of *stock* Apple AUs is likely macOS-version-specific and would
remove a real instrument for everyone. (c) **out-of-process hosting** — the only true fix (survives
all crash classes incl. hangs), but a major project (RT audio across a process boundary, editor
reparenting, automation/preset marshalling); the OOP *scanner* proves the child-process model but
live hosting is a continuous RT data plane, not request/response. **Needs sign-off before any work.**

## Coverage by category

Per axis the three counts are **present ✓ / partial ◐ / missing ✗** (missing also folds in the one `not_applicable`).

| Category | Code | must | should | nice | total | Cap ✓ | Cap ◐ | Cap ✗ | Surf ✓ | Surf ◐ | Surf ✗ |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Project & Session Management | `PRJ` | 4 | 5 | 0 | 9 | 1 | 3 | 5 | 0 | 1 | 8 |
| Transport & Playback | `TRA` | 7 | 6 | 1 | 14 | 4 | 2 | 8 | 2 | 2 | 10 |
| Arrangement & Timeline | `ARR` | 11 | 11 | 2 | 24 | 6 | 5 | 13 | 5 | 5 | 14 |
| Tempo & Time Signature | `TMP` | 1 | 3 | 2 | 6 | 0 | 1 | 5 | 0 | 0 | 6 |
| Audio Recording | `ARE` | 3 | 3 | 0 | 6 | 0 | 1 | 5 | 0 | 0 | 6 |
| Audio Editing | `AED` | 3 | 6 | 4 | 13 | 2 | 0 | 11 | 2 | 0 | 11 |
| MIDI Recording & Editing | `MID` | 5 | 9 | 4 | 18 | 0 | 3 | 15 | 0 | 0 | 18 |
| Instruments & Plugin Hosting | `INS` | 6 | 9 | 1 | 16 | 3 | 5 | 8 | 2 | 3 | 11 |
| Audio Effects & Processing | `FX` | 2 | 9 | 2 | 13 | 1 | 2 | 10 | 2 | 1 | 10 |
| Mixing & Mixer | `MIX` | 8 | 5 | 3 | 16 | 3 | 2 | 11 | 2 | 1 | 13 |
| Routing & Signal Flow | `RTG` | 3 | 3 | 2 | 8 | 0 | 2 | 6 | 0 | 0 | 8 |
| Automation | `AUT` | 4 | 4 | 1 | 9 | 0 | 0 | 9 | 0 | 0 | 9 |
| Warp & Audio-to-Tempo | `WRP` | 0 | 3 | 1 | 4 | 0 | 0 | 4 | 0 | 0 | 4 |
| Browser & Asset Management | `BRW` | 2 | 4 | 2 | 8 | 0 | 2 | 6 | 0 | 2 | 6 |
| Import / Export / Render | `IOX` | 3 | 6 | 4 | 13 | 3 | 4 | 6 | 0 | 2 | 11 |
| Metering & Analysis | `MTR` | 1 | 5 | 4 | 10 | 0 | 3 | 7 | 0 | 0 | 10 |
| Monitoring, Latency & Audio Engine | `MON` | 5 | 2 | 2 | 9 | 1 | 4 | 4 | 0 | 2 | 7 |
| Control, Keys & Hardware | `CTL` | 2 | 4 | 2 | 8 | 0 | 1 | 7 | 0 | 0 | 8 |
| Sync & External | `SYN` | 0 | 3 | 2 | 5 | 0 | 0 | 5 | 0 | 0 | 5 |
| Score & Notation | `SCR` | 0 | 0 | 3 | 3 | 0 | 0 | 3 | 0 | 0 | 3 |
| Video | `VID` | 0 | 0 | 4 | 4 | 0 | 0 | 4 | 0 | 0 | 4 |
| Accessibility & UX Foundations | `ACC` | 2 | 5 | 2 | 9 | 4 | 4 | 1 | 3 | 3 | 3 |
| Performance & Reliability | `PRF` | 1 | 4 | 0 | 5 | 2 | 2 | 1 | 0 | 2 | 3 |
| Settings & Preferences | `PRE` | 1 | 2 | 1 | 4 | 0 | 2 | 2 | 1 | 0 | 3 |
| Help & Onboarding | `HLP` | 0 | 0 | 3 | 3 | 0 | 1 | 2 | 0 | 1 | 2 |
| Mosh · Structured Session Model & Time Coherence | `SES` | 3 | 3 | 0 | 6 | 2 | 2 | 2 | 2 | 1 | 3 |
| Mosh · Neural Transform Layer | `NRL` | 2 | 3 | 3 | 8 | 5 | 1 | 2 | 4 | 2 | 2 |
| Mosh · Agent / Operator Layer | `AGT` | 1 | 4 | 0 | 5 | 0 | 3 | 2 | 0 | 0 | 5 |
| Mosh · Acceptance-Signal Data Flywheel | `FLY` | 2 | 2 | 1 | 5 | 2 | 3 | 0 | 1 | 1 | 3 |
| Mosh · Real-time Collaboration | `COL` | 0 | 4 | 1 | 5 | 0 | 2 | 3 | 1 | 1 | 3 |
| **TOTAL** | | **82** | **127** | **57** | **266** | **39** | **60** | **167** | **27** | **30** | **209** |

## Both-axes DONE — the true shipped-feature count

**24 / 266** features are present on BOTH axes (the only ones that actually count as shipped):

| ID | Tier | Feature |
|---|---|---|
| `TRA-001` | must | Play / Stop |
| `TRA-003` | must | Loop / cycle playback |
| `ARR-001` | must | Tracks |
| `ARR-002` | must | Audio clips / regions |
| `ARR-011` | must | Move clips |
| `ARR-012` | must | Trim clip edges |
| `ARR-013` | must | Split / cut clips |
| `AED-002` | must | Trim / slip |
| `AED-003` | must | Split |
| `INS-001` | must | VST3 hosting |
| `INS-007` | must | Insert effect chains |
| `FX-011` | should | Effect bypass / wet-dry |
| `MIX-002` | must | Volume fader per channel |
| `MIX-004` | must | Mute / solo |
| `ACC-001` | must | Undo / redo |
| `ACC-007` | should | Tooltips / contextual help |
| `ACC-008` | nice | High-contrast / themes |
| `SES-002` | must | Non-destructive source-graph architecture |
| `SES-003` | must | Structured-document session format |
| `NRL-001` | must | SA3 freeze-and-render workflow |
| `NRL-002` | should | Color Rack with steerable axes |
| `NRL-003` | should | Two-tier inference architecture |
| `NRL-007` | nice | Judge-panel quality gating |
| `FLY-001` | must | Render accept / reject surface |

Of these, **18** are must-tier, **4** should-tier, **2** nice-tier. Note how heavily the "done" list leans on the neural spine (NRL/FLY/SES) and the arrangement basics — the conventional-DAW middle (recording, MIDI, mixing, automation, metering) contributes almost nothing.

## Capability without Surface — hidden work (built but not exposed)

The explicit failure mode this audit hunts for: the engine can do it, but no control reaches it. These are the cheapest wins — they need UI wiring, not new DSP.

### Fully built, zero surface (5) — wire a control and they ship

| ID | Tier | Feature | What exists in code | What's missing |
|---|---|---|---|---|
| `TRA-002` | must | Record | transport.record() works in the engine | no Record button; UI never sends action:'record' |
| `MIX-003` | must | Pan | set_track_pan sets VolumeAndPanPlugin pan; pan in snapshot | no pan knob rendered in the track header |
| `IOX-003` | should | Offline (faster-than-real-time) render | offline 'fast' render mode parsed and supported | Export button sends no renderMode; no selector |
| `IOX-004` | should | Real-time render | real-time render mode supported + auto-selected for Serum | no real-time render option in the UI |
| `FLY-002` | should | Acceptance-signal capture | accept/reject written to JSONL as taste labels w/ context | acceptance history/provenance never displayed |

### Partially built, no surface (38) — capability is real but incomplete, and still unexposed

| ID | Tier | Feature | Capability note |
|---|---|---|---|
| `PRJ-001` | must | New project | MoshEngine.cpp:60 createEmptyEdit on cold start (default audio/time settings), but no new-project command and single fixed session dir; no templates. |
| `PRJ-002` | must | Open project | MoshEngine.cpp:50-53 loads the single fixed ~/Library/Mosh/session/session.tracktionedit at startup; no open-by-path, no recent files. |
| `PRJ-008` | must | Project settings (rate / depth / time base) | Sample rate read from device (MoshOps.cpp:1251); export bitDepth hardcoded 24 (MoshOps.cpp:1118); no per-project stored rate/depth/time-base honoured … |
| `TRA-006` | must | Tempo control | Tempo exists as default from createEmptyEdit and is read via tempoSequence.getBpmAt into snapshot (MoshOps.cpp:1252); no set_tempo/setBpm command exis… |
| `ARR-024` | should | Clip rename | clips store a name (insertWaveClip name MoshOps.cpp:205; clipToVar c.getName():1311) but NO rename_clip command - name only set at creation |
| `TMP-001` | must | Fixed project tempo | Tracktion edit.tempoSequence drives timing; snapshot reads getBpmAt at MoshOps.cpp:1252. No set-tempo command; default tempo only, never user-settable… |
| `ARE-005` | should | Loop recording / takes | Engine transport.record() exists (MoshOps.cpp:256) but no loop-record/takes. Out-of-band: iPhone companion records PCM takes, lands via import_clip (R… |
| `MID-001` | must | MIDI record | set_transport action 'record' calls transport.record() (MoshOps.cpp:253-256) but no MIDI input device assigned, no track arm; grep for midiInput/recor… |
| `MID-003` | must | Note create / move / resize / delete | cmdAddMidiClip can add notes via te sequence.addNote(pitch,start,length,velocity) (MoshOps.cpp:639-642), but only at clip creation from args; no comma… |
| `MID-004` | must | Velocity editing | sequence.addNote takes a velocity param, default 100 (MoshOps.cpp:642); stored in the Tracktion MIDI sequence. No command to edit an existing note's v… |
| `INS-002` | must | AU hosting | JUCE_PLUGINHOST_AU=1 (CMakeLists.txt:90) compiles AU hosting, but PluginHost::scanFile only uses VST3PluginFormat (PluginHost.cpp:90); no AU scan path… |
| `INS-009` | must | Plugin parameter automation | set_plugin_param (MoshOps.cpp:571) sets automatable params on hosted plugins; params exposed via getAutomatableParameter, but no time-varying automati… |
| `INS-011` | should | Plugin delay compensation reporting | Hosted ExternalPlugin latency feeds Tracktion graph PDC implicitly; NeuralInsert reports getLatencySeconds (NeuralInsertPlugin.cpp:102); no explicit p… |
| `MIX-010` | must | Master bus | export_audio sets params.useMasterPlugins=true (MoshOps.cpp:1128) so Tracktion's internal master sums on render, but no master channel is modeled or e… |
| `RTG-001` | must | Configurable inputs | Engine can set a whole-app input device (MoshEngine applyRequestedAudioOutputDevice, inputDeviceName 89-187) but only via MOSH_AUDIO_INPUT_DEVICE env … |
| `RTG-002` | must | Configurable outputs | Whole-app output device set via MOSH_AUDIO_OUTPUT_DEVICE (MoshEngine.cpp:89-187); no per-channel output-destination routing in the graph. |
| `BRW-007` | must | Drag-and-drop import | import_clip imports a file at an explicit path/position (cmdImportClip, MoshOps.cpp:230-235) but there is no drop-position handling tied to a UI drop … |
| `IOX-006` | should | Export selection / loop range | Renderer.Parameters.time supports a TimeRange but cmdExportAudio hardcodes the full edit: params.time = {0, edit.getLength()} (MoshOps.cpp:1125); no a… |
| `IOX-007` | must | Format / rate / depth options | bitDepth hardcoded to 24, audioFormat = default WAV, sampleRate from device (MoshOps.cpp:1116-1122); createMidiFile keyed off '.mid' extension (1129).… |
| `IOX-010` | should | MIDI file import / export | MIDI export only as a side-effect: params.createMidiFile = file.hasFileExtension('.mid') (MoshOps.cpp:1129). No MIDI import command; add_midi_clip bui… |
| `MTR-002` | should | RMS / loudness metering | RMS computed only offline on generative render artifacts: rms_dbfs (service/quality_readout.py:54-55). Not a real-time engine meter; only runs on SA3/… |
| `MTR-005` | should | Spectrum analyzer | Offline single-frame FFT (spectral centroid/rolloff) on render artifacts only (service/quality_readout.py:67-75). No real-time spectrum analyzer in th… |
| `MTR-006` | nice | Phase / correlation meter | Offline stereo correlation computed on render artifacts: corr (service/quality_readout.py:78-82), flagged out_of_phase if <0 (124). Not a live correla… |
| `MON-001` | must | Audio device selection | MoshEngine.cpp:89 applyRequestedAudioOutputDevice() binds a CoreAudio device, but only via MOSH_AUDIO_OUTPUT_DEVICE env var; no runtime selection API. |
| `MON-002` | must | Buffer & sample-rate config | Engine reads getSampleRate()/getBlockSize() (MoshOps.cpp:1122,1251); setAudioDeviceSetup (MoshEngine.cpp:177) uses defaults only - no buffer/rate conf… |
| `MON-007` | must | Audio-engine / device gate | Play/record silently guarded by 'if (eng.hasAudio())' (MoshOps.cpp:244,253); export gated at MoshOps.cpp:1189. Guard skips silently rather than gating… |
| `CTL-006` | should | Command palette / action search | All edits funnel through MoshOps::execute (MoshOps.cpp:74) dispatching 43 named commands - a searchable command index could be built on this, but no p… |
| `ACC-002` | should | Undo history | UndoManager supports stack but only undo()/redo() exposed; no getTransactionNames/jump-to-point surfaced in MoshOps. JSONL log exists but not a naviga… |
| `ACC-003` | should | Keyboard navigation | DOM controls are natively focusable, but no managed focus/keyboard handlers in C++ or React; WebViewShell.h has no key handling. |
| `PRF-001` | must | Multicore audio processing | Relies on Tracktion engine's internal audio threading; no explicit multicore config/distribution in Mosh src. MoshOps uses one ThreadPoolJob loop (114… |
| `PRF-003` | should | Large-project handling | Single te::Edit + snapshot rebuild on every snapshot_invalidated (store.refresh re-fetches all tracks/clips/peaks); no virtualization/large-session op… |
| `PRE-001` | must | Audio / MIDI preferences | Engine binds a chosen device only via env vars MOSH_AUDIO_OUTPUT_DEVICE/INPUT_DEVICE (MoshEngine.cpp:94-177); no in-app device/port selection or persi… |
| `SES-001` | must | Single canonical time model | Tracktion has an internal tempo/tick model, but Mosh stores/emits every position in SECONDS (clipToVar start/length/offset + transportToVar position, … |
| `AGT-001` | must | Canonical command contract | MoshOps.cpp:82-126 dispatch: 43 stable ID-based commands w/ result envelope + JSONL log (logLine). But spec-named ops (set_midi_note, set_automation_p… |
| `AGT-003` | should | Operator actions as first-class edits | Commands ARE undoable via Tracktion UndoManager (beginNewTransaction per cmd, e.g. MoshOps.cpp:134) so an agent would share the manual path, but no ag… |
| `AGT-005` | should | Agent presence, subordinate to the DAW | DAW is fully usable with no agent because no agent layer exists at all (App.tsx renders arrangement/rack/transport without any agent dependency). |
| `FLY-004` | must | Device / audio gate before processing | eng.hasAudio() gates play/record (MoshOps.cpp:244,253) and editor open (608); but generative render_layer gates only on service availability (834), no… |
| `FLY-005` | nice | Label dataset accumulation / export | Labelled accept/reject events accumulate in mosh-log.jsonl (MoshOps.cpp:1415-1426), but there is no read/inspect/export command or dataset assembly be… |

## Build roadmap (prioritized)

**64 must-tier gaps** and **123 should-tier gaps** remain (a gap = not present on both axes). Below they are grouped into work-waves ordered by leverage: each wave unblocks the most table-stakes features for the least new engine work, and each notes the commands / snapshot fields already in place to build on. Markers are `capability / surface` using ✓ present · ◐ partial · ✗ missing.

Legend for the per-wave feature lists: **[M]** must · **[S]** should · **[N]** nice.

---

### MUST-tier waves (do these first — table stakes)

### Wave 0 — finish the nearly-done must features (cheapest wins)

These 12 must-tier features are not gaps in spirit — most are already present on capability and only partial on surface. Closing them is mostly finishing touches (add an option, a readout, or a small command), not new subsystems. Do them opportunistically alongside the numbered waves.

| ID | Feature | cap/surf | What's left to finish |
|---|---|---|---|
| `PRJ-003` | Save / Save As | ✓/◐ | add Save As + show file name in the title (Save works; single fixed path) |
| `IOX-002` | Export / bounce mixdown | ✓/◐ | add an export dialog with destination/options (render works; button sends {}) |
| `MON-004` | Plugin delay compensation (engine) | ✓/◐ | surface a compensation status/indicator (PDC is active and proven) |
| `ACC-005` | Hi-DPI / scalable UI | ✓/◐ | add a user UI-scale control + DPI media rules (already crisp on retina) |
| `NRL-004` | Render-layer management | ✓/◐ | add a render-layer list with bypass/freeze/remove (one layer/clip today) |
| `INS-005` | Plugin scan & management | ◐/◐ | add rescan/blocklist/manager view + scan AU (curated VST3 list only) |
| `ARR-010` | Time / range selection | ◐/◐ | make a true time-range an edit target (only loop-region + clip marquee today) |
| `TMP-001` | Fixed project tempo | ◐/✗ | add a set-tempo command + show tempo (read-only, never rendered) |
| `BRW-001` | Browser | ✗/◐ | add a real content/file browser (only the plugin modal exists) |
| `AGT-001` | Canonical command contract | ◐/✗ | add a command-log/inspectable surface (43 cmds + JSONL exist, never shown) |
| `PRF-001` | Multicore audio processing | ◐/✗ | expose multicore use/settings (relies on Tracktion's internal threading) |
| `AED-001` | Cut / copy / paste / delete | ✗/✗ | add cut/copy/paste/delete (+ a remove_clip command — none exists) |

### Wave 1 — Transport / tempo / metronome surface

Highest leverage, lowest cost: most of this is engine-present and just needs controls. Tempo and time signature are the root dependency for the musical ruler, grid, and metronome, so this wave unblocks much of Arrangement.

- **Build on:** `set_transport` already does play/stop/record/loop/position (TRA-001/003 shipped); `transport.record()` exists; tempo is read into the snapshot via `getBpmAt` and sits in `session.tempo` (types.ts) but is never shown.
- **Missing:** a Record button wired to `action:'record'`; a `set_tempo`/`setBpm` command (none exists); a `set_time_signature` command and meter field in the snapshot; a metronome/click-track toggle (no `getClickTrack` usage today); go-to-end + count-in.
- **Features in this wave:**
  - `TRA-002` **[M]** Record — cap ✓ / surf ✗
  - `TRA-006` **[M]** Tempo control — cap ◐ / surf ✗
  - `TRA-007` **[M]** Time signature — cap ✗ / surf ✗
  - `TRA-008` **[M]** Metronome / click — cap ✗ / surf ✗
  - `TRA-004` **[M]** Return to start / go to end — cap ✓ / surf ◐

### Wave 2 — Bars & beats musical time + grid

Convert the seconds-based ruler/grid to musical time. This is the SES-001 'one canonical time model' promise and a hard dependency for MIDI editing, automation, and warp.

- **Build on:** the Tracktion `tempoSequence` exists; UI already has a working ruler, snap toggle, and a 0.25s grid; clip move/trim/split already round to the snap grid (`store.snapTime`).
- **Missing:** expose bars/beats in the snapshot (today everything is seconds); a bars:beats ruler instead of integer seconds; a selectable snap-resolution control (grid is hardcoded 0.25s); vertical/track-height zoom; a time-format switch.
- **Features in this wave:**
  - `ARR-004` **[M]** Timeline ruler (bars & beats) — cap ◐ / surf ◐
  - `ARR-006` **[M]** Grid & snap — cap ◐ / surf ◐
  - `ARR-007` **[M]** Adjustable snap resolution — cap ✗ / surf ✗
  - `ARR-008` **[M]** Zoom (horizontal & vertical) — cap ◐ / surf ◐
  - `SES-001` **[M]** Single canonical time model — cap ◐ / surf ✗

### Wave 3 — Recording path (arm · monitor · capture)

Make the DAW able to record. The engine has the transport-record primitive but no input arming, monitoring, or take landing.

- **Build on:** `transport.record()` is callable; the engine can bind an input device (`MOSH_AUDIO_INPUT_DEVICE`); the iPhone companion already lands PCM takes via `import_clip`, proving the new-clip-landing path.
- **Missing:** per-track `arm`/`recordEnabled` (no `armForRecording` usage); an input-monitor path; record-arm + monitor controls in the track header; latency-compensated take landing; count-in/pre-roll.
- **Features in this wave:**
  - `ARE-001` **[M]** Input monitoring — cap ✗ / surf ✗
  - `ARE-002` **[M]** Record arm — cap ✗ / surf ✗
  - `ARE-003` **[M]** Latency-compensated recording — cap ✗ / surf ✗
  - `MID-001` **[M]** MIDI record — cap ◐ / surf ✗

### Wave 4 — MIDI piano-roll & note editing

MIDI clips exist as data but are uneditable colored blocks. Build the editor; the engine can already hold and add notes.

- **Build on:** `add_midi_clip` inserts a real `te` MIDI sequence via `sequence.addNote(pitch,start,length,velocity)`; clips are tagged `type:'midi'` in the snapshot; the Rack/Arrangement already open per-track context.
- **Missing:** serialize notes into the snapshot (MIDI clips expose none today); a piano-roll view (none exists); `set_midi_note`/move/resize/delete commands; a velocity lane; quantize (no `quantize` command).
- **Features in this wave:**
  - `ARR-003` **[M]** MIDI clips — cap ✓ / surf ◐
  - `MID-002` **[M]** Piano-roll editor — cap ✗ / surf ✗
  - `MID-003` **[M]** Note create / move / resize / delete — cap ◐ / surf ✗
  - `MID-004` **[M]** Velocity editing — cap ◐ / surf ✗
  - `MID-006` **[M]** Quantize MIDI — cap ✗ / surf ✗
  - `INS-006` **[M]** Instrument tracks — cap ✓ / surf ◐

### Wave 5 — Mixer · pan · buses · master · sends

Stand up a real mixer surface and the routing it needs. Per-track volume/mute/solo already work; pan is built but unexposed; buses/sends/master are engine-absent.

- **Build on:** `set_track_volume/pan/mute/solo` all exist and round-trip; `set_track_pan` is fully wired in the engine and just lacks a knob; export already sums through `useMasterPlugins=true`.
- **Missing:** a dedicated mixer view (strips are only track headers); a pan control (cheap — capability is done); group/bus tracks (no FolderTrack/output routing); AuxSend/return for sends; a modeled master channel in the snapshot; bus/aux routing graph.
- **Features in this wave:**
  - `MIX-003` **[M]** Pan — cap ✓ / surf ✗
  - `MIX-001` **[M]** Mixer view — cap ◐ / surf ◐
  - `MIX-006` **[M]** Sends / returns / aux — cap ✗ / surf ✗
  - `MIX-008` **[M]** Group / bus tracks — cap ✗ / surf ✗
  - `MIX-010` **[M]** Master bus — cap ◐ / surf ✗
  - `RTG-003` **[M]** Bus / aux routing — cap ✗ / surf ✗
  - `RTG-001` **[M]** Configurable inputs — cap ◐ / surf ✗
  - `RTG-002` **[M]** Configurable outputs — cap ◐ / surf ✗

### Wave 6 — Channel metering

Not a single live meter exists — a glaring must-tier gap. Needs an engine level tap, then a meter component.

- **Build on:** the 30 Hz decimated event channel already exists for transport telemetry and is the natural carrier for meter data; `get_clip_peaks` proves peak math but is static/offline.
- **Missing:** a `LevelMeasurer`/level-tap on the track output (PROGRESS notes there's no public level-tap on `VolumeAndPanPlugin`); a `level` field per track in the snapshot; a meter element on the strip.
- **Features in this wave:**
  - `MTR-001` **[M]** Peak level meters — cap ✗ / surf ✗
  - `MIX-011` **[M]** Channel metering — cap ✗ / surf ✗

### Wave 7 — Built-in FX & instrument palette

Every effect and instrument today is third-party VST3. Ship a minimal native palette so the app is usable without external plugins. The one built-in is the neural saturator.

- **Build on:** the built-in `te::Plugin` registration path works (`createBuiltInType<>()` via `NeuralInsertPlugin`); insert chains, bypass, and reorder are all shipped (INS-007/FX-011).
- **Missing:** actual DSP devices: EQ, compressor, plus a synth/sampler instrument; their device UIs; AU scanning (compiled but `scanFile` only uses VST3PluginFormat, so no AU is ever cataloged).
- **Features in this wave:**
  - `FX-001` **[M]** Equalizer — cap ✗ / surf ✗
  - `FX-002` **[M]** Compressor / dynamics — cap ✗ / surf ✗
  - `INS-002` **[M]** AU hosting — cap ◐ / surf ✗
  - `FX-009` **[S]** Utility (gain / pan / width / mono) — cap ◐ / surf ◐

### Wave 8 — Automation

Zero automation exists on any axis — a whole must-tier category. Build the curve model, lanes, and a draw tool.

- **Build on:** plugins already expose `te::AutomatableParameter`; `set_plugin_param` sets static values; the lane/clip rendering scaffolding in Arrangement can host automation lanes.
- **Missing:** an `AutomationCurve`/addPoint read path (none in src); automation data in the snapshot; volume/pan + plugin-param automation lanes; a draw/pencil tool; automation modes.
- **Features in this wave:**
  - `AUT-001` **[M]** Parameter automation — cap ✗ / surf ✗
  - `AUT-002` **[M]** Volume / pan automation — cap ✗ / surf ✗
  - `AUT-003` **[M]** Automation lanes — cap ✗ / surf ✗
  - `AUT-004` **[M]** Draw / pencil automation — cap ✗ / surf ✗
  - `INS-009` **[M]** Plugin parameter automation — cap ◐ / surf ✗

### Wave 9 — Import & browser basics

Users can't bring in their own audio. `import_clip` exists but nothing in the UI calls it.

- **Build on:** `import_clip` imports any file at a path via Tracktion's format manager (WAV/AIFF/FLAC/MP3); `add_test_tone_clip` proves clip landing; `list_plugins` proves the modal-browser pattern.
- **Missing:** a file picker and an `onDrop`/drag-drop handler (none in ui/src); a content/file browser (only the plugin browser exists); an export dialog exposing destination/format (Export sends empty args).
- **Features in this wave:**
  - `IOX-001` **[M]** Import audio (common formats) — cap ◐ / surf ◐
  - `BRW-007` **[M]** Drag-and-drop import — cap ◐ / surf ✗
  - `IOX-007` **[M]** Format / rate / depth options — cap ◐ / surf ✗

### Wave 10 — Project & engine settings + device gate

New/Open project, project settings, an audio device picker, and the must-tier device gate. The engine binds devices but only via env vars, and `audioEnabled` never reaches the snapshot.

- **Build on:** `save`/`reload` work against the fixed session; the engine enumerates CoreAudio devices and gates play/record on `hasAudio()`; `audioEnabled` is computed (inside `open_plugin_editor` data) but not surfaced.
- **Missing:** New/Open/Save-As commands and a path model (single fixed session today); a settings/device-picker screen; a project-settings dialog (rate/depth); put `audioEnabled` in the snapshot and add a status gate/warning; keyboard shortcuts.
- **Features in this wave:**
  - `PRJ-001` **[M]** New project — cap ◐ / surf ✗
  - `PRJ-002` **[M]** Open project — cap ◐ / surf ✗
  - `PRJ-008` **[M]** Project settings (rate / depth / time base) — cap ◐ / surf ✗
  - `MON-001` **[M]** Audio device selection — cap ◐ / surf ✗
  - `MON-002` **[M]** Buffer & sample-rate config — cap ◐ / surf ✗
  - `MON-003` **[M]** Low-latency monitoring — cap ✗ / surf ✗
  - `MON-007` **[M]** Audio-engine / device gate — cap ◐ / surf ✗
  - `FLY-004` **[M]** Device / audio gate before processing — cap ◐ / surf ✗
  - `PRE-001` **[M]** Audio / MIDI preferences — cap ◐ / surf ✗
  - `CTL-001` **[M]** MIDI controller input — cap ✗ / surf ✗
  - `CTL-002` **[M]** Keyboard shortcuts — cap ✗ / surf ✗

### MUST-tier gaps folded into the waves above / remaining

These must-tier gaps share a wave's dependency and ride along with it:
  - `PRJ-003` **[M]** Save / Save As — cap ✓ / surf ◐
  - `ARR-010` **[M]** Time / range selection — cap ◐ / surf ◐
  - `TMP-001` **[M]** Fixed project tempo — cap ◐ / surf ✗
  - `AED-001` **[M]** Cut / copy / paste / delete — cap ✗ / surf ✗
  - `INS-005` **[M]** Plugin scan & management — cap ◐ / surf ◐
  - `BRW-001` **[M]** Browser — cap ✗ / surf ◐
  - `IOX-002` **[M]** Export / bounce mixdown — cap ✓ / surf ◐
  - `MON-004` **[M]** Plugin delay compensation (engine) — cap ✓ / surf ◐
  - `ACC-005` **[M]** Hi-DPI / scalable UI — cap ✓ / surf ◐
  - `PRF-001` **[M]** Multicore audio processing — cap ◐ / surf ✗
  - `NRL-004` **[M]** Render-layer management — cap ✓ / surf ◐
  - `AGT-001` **[M]** Canonical command contract — cap ◐ / surf ✗

---

### SHOULD-tier waves (after must-tier — competitive depth)

### Wave 11 — Audio editing depth

Round out clip editing once the grid (Wave 2) lands.

- **Build on:** `trim_clip`/`split_clip` shipped; clips keep a name and source offset in the snapshot.
- **Missing:** fades/crossfades (no fade fields), clip gain, clip mute, rename_clip, duplicate/loop, time-stretch & pitch-shift, transient detection — all engine-absent today.
- **Features in this wave:**
  - `AED-001` **[M]** Cut / copy / paste / delete — cap ✗ / surf ✗
  - `AED-004` **[S]** Fade / crossfade editing — cap ✗ / surf ✗
  - `AED-005` **[S]** Clip gain / normalize — cap ✗ / surf ✗
  - `AED-007` **[S]** Time-stretch — cap ✗ / surf ✗
  - `AED-008` **[S]** Pitch-shift — cap ✗ / surf ✗
  - `AED-009` **[S]** Transient detection — cap ✗ / surf ✗
  - `AED-013` **[S]** Audio quantize — cap ✗ / surf ✗
  - `ARR-014` **[S]** Fades & crossfades — cap ✗ / surf ✗
  - `ARR-016` **[S]** Clip gain — cap ✗ / surf ✗
  - `ARR-023` **[S]** Clip mute / disable — cap ✗ / surf ✗
  - `ARR-024` **[S]** Clip rename — cap ◐ / surf ✗
  - `ARR-015` **[S]** Duplicate / loop clips — cap ✗ / surf ✗

### Wave 12 — Track organization & arrangement polish

Folders, freeze, markers, ranges, ripple, track-height — the arranging conveniences.

- **Build on:** flat audio tracks render today; loop region exists as a shift-drag on the ruler; Tier-B `freeze_layer` exists (but is a render-layer op, not a track bounce).
- **Missing:** FolderTrack/group model, true track freeze/flatten, marker track, time-range selection target, ripple/insert-time, per-track height — none present.
- **Features in this wave:**
  - `ARR-009` **[S]** Arrangement markers — cap ✗ / surf ✗
  - `ARR-010` **[M]** Time / range selection — cap ◐ / surf ◐
  - `ARR-017` **[S]** Track folders / groups — cap ✗ / surf ✗
  - `ARR-018` **[S]** Track freeze / flatten — cap ✗ / surf ✗
  - `ARR-020` **[S]** Ripple / shift edits — cap ✗ / surf ✗
  - `ARR-021` **[S]** Track height resize — cap ✗ / surf ✗
  - `TRA-005` **[S]** Locators / cue points — cap ✗ / surf ✗
  - `TRA-013` **[S]** Playback markers — cap ✗ / surf ✗

### Wave 13 — Effects palette depth + metering

Expand the native FX set and the analysis meters once Wave 6/7 land.

- **Build on:** built-in device path + insert chain proven; offline FFT/RMS/correlation exist in the Python quality-readout (render-time only).
- **Missing:** reverb/delay/modulation/gate/limiter devices; RMS/LUFS/true-peak/spectrum/gain-reduction as live engine meters (currently offline on render artifacts only).
- **Features in this wave:**
  - `FX-003` **[S]** Reverb — cap ✗ / surf ✗
  - `FX-004` **[S]** Delay — cap ✗ / surf ✗
  - `FX-005` **[S]** Modulation (chorus/flanger/phaser) — cap ✗ / surf ✗
  - `FX-007` **[S]** Gate / expander — cap ✗ / surf ✗
  - `FX-008` **[S]** Limiter — cap ✗ / surf ✗
  - `FX-010` **[S]** Sidechain input to effects — cap ✗ / surf ✗
  - `MTR-002` **[S]** RMS / loudness metering — cap ◐ / surf ✗
  - `MTR-003` **[S]** LUFS metering (I/S/M) — cap ✗ / surf ✗
  - `MTR-004` **[S]** True-peak metering — cap ✗ / surf ✗
  - `MTR-005` **[S]** Spectrum analyzer — cap ◐ / surf ✗
  - `MTR-010` **[S]** Gain-reduction metering — cap ✗ / surf ✗

### Wave 14 — Tempo map, warp & browser/asset depth

Musical-time depth and content management.

- **Build on:** tempo sequence + snap grid exist; `import_clip` + plugin browser exist.
- **Missing:** tempo automation, time-sig changes, groove; warp markers/time-stretch (no TimeStretcher); audition/preview, tagging, search, preset browser — all absent.
- **Features in this wave:**
  - `TMP-002` **[S]** Tempo automation / tempo track — cap ✗ / surf ✗
  - `TMP-003` **[S]** Time-signature changes — cap ✗ / surf ✗
  - `TMP-006` **[S]** Groove / swing templates — cap ✗ / surf ✗
  - `WRP-001` **[S]** Time-stretch algorithm choice — cap ✗ / surf ✗
  - `WRP-002` **[S]** Warp markers / elastic audio — cap ✗ / surf ✗
  - `WRP-004` **[S]** Tempo follows audio / audio follows tempo — cap ✗ / surf ✗
  - `BRW-001` **[M]** Browser — cap ✗ / surf ◐
  - `BRW-002` **[S]** Audition / preview — cap ✗ / surf ✗
  - `BRW-004` **[S]** Tagging / favorites — cap ✗ / surf ✗
  - `BRW-005` **[S]** Search — cap ◐ / surf ◐
  - `BRW-006` **[S]** Preset browser — cap ✗ / surf ✗

---

_Nice-tier features (57: notation, video, MPE, control surfaces, sync, collaboration presence/conflict-resolution, sound-pack mgmt, onboarding, etc.) are intentionally deferred — none are table stakes and most depend on must/should-tier subsystems above. See `FEATURE_AUDIT.json` for the full per-feature capability/surface evidence._
