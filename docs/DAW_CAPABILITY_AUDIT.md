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

Last full audit: 2026-06-10 (Stage 31 — the final-tier pass: papercut v3, tempo map, loop/fades, stems, and every parked v0.3 decision settled).

## Project / session

| Capability | Status | Parity (IR ↔ cmd ↔ UI) | Closes in |
|---|---|---|---|
| Tempo set/edit | ✅ | project.set_tempo ↔ set_tempo ↔ BPM chip | S15 |
| Tempo CHANGES over time (tempo map) | ✅ set_tempo{atBar}/remove_tempo, ♩flags on the ruler (alt-click), piecewise UI time math | map points await hash-v2 | S28 |
| Time signature | ✅ | project.set_time_sig ↔ set_time_sig ↔ chip | S15 |
| Key / scale | ✅ key chip in the transport; scale highlight + fold in the roll | project.set_key ↔ set_key ↔ chip | S27 |
| Swing | ✅ DECIDED: a quantize feature, not a global groove — quantize_notes{swing} + roll slider; project.set_swing stays unsupported by design | | S31 |
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
| Clip looping | ✅ Inspect… loop N beats (set_clip_loop; stretch past length to repeat) | | S29 |
| Clip gain / fades / crossfades | ✅ gain + fade in/out + auto-crossfade on overlap (set_clip_fades) | | S24/S29 |
| Copy/paste | ✅ ⌘C/⌘V (paste at the playhead via duplicate_clip) | | S27 |
| Crossfades | ✅ autoCrossfade per clip (overlaps fade automatically) | | S29 |

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
| Scale highlighting / fold | ✅ in-scale rows tinted + fold toggle (vertical drags walk visible rows) | | S27 |
| MIDI clip length change from editor | ✅ length chip in the roll header (trim_clip) | | S27 |

## Audio clip editing

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Pitch shift / time stretch | ✅ Inspect… panel (right-click a wave clip) | | S24 |
| Slice to grid | ✅ Inspect… → ✂ slice on the snap grid | | S24 |
| Slice at transients | 🅿 DECIDED: defer to v0.4 — onset-detection quality work; grid slicing + the crate cover the workflow (recorded) | | v0.4 |
| Reverse | ✅ Inspect… toggle; normalize ❌ (engine shouldNormalise exists on export only) | | S24 |
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
| Device presets | ✅ DECIDED + built: plugin-state files (save/list/load_device_preset; 💾 on builtin cards); IR device.load_preset LOWERS — ledger entry retired | | S31 |

## Import & browser

| Capability | Status | Notes | Closes in |
|---|---|---|---|
| Import audio via dialog | ✅ | + Import, drum-rack + pad | S15 |
| Crate browser + audition | ✅ 🗄 Crate drawer: tree, recursive search, in-engine audition, →trk/→pad | | S18 |
| Drag-drop from Finder | ✅ native window FileDragAndDropTarget → import_clip per audio file (best-effort: if WKWebView swallows the drag, the dialog + crate remain) | | S31 |
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
| Bounce range/stems | ✅ loop-range export + stems (one WAV per non-empty track, ⚙ menu) | | S21/S30 |
| Export formats | ✅ WAV 16/24 × 44.1/48k × full/loop + mp3 320k (lame) + m4a AAC (afconvert) | | S21/S27 |

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

Three tiers cleared on 2026-06-10: S17–21 (mixer/crate/recording/roll-v2/
papercuts), S22–26 (lanes/arranger/inspector/recording-v2/projects), and
S27–31 (paste/MP3-M4A/scale-fold/tempo-map/loop-fades/stems + every parked
v0.3 decision settled: swing=quantize feature ✅, presets=state files ✅,
Finder drop=native target ✅, transient slicing=v0.4 by recorded decision).

**The audit has no open ❌/🔶/🧠 rows that block everyday production.**
What remains is deliberate scope: normalize (export-side exists), tap tempo,
transient slicing (v0.4), the hash-v2 batch (master vol + tempo map + future
mix state, one versioned bump + corpus re-stamp), and the IR v0.3 vocab batch
(tempo-map op, track.move, master gain target, notes.quantize swing field).
