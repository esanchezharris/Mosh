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
