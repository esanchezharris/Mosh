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

Last full audit: 2026-06-10 (Stage 26 — the next-tier pass: automation lanes, arranger, clip inspector, recording v2, projects).

## Project / session

| Capability | Status | Parity (IR ↔ cmd ↔ UI) | Closes in |
|---|---|---|---|
| Tempo set/edit | ✅ | project.set_tempo ↔ set_tempo ↔ BPM chip | S15 |
| Tempo CHANGES over time (tempo map) | ❌ single tempo only | — | post-v0 |
| Time signature | ✅ | project.set_time_sig ↔ set_time_sig ↔ chip | S15 |
| Key / scale | 🔶 | project.set_key ↔ set_key ↔ none | scale-aware piano roll stage |
| Swing / global groove | 🅿 engine has no groove (ledgered) | project.set_swing → Unsupported | decision: v0.3 or drop |
| Save / load / autosave / projects | ✅ autosave (S21) + ▤ project menu: save-as + open, copy-based local projects (S26) | | S26 |
| Undo/redo | ✅ buttons + ⌘Z/⌘⇧Z | one UndoManager | S15 |
| Sections/arrangement markers | ✅ strip under the ruler: drag-create, move/resize, rename, delete, click-seek, shift-loop (+ remove_section) | | S23 |
| Metronome | ✅ | native-only (playback aid) | S15 |
| Count-in / pre-roll | ✅ none/1 bar/2 bars (Edit::CountIn) next to the metronome | | S25 |

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
| Clip rename | ✅ context menu → Rename… (rename_clip) | | S21 |
| Clip looping (cycle a clip region) | ❌ | engine supports loops; no cmd/UI | arrange stage |
| Clip gain / fades | ✅ gain in Inspect… (set_clip_gain); fades ❌ | | S24 / audio-editing v2 |
| Copy/paste across tracks | 🔶 duplicate_clip takes trackId; no paste UX | | papercut v2 |
| Crossfades | ❌ | | post-v0 |

## MIDI editing

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Piano roll: draw/move/resize/delete notes | ✅ | OpenUtau-style, labeled notes, vel lane | **S16** |
| Drum-rack step sequencer | ✅ | hit/accent cycle, pad rows | S14 |
| Velocity editing | ✅ | vel lane in piano roll | S16 |
| Quantize / humanize / transpose | ✅ piano-roll toolbar (Q / H seeded / ±1 ±12) | | S20 |
| Note labels (pad/pitch names) | ✅ | the OpenUtau lyric look | S16 |
| Multi-note selection / lasso in piano roll | ✅ marquee + shift-click; batch move/resize/delete in ONE undo step | | S20 |
| 808 glides | ✅ REAL continuous slides via automated pitchshift (the sampler ignores MIDI bend — verified); slide… on a selected note | | S20 |
| Scale highlighting / fold | ❌ | set_key exists, unused visually | scale-aware stage |
| MIDI clip length change from editor | 🔶 trim in arrangement only | | piano-roll v2 |

## Audio clip editing

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Pitch shift / time stretch | ✅ Inspect… panel (right-click a wave clip) | | S24 |
| Slice to grid | ✅ Inspect… → ✂ slice on the snap grid | | S24 |
| Slice at transients | 🅿 ledgered (async detection) | | v0.3 decision |
| Reverse | ✅ Inspect… toggle (set_clip_reversed; proxy drained in-command); normalize ❌ | | S24 |
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
| Sends / returns | ✅ mixer strips: per-send gain (set_send_gain), + send / new bus… | | S17 |
| Sidechain | ✅ compressor cards: key ▾ track picker | | S17 |
| Track routing (track→track) | ✅ out: ▾ dropdown per strip | | S17 |
| Full mixer view (channel strips) | ✅ ☰ Mixer drawer: fader/meter/pan/M·S/routing/sends + master strip | | S17 |
| Device presets | 🅿 ledgered (no engine preset API) | | v0.3 decision |

## Import & browser

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Import audio via dialog | ✅ | + Import, drum-rack + pad | S15 |
| Crate browser + audition | ✅ 🗄 Crate drawer: tree, recursive search, in-engine audition, →trk/→pad | | S18 |
| Drag-drop from Finder | 🅿 WebView drops don't carry paths; dialog is the path | | revisit native-window drop |
| Asset resolve from text (agent) | 🧠 | asset.resolve (token+path scoring, CLAP rerank tool) | crate browser surfaces it |

## Recording

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Audio input recording | ✅ 🎙 input pick + ● arm + ⏺ Rec — PROVEN with a real mic take landing as a clip (smoke Phase D) | | S19 |
| MIDI keyboard input | ✅ arm_track arms physical + virtual MIDI inputs — a keyboard records MIDI clips through the same ● | | S25 |
| Input monitoring / arming | ✅ arming + 🎧 monitor toggle (per-device MonitorMode) | | S19/S25 |

## Automation

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Write automation curves | ✅ per-track A lanes: param picker, point add/drag/delete (get/clear_automation + lane-replace write) | | S22 |
| Automation playback | ✅ engine | curves are canonical state (hash rule) | S8 |

## Render / export

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Export mix to WAV | ✅ | topbar | S6 |
| Bounce range/stems | ✅ loop-range export (⚙ menu); stems still 🔶 (harness tracksToDo) | | S21 / export v2 |
| WAV bit-depth + sample-rate options | ✅ ⚙ export menu (16/24-bit × 44.1/48k × full/loop); MP3 ❌ (no LAME) | | S21 |

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

Stage-16's list cleared in S17–21; the next tier (automation lanes · arranger
· clip inspector · recording v2 · projects) cleared in S22–26 (2026-06-10).
What remains, by value:

1. **Papercut v3** — paste UX, MP3 export, scale highlighting/fold in the
   roll, MIDI-clip length from the editor, normalize, fades.
2. **Tempo map** — tempo changes over time (post-v0 candidate).
3. **Clip looping / crossfades** — engine supports loops; no gesture yet.
4. **Stems export** — harness tracksToDo exists; no UI.
5. **Parked decisions due in v0.3**: swing/groove, transient slicing,
   device presets, Finder drag-drop (WebView path limitation).
