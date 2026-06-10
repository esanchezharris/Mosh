# DAW Capability Audit — the product reality check

*The standing checkbox list of what Mosh can actually do, measured against an
FL-Studio-first / Ableton-second baseline (the tutorial corpus' world). This
exists because stage gates kept passing while everyday gestures were missing —
build checklists are not product checklists. Update this doc in every stage
that adds/changes capability; future stages tick rows instead of rediscovering
holes.*

**THE CLOSURE RULE.** Everything the agent can do via MoshIR must have a human
gesture in the UI, and every UI gesture must ride a MoshOps command. The
Parity column makes IR↔UI gaps mechanical to spot.

**Status legend:** ✅ works in the UI · 🔶 command-only (no UI gesture) ·
🧠 agent/IR-only · ❌ missing everywhere · 🅿 parked by recorded decision.

Last full audit: 2026-06-10 (Stage 16).

## Project / session

| Capability | Status | Parity (IR ↔ cmd ↔ UI) | Closes in |
|---|---|---|---|
| Tempo set/edit | ✅ | project.set_tempo ↔ set_tempo ↔ BPM chip | S15 |
| Tempo CHANGES over time (tempo map) | ❌ single tempo only | — | post-v0 |
| Time signature | ✅ | project.set_time_sig ↔ set_time_sig ↔ chip | S15 |
| Key / scale | 🔶 | project.set_key ↔ set_key ↔ none | scale-aware piano roll stage |
| Swing / global groove | 🅿 engine has no groove (ledgered) | project.set_swing → Unsupported | decision: v0.3 or drop |
| Save / load / autosave | ✅ save+reload buttons; ❌ no autosave, no save-as/project browser | | project-mgmt stage |
| Undo/redo | ✅ buttons + ⌘Z/⌘⇧Z | one UndoManager | S15 |
| Sections/arrangement markers | 🧠 | arrange.create_section/place ↔ create_section ↔ no UI | arranger stage |
| Metronome | ✅ | native-only (playback aid) | S15 |
| Count-in / pre-roll | ❌ | | recording stage |

## Transport

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Play/stop/seek/loop region | ✅ | + Space, ruler drag, shift-drag loop | S2/S15 |
| Follow playhead + zoom-to-fit | ✅ | toggleable | S15 |
| Position display bars.beats + time | ✅ | | S14 |
| Master + per-track meters | ✅ | engine tap, 30 Hz feed | S14 |
| Audio output device pick | ✅ | machine-local; virtual-sink guard | S14 |
| Tap tempo / nudge | ❌ | | nice-to-have |

## Arrangement editing

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Move / trim / split clips | ✅ | optimistic drags, snap | S2 |
| Duplicate / delete clips | ✅ | ⌘D/⌫ + context menu | S15 |
| Musical grid + snap divisions | ✅ | bar..1/16T | S14 |
| Marquee + multi-select | ✅ | | S2 |
| Track create/rename/remove/reorder | ✅ | dbl-click rename, ≡ drag | S15 |
| Clip rename | ❌ | clips keep creation names | papercut batch |
| Clip looping (cycle a clip region) | ❌ | engine supports loops; no cmd/UI | arrange stage |
| Clip gain / fades | ❌ | | audio-editing stage |
| Copy/paste across tracks | 🔶 duplicate_clip takes trackId; no paste UX | | papercut batch |
| Crossfades | ❌ | | post-v0 |

## MIDI editing

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Piano roll: draw/move/resize/delete notes | ✅ | OpenUtau-style, labeled notes, vel lane | **S16** |
| Drum-rack step sequencer | ✅ | hit/accent cycle, pad rows | S14 |
| Velocity editing | ✅ | vel lane in piano roll | S16 |
| Quantize / humanize / transpose | 🔶 | IR + commands exist; no UI buttons | piano-roll toolbar batch |
| Note labels (pad/pitch names) | ✅ | the OpenUtau lyric look | S16 |
| Multi-note selection / lasso in piano roll | ❌ single-note ops only | | piano-roll v2 |
| 808 glides / pitch bend curves | ❌ engine MIDI-bend spike needed | "slide to X" approximated stepped | named candidate stage |
| Scale highlighting / fold | ❌ | set_key exists, unused visually | scale-aware stage |
| MIDI clip length change from editor | 🔶 trim in arrangement only | | piano-roll v2 |

## Audio clip editing

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Pitch shift / time stretch | 🔶 | sample.pitch/stretch ↔ set_clip_pitch/stretch ↔ no UI | clip-inspector stage |
| Slice to grid | 🔶 | slice_clip (grid) | clip-inspector stage |
| Slice at transients | 🅿 ledgered (async detection) | | v0.3 decision |
| Reverse / normalize | ❌ | | clip-inspector stage |
| Waveform view | ✅ | peaks canvas | S2 |

## Devices & mixing

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Builtin devices load/param/bypass/reorder/remove | ✅ | + Device menu, param sliders | S15 |
| VST3/AU hosting + native editors | ✅ | browser modal | S3 |
| Tier-A neural insert (ASTD/Lab) | ✅ | | S4 |
| Sampler multi-pad (drum rack) + pad add | ✅ | key-ranged pads, file dialog | S14/S15 |
| Track volume/pan/mute/solo | ✅ | headers | S2/S15 |
| Master fader | ✅ | native-only cmd (hash-v2 parked) | S15 |
| Sends / returns | 🧠 | mixer.send/add_send work; NO UI | mixer stage |
| Sidechain | 🧠 | mixer.sidechain/set_sidechain; NO UI | mixer stage |
| Track routing (track→track) | 🧠 | track.route/route_track; NO UI | mixer stage |
| Full mixer view (channel strips) | ❌ headers only | | mixer stage |
| Device presets | 🅿 ledgered (no engine preset API) | | v0.3 decision |

## Import & browser

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Import audio via dialog | ✅ | + Import, drum-rack + pad | S15 |
| Crate browser + audition | ❌ | named next sound stage (Emilio-approved) | crate-browser stage |
| Drag-drop from Finder | 🅿 WebView drops don't carry paths; dialog is the path | | revisit native-window drop |
| Asset resolve from text (agent) | 🧠 | asset.resolve (token+path scoring, CLAP rerank tool) | crate browser surfaces it |

## Recording

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Audio input recording | ❌ | transport record exists; no input UI/arming | **recording stage (named next)** |
| MIDI keyboard input | ❌ | | recording stage |
| Input monitoring / arming | ❌ | | recording stage |

## Automation

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Write automation curves | 🧠 | automation.write ↔ write_automation; NO UI/lanes | automation stage |
| Automation playback | ✅ engine | curves are canonical state (hash rule) | S8 |

## Render / export

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Export mix to WAV | ✅ | topbar | S6 |
| Bounce range/stems | 🔶 render.bounce (harness) | | export-options batch |
| MP3/format options, sample-rate choice | ❌ | | export-options batch |

## Collaboration & agent (the uniques)

| Capability | Status | Notes |
|---|---|---|
| Git-style async session sync | ✅ | CollabPanel (S10) |
| Tutorial bar + markers + consent | ✅ | S9 |
| Monster agent (B-5) propose→run | ✅ | S11 |
| Tier-B generative re-imagine (SA3) | ✅ | GenPanel (S5) |
| Trajectory recording (always-on) | ✅ | S9 |
| Replication ladder review-in-app | ✅ | ladder open (S13/14) |

## Standing priorities derived from this audit

1. **Mixer stage** — sends/returns/sidechain/routing have FULL agent+command
   support and ZERO UI (the biggest closure-rule violation left).
2. **Crate browser** (named, approved) — import exists; browsing/audition is
   the producer workflow.
3. **Recording stage** (named) — the only whole category at ❌.
4. **Piano-roll v2** — multi-select, quantize/humanize buttons, clip-length,
   scale highlighting; then the 808-glide/pitch-bend spike.
5. **Papercut batch** — clip rename, paste UX, autosave, export options.
