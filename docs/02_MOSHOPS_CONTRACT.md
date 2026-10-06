# 02 (reconstructed) — MoshOps & the State Feed

*Spec `02` is absent from the repo. This is the contract as designed from `00 §2/§6/§7` and `01` and as implemented in `src/moshops/`. It is the single coupling between the React UI and the C++ backend (the swappable seam). Keep this in sync with `src/moshops/MoshOps.*`.*

---

## The seam (three calls + one feed)

The UI (`ui/src/bridge.ts`) talks to the backend ONLY through:

| Native fn | Direction | Shape |
|---|---|---|
| `execute_command(cmd)` | UI → C++ | `cmd → result` (the single mutation path) |
| `get_snapshot()` | UI → C++ | `→ snapshot` (full state, cold) |
| `"mosh_event"` channel | C++ → UI | typed events (snapshot+events feed) |

Pure view state (zoom, scroll, selection, drawers) is **UI-local** and never crosses this seam — keeps the JSONL a clean semantic/taste trail.

## Command envelope

```jsonc
// request
{ "command": "create_track", "args": { "name": "Drums" } }
// result
{ "ok": true,  "command": "create_track", "data": { "trackId": "1023" } }
{ "ok": false, "command": "create_track", "error": "insert failed" }
```

Every command: **validate → begin a Tracktion undo transaction (if undoable) → mutate via engine APIs → emit events → append a JSONL line → return the envelope.** One command = one undo step. The UI never mutates the engine directly.

## Command catalog (Stage 1)

| Command | args | undoable | result.data | events |
|---|---|---|---|---|
| `create_track` | `{name?}` | ✓ | `{trackId}` | `snapshot_invalidated` |
| `rename_track` | `{trackId, name}` | ✓ | — | `snapshot_invalidated` |
| `set_track_active` | `{trackId, active}` | ✓ | — | `snapshot_invalidated` (scoped track patch) |
| `remove_track` | `{trackId}` | ✓ | — | `snapshot_invalidated` |
| `import_clip` | `{file, trackId?, startSeconds?, name?}` | ✓ | `{clipId, trackId}` | `snapshot_invalidated` |
| `add_test_tone_clip` | `{seconds?, freq?, trackId?, name?}` | ✓ | `{clipId, trackId}` | `snapshot_invalidated` |
| `set_transport` | `{action?: play\|stop\|toggle\|record, position?, loop?, loopStart?, loopEnd?}` | ✗ | `transport` | `transport` |
| `undo` / `redo` | `{}` | ✗ (drives the manager) | `bool` | `snapshot_invalidated` |
| `jump_to_history` | `{txn}` | ✗ (drives the manager) | `{txn, undone, redone, from, depth}` | `snapshot_invalidated` |
| `save` / `reload` | `{}` | ✗ | — | `reload`→`snapshot_invalidated` |
| `add_render_layer` | `{clipId, adapter?}` | ✓ | `{layerId}` | `snapshot_invalidated` |
| `freeze_layer` | `{clipId}` | ✓ | — | `snapshot_invalidated` |
| `unfreeze_layer` | `{clipId}` | ✓ | — | `snapshot_invalidated` |
| `add_drum_pattern` | `{pattern, trackId?, clipId?, stepsPerBar?, bars?, velocity?, start?, name?}` | ✓ | `{clipId, trackId, noteCount, steps, bars}` | `snapshot_invalidated` |
| `set_clip_warp` | `{clipId, autoTempo, mode?, sourceBpm?, detect?}` | ✓ | `{clipId, autoTempo, stretchMode}` | `snapshot_invalidated` |
| `stretch_clip` | `{clipId, length? \| bars?}` | ✓ | `{clipId, sourceBpm, length}` | `snapshot_invalidated` |
| `detect_clip_bpm` | `{clipId}` | ✗ (read-only) | `{clipId, bpm, confidence}` | — |
| `list_loras` | `{}` | ✗ (read-only) | `{loras: [{name, displayName, trigger, hint, notes, rank, sha12, valid, reason?}], dir}` | — |
| `add_automation_point` | `{trackId, pluginIndex, paramIndex, time, value: 0-1}` | ✓ | `{pointIndex}` | `snapshot_invalidated` |
| `remove_automation_point` | `{trackId, pluginIndex, paramIndex, pointIndex}` | ✓ | — | `snapshot_invalidated` |
| `set_automation_point` | `{trackId, pluginIndex, paramIndex, pointIndex, time?, value?: 0-1}` | ✓ | `{pointIndex}` (may change — remove+re-add) | `snapshot_invalidated` |
| `clear_automation` | `{trackId, pluginIndex, paramIndex}` | ✓ | — | `snapshot_invalidated` |
| `set_track_automation_mode` | `{trackId, mode: read\|touch\|latch\|write}` | ✓ | — | `snapshot_invalidated` (scoped track patch) |
| `write_automation_curve` | `{trackId, pluginIndex, paramIndex, points: [{t,v:0-1,curve?}] \| JSON string, apply?: replace\|merge, replaceStart?: seconds, replaceEnd?: seconds}` | ✓ | `{pointCount, numPoints}` | `snapshot_invalidated` |
| `set_plugin_param` | `{trackId, index, paramIndex, value: 0-1, gesture?}` | ✓ (one step per gesture) | — | `snapshot_invalidated` (scoped track patch) |
| `set_plugin_state` | `{trackId, index, key, value: number\|string, gesture?}` | ✓ (one step per gesture) | `{key, value}` (the applied value) | `snapshot_invalidated` (scoped track patch) |

**Native plugin panels (2026-10-05): `set_plugin_state`, gestures, `plugin_meters`.**
`set_plugin_state` edits a native plugin's CachedValue-only settings, the ones Tracktion keeps in
the plugin's state but does not expose as automatable parameters (so `set_plugin_param` cannot
reach them). The whitelist, by the plugin's reported `type` (`src/moshops/PluginState.h`, shared
with the snapshot's `plugin.state`): `delay` `lengthMs` (integer ms, 1–2000), `chorus` `depthMs`
(0.1–20 ms), `speedHz` (0.1–10 Hz), `width` (0–1), `mix` (0–1), `phaser` `depth` (0–8 oct), `rate`
(0.05–10 Hz), `feedback` (−0.95–0.95), `lowpass`/`highpass` `mode` (`"lowpass"` or
`"highpass"`) and `slope` (integer dB/oct, 6–48 in steps of 6; 2026-10-05), and the `4osc` keys
listed under *4OSC* below (2026-10-05). Values are physical,
never normalised. Numbers must be JSON numbers and finite (a string, boolean or NaN is refused);
they are clamped to the range, and `lengthMs` is rounded to an integer and never goes below 1 ms
(Tracktion's DelayPlugin divides by the length in samples on the audio thread). An integer key
with a `step` above 1 (the slope) is snapped onto `min + step·k`, `k = round((value − min) /
step)` with a tie rounding up as JavaScript's `Math.round` does: slope 25 → 24, 27 → 30, 0 → 6,
100 → 48. The result's `value` is the applied (snapped) value. `mode` must be one of its choices;
changing it flips the plugin's reported `type`/`name` between `"lowpass"` (name `"LPF/HPF"`) and
`"highpass"` (name `"High-Pass"`), and leaves the slope as it is. Errors: `no plugin`,
`key '<k>' is not a state key of <type> (allowed: …)` (or `(it has none)`), `this <type> cannot set
'<k>'` (the plugin object lacks that setting: `slope` on a plain Tracktion filter, see below),
`bad value for <k>: …`, `missing value`. A value equal to the current one is `ok` but is not an edit: it opens no
transaction (so it does not end an open gesture window, see below), logs `undoable:false`, and
does not touch the reactive render loop. Otherwise the write goes through the Edit's UndoManager
inside one transaction (a ValueTree property action the CachedValue follows), logs one JSONL
line, emits the scoped track patch, and touches the reactive render loop like
`set_plugin_param`. Refused on a frozen track; lock scope `Track`. **UI-only**: absent from the
agent catalog and from `TransactionSafe.h` (fails closed inside an agent transaction). Delay
lines: Tracktion's chorus and delay size their line in `initialise` for the CURRENT
`depthMs`/`lengthMs` and grow it inside `applyToBuffer` (`ensureMaxBufferSize`, an allocation on
the audio thread) when it grows. Every Mosh `delay`/`chorus` is a `MoshDelayPlugin` /
`MoshChorusPlugin` (`src/plugins/moshfx/MoshDelayLinePlugins.h`: Tracktion's plugin, same type,
audio bit-identical) whose `initialise` sizes the line on the message thread for this command's
ceiling (2000 ms; a 41 ms chorus line), so a `set_plugin_state` during playback never allocates
on the audio thread. Registered with the compressor (below); `--selftest` fails if a loaded
delay or chorus is not one.

**Low/high-pass slope (2026-10-05).** Every Mosh `lowpass`/`highpass` is a `MoshLowPassPlugin`
(`src/plugins/moshfx/MoshLowPassPlugin.h`: Tracktion's `te::LowPassPlugin`, same `"lowpass"`
type, registered with the shadows above; `--selftest` fails if a created or reloaded one is not).
`slope` selects a Butterworth cascade of order `slope / 6` (`MoshFilterDesign.h`: at most four
sections, the closed form `|H|² = 1 / (1 + (tan(πf/fs) / tan(πfc/fs))^(2N))`, inverted for
high-pass, so every slope is −3.01 dB at the cutoff). At 12 dB/oct the subclass makes exactly
the calls Tracktion's filter makes, so its audio is bit-identical (`--selftest` compares it with a
directly constructed `te::LowPassPlugin` through a cutoff change and a mode flip). A slope change
during playback resets a second cascade, warms it on the input unheard for five of its slowest
section's time constants (`Q₁ / (π·fc)`; 30–200 ms: 51 ms at 80 Hz and 48 dB/oct, 102 ms at
40 Hz) and then crossfades over about 20 ms into it, so the new slope is heard 30–200 ms after the
change and a change that lands while one runs waits for it (2026-10-06: without the warm-up a
bass-range cutoff's steep cascade was still ringing up from silence when the fade ended, −7.8 dB
re peak off a crossfade of two warm filters at LP 80 Hz; `--selftest` now holds LP 80 Hz and HP
40 Hz under −40 dB through and after the fade); nothing allocates on the audio thread. Saved as the plugin property `moshFilterSlope` (dB/oct, through the Edit's
UndoManager, so undoable like every `set_plugin_state`); the default 12 is never written, so a
session or preset tree without it plays at 12, a saved value off the grid plays snapped, and an
older Mosh opening a session saved at another slope plays it at 12 without warning. The snapshot
shows `state.slope` on master-bus filters too, read-only (`set_plugin_state` resolves track
plugins only). A plain `te::LowPassPlugin` (only if Tracktion ever registered its own first)
has no slope: `state.slope` is absent and `set_plugin_state` refuses the key. A track preset's
filter runs at 12 (see *Track-chain presets*).

**4OSC (2026-10-05).** `set_plugin_state` keys of a `4osc` (Tracktion's `te::FourOscPlugin`;
its public CachedValues on the plugin's root state, written through the Edit's UndoManager):
`waveShape1`…`waveShape4` (`"off"`, `"sine"`, `"square"`, `"saw"`, `"triangle"`, `"noise"`; osc 1
defaults to `"sine"`, the others `"off"`), `voices1`…`voices4` (unison voices, integer 1–8, step
1, default 1), `filterType` (`"off"`, `"lowpass"`, `"highpass"`, `"bandpass"`, `"notch"`; default
`"off"`, which is a fresh 4OSC's; the bundled presets turn it on), `filterSlope` (integer 12–24 dB/oct,
step 12, default 12), `distortionOn`, `reverbOn`, `delayOn`, `chorusOn` (`"off"`/`"on"`, default
`"off"`), `delayBeats` (0.0625–4 beats, Tracktion's `delay`; default 1), `voiceMode` (`"mono"`,
`"legato"`, `"poly"`; default `"poly"`) and `ampAnalog` (`"off"`/`"on"`, default `"on"`). Choices are
the lowercase ids above (the UI owns the labels); a choice's index is Tracktion's enum value, and
nothing outside an enum is ever written (a filter type outside 0–4 zeroes the voice filter and
silences the synth). A stored value the synth cannot play is read as what it plays instead: a
wave or filter type outside its enum reads `"off"`, unison voices are clamped to 1–8, a filter
slope other than 24 reads 12 (the voice adds its second stage only for exactly 24), a voice mode
other than 1 or 2 reads `"mono"`. For the 4OSC the no-change test compares the STORED values, so
choosing the shown value over such a store (e.g. `"off"` over a filter type 7) is a real,
undoable edit that repairs it. Not exposed: polyphony, the LFO wave/sync/beat, MPE and the mod
matrix (inert without a route, reallocating, or unsafe: an LFO beat ≤ 0 hangs the audio thread).
Changing `voiceMode` makes Tracktion reallocate voices on the message thread under the lock the
audio thread renders under; `chorusOn` runs Tracktion's chorus, which can grow its line on the
audio thread; `ampAnalog` changes only the envelope curve constants, so it is heard from the
next envelope edit.
The snapshot carries ALL 68 of a 4OSC's parameters (every other plugin keeps the 16 cap), each
with `id` (the paramID: the names collide, "Mix" ×3, "Width" ×2, "Level" beside "Level N"),
physical `min`/`max`, `skew` (only when ≠ 1), `symmetricSkew` (only when true; none today) and
`step` (the range's interval, only when > 0: Tune 1–4 step 1). See *Snapshot* for the mapping.
`plugin.modRoutes`, read-only and only when non-empty, lists mod-matrix routes an imported
session carries: `[{paramIndex, id, source, depth}]` (`source` is Tracktion's id: `lfo1`, `lfo2`,
`env1`, `env2`, `mpePressure`, `mpeTimbre`, `midiNote`, `midiVelocity`, `cc<N>`; only params
0–53 can be routed). Mosh never creates a route. Every Mosh 4OSC is a `MoshFourOscPlugin`
(`src/plugins/moshfx/MoshFourOscPlugin.h`: Tracktion's plugin, same `"4osc"` type, its audio the
base class's own call, registered with the shadows above; `--selftest` fails if a loaded, default
or reloaded one is not), which publishes the 4OSC's `plugin_meters` entry (see *Events*).

**4OSC presets (`load_preset` with a `.json`, 2026-10-06).** A patch file is
`{"state": {<the set_plugin_state keys above>: value}, "params": {"<parameter name>": normalized
0–1}}` (plus ignored `_`-prefixed notes; the bundled ones carry `_physical`, what each
normalized value is). Every `state` key and value is validated and coerced exactly as
`set_plugin_state` does (an unknown key or bad value refuses the whole file, as does a `state` or
`params` that is not an object); a param binds by its exact paramID (`"chorusMix"`), else to the
first parameter with that display name, case-insensitively (the names collide: `"Mix"` and
`"Width"` reach the reverb's, so the delay's and chorus's need their ids); an unmatched one is
reported in `unknownParams`, not fatal. The load is a WHOLE patch: every parameter and setting the file does
not name returns to Tracktion's default, so a patch never inherits from the one before. One undo
step; refusals and a load of the patch already loaded open none (`changed:false`). A file with the
first bank's numbered `"waveShapes"` is refused (it numbered the waves in Tracktion's LFO enum,
not the oscillator's, and the loader wrote them where the synth never reads them, so until 2026-10-06 every preset played osc 1's sine
through no filter). Result `data`: `{plugin:"4osc", preset, paramsApplied, settingsApplied,
changed, reset, unknownParams?}` (`reset` = parameters and settings returned to default; a
setting is reset only when its value differs from the default). A load or `set_plugin_state`
that changes `voiceMode` re-sends that property's change message after the change and before it
(an undoable resync), because Tracktion reallocates voices from the cached value, which is stale
for a property removal and for every undo/redo. The bundled bank (`resources/presets/4osc/`, five
patches) is un-auditioned. It supersedes the re-voiced `Keys`/`Bass`/`Pad`/`Lead`/`Pluck` bank and
the top-level `waveShapes`/`oscVoices` format of open PR #728, which this loader refuses.

**Sampler and drum pads (2026-10-05).** Every Mosh sampler is a `MoshSamplerPlugin`
(`src/plugins/moshfx/MoshSamplerPlugin.h`: Tracktion's `te::SamplerPlugin`, same `"sampler"` type,
saved format unchanged, its audio the base class's own call and bit-identical to it; registered
with the shadows above; `--selftest` fails if one made by `load_builtin`, a drum track,
`load_drum_kit`, `assign_sample` or a reload is not), which publishes the sampler's
`plugin_meters` entry (see *Events*) and adds no parameters or children to its state (the pad
commands address `SOUND` children by raw index). The pad commands address the track's FIRST
sampler (`plugin.sampler.primary`) and a pad by the NOTE that reaches it: the narrowest sound
covering the note, the first on a tie (`plugin.sampler.sounds[].addressNote` is that note).
`set_drum_pad {trackId, note, gainDb?, pan?, name?, chokeGroup? 0–16}`, `clear_drum_pad
{trackId, note}`, `assign_sample {trackId, note, file, mode?, name?, gainDb?}` (REPLACES every
sound covering the note, a melodic one included, and resets level, pan and choke) and
`load_drum_kit {trackId, kit?}` (replaces ALL sounds) are each exactly one undo step, and so is
`create_track {type: "drum"}` (track, sampler, kit and meter) (`--selftest` proves each against an
anchor edit with Tracktion's 350 ms undo-transaction timer due; before 2026-10-05 a kit load with no
audio device pumped the message loop mid-command and that timer could split `load_drum_kit` and a
drum `create_track` into two steps, so the load now inhibits it); every `SOUND` write rebuilds
the sampler's sound list, which cuts ringing voices, so a UI commits pad edits on release. A pad
silenced by `set_drum_lane` (its lane muted, or another lane soloed) keeps the producer's level
parked (`moshPadGainDb`; `sounds[].silenced` / `userGainDb`): `set_drum_pad`'s `gainDb` writes the
parked level, clamped to the engine's −48…+48 dB, and an edit without `gainDb` (pan, name or
choke only) keeps it (before 2026-10-05 a pan-only edit parked the −48 dB floor, so unmuting
restored silence). A `chokeGroup` > 0 makes the pad note-gated; choke is enforced only by
`apply_choke` (baked note lengths): nothing chokes live. `audition_note` on a track with no clips
plays the sampler directly (path `"sampler"`, velocity fixed at 0.75). Tapping the same pad again
sounds and is a new hit, whether its earlier blip has expired or not: a blip's expiry hands the
sampler the keys still held on that track, and (2026-10-06) a blip, or any note-on whose earlier
voice for that pitch was a blip, releases the key at the sampler and presses it again, so a
double-tap or a roll on one pad plays every tap (a one-shot layers over the ringing one, a gated
one is shortened, as a repeated MIDI note-on does). Before, the key stayed held at the sampler and
a re-tap within the blip (250 ms by default, restarted by each tap) was silent and unreported. An
`"on"` repeating an `"on"` stays one press. These auditions are reported as hits on the rail;
`--selftest` drives this road through the command's own code (`MoshOps::auditionNote` with the
road forced, as no device is present headless).

**Render-layer cache key (2026-10-05).** A MIDI/drum clip's render is cached under a signature of
its notes and its track's plugins (`stableSourceSig`, `src/moshops/MoshOps.Generative.cpp`): each
plugin's name, bypass, parameter values and automation curves, and now also its `plugin.state`
values (the same whitelist, read the same way) and, for a sampler, what each `SOUND` child makes
the bounce sound like, read as the sampler reads it: root, range, live gain, pan, gate, excerpt,
and the file its source resolves to, by name and size (2026-10-06: not the raw source string,
which Save-As consolidation rewrites from absolute to relative for the same audio, nor a pad's
name, choke group or the level a silenced pad has parked, none of which the bounce hears; hashing
them re-rendered a drum layer for a rename). Before, a state-only edit (filter slope or mode,
delay length, chorus, phaser) or a sampler pad edit left the key unchanged, so a re-render HIT
the cache and served the stale render. The pad commands that change the sound ask for the
reactive re-render of the track's applied layers: `set_drum_pad`, `clear_drum_pad`,
`set_drum_lane`, and since 2026-10-06 also `assign_sample`, `load_drum_kit` and `set_track_type
{type:"drum"}` (before, those three changed the key but asked for no re-render, so an applied
drum layer kept the old kit's render until some other edit touched the track; `--selftest`
proves each asks). The key is the state, not the edit history (an undo restores the
earlier key exactly), but a layer caches one render, its latest, so returning to an earlier
value re-renders once. Plugins with neither state keys nor sounds contribute exactly what they
did before, so their chains keep their cached renders; chains with a delay, chorus, phaser,
low/high-pass, 4OSC (its `state` keys, 2026-10-05) or sampler re-render once.

**Gestures.** `set_plugin_param` and `set_plugin_state` take an optional `gesture` (a string of
1–64 characters from `[A-Za-z0-9_.:-]`; anything else, including an empty string or a non-string,
is an error, not ignored). A call whose `gesture` equals the gesture that opened the CURRENT undo
transaction joins that transaction instead of opening a new one, so a whole drag is one undo step.
The window ends when anything else opens a transaction (any other undoable command: joining
would otherwise append the drag to THAT command's step), on undo, redo or `jump_to_history`
(JUCE's undo/redo already start a fresh step; ending the window makes the next call open a normal
named one), on a call without `gesture` or with another one, when an agent batch begins, when
the project is reloaded/opened/replaced, and after 3 s with no call of that gesture. While the
window is open MoshOps holds a `te::Edit::UndoTransactionInhibitor`, because Tracktion's
`Edit::UndoTransactionTimer` otherwise closes the current step 350 ms after any change unless a
JUCE mouse button is down, and the panels' dials live in the WebView, whose pointer never
reaches JUCE: without it a drag held still to listen would split into several steps. Read-only
commands and no-change `set_plugin_state` calls do not end the window. A new gesture id starts a
new step. Every call is still logged and still emits its track patch. Inside an agent batch (`batch_begin` …
`batch_end`) behaviour is unchanged (the batch is the one step), and a gesture call after the
batch never joins it. Without `gesture`, both commands behave exactly as before.

**`plugin_meters` rail.** See *Events*.

`set_track_active` is the Pro Tools-style processing-state command, distinct from both mute and UI-local Track List visibility. `active:false` persists Tracktion's undo-managed `process` property, excludes the track from playback graph construction, and disables processing for its owned plug-ins while leaving the track, clips, routing, and Track List row in the session. The snapshot exposes additive `track.active` (`true` when the field is absent for older consumers). The command is Track-scoped for multiplayer, replayable, JSONL-recorded, save/reload-safe, and a same-state request is a successful no-op that does not create an empty undo step.

*Audio warp — "easy" Ableton-style (post-Stage-6): `set_clip_warp` toggles auto-tempo on a wave clip (Tracktion `TimeStretcher`/SoundTouch); with `detect:true` (and no explicit `sourceBpm`) it estimates the loop's own BPM offline and locks it to the grid. `stretch_clip` time-stretches a wave clip to a target warped `length` (seconds) OR a `bars` count by deriving `sourceBpm` (`warpedLen = sourceLen × sourceBpm / projectBpm`) and enabling auto-tempo — it powers the ⌘-drag-edge stretch gesture and the Inspector "Fit N bars / ½× / 2×" helpers. `detect_clip_bpm` is a read-only offline estimate (onset-envelope autocorrelation, pure C++ so it runs in `--selftest`) → `{bpm, confidence}`. Per-transient warp MARKERS remain a deferred subsystem.*

*LoRA rack (post-Stage-6, 2026-07-16): stacked taste adapters on the SA3 render layer. The library is the watched folder's sa3 family subdir `$MOSH_LORA_DIR/sa3` (default `~/Library/Mosh/loras/sa3`; drop a `.safetensors` + optional `<stem>.json` sidecar `{displayName, trigger, hint, notes}` in; other subdirs like `ace/` are archival). `set_render_param` gains `loras: [{name, value}]` — **ordered** (chained composition is order-dependent) and **unbounded** (no count cap, no strength clamp; `value` is the 0–100 fader, >100 = deliberate overdrive, 0 = removed). Trigger tokens auto-inject into the prompt server-side (surfaced only in the UI tooltip). The cache fingerprint keys `name=value@sha12:trigger` per row, resolved at RENDER time — a retrained same-name file or a sidecar trigger edit is a MISS. Deliberately NOT in the agent catalog (same posture as `colors`/`list_transform_targets` — the agent styles renders via `compile_render`); `list_loras` is distinct from the training scaffold's `list_lora_adapters`. Merge math + design: [superpowers/specs/2026-07-16-lora-rack-design.md](superpowers/specs/2026-07-16-lora-rack-design.md).*

*Streaming — Live render-ahead (post-Stage-6, 2026-07-16, hybrid): `render_ahead_arm {clipId}` arms a WAVE clip's render layer as "Live"; while it plays, a transport-clock scheduler renders 8s windows from the playhead forward, incrementally stitches them (service `/stitch_windows`, 1ms equal-power crossfade) into a growing file whose already-played prefix is byte-stable, and repoints the clip's source. Any generation-param change while armed re-lays from the current window forward — the old→new seam crossfades right where the knob turned (the shipping default; a bar-quantize option is a named follow-up). `render_ahead_tick {playheadSec, wait}` drives a simulated clock headlessly. A stitch/repoint failure now fails CLOSED (tick errors + disarm; async surfaces a layer error). Live files bypass the render cache by design. Separately, P5 boundary-quantized swap applies to ORDINARY (non-Live) renders: one finishing while the playhead is inside the clip lands at the loop wrap / next bar (30 Hz poll, epoch-guarded, `MOSH_SWAP_QUANTIZE=0` escape hatch); headless and sing land instantly.*

*`add_drum_pattern` (DRM-002, post-Stage-6): lays a whole drum grid in ONE undoable command from per-lane step strings (`x` hit, `X` accent, `.`/`-` rest, `|` cosmetic; short lanes tile when they divide the total steps evenly). `pattern` is an object `{lane: steps}` or a flat `"lane: steps; lane: steps"` string (the flat form is what the agent catalog declares). `clipId` targets an existing MIDI clip and replaces ONLY the lanes named; otherwise a new clip lands on `trackId` (omitted → a new "Drums" drum track). Track policy: instrument-less target → `trackType:"drum"` + kit in the same transaction; instrument present → untouched; wave-audio target → error. Design: [superpowers/specs/2026-07-10-add-drum-pattern-design.md](superpowers/specs/2026-07-10-add-drum-pattern-design.md).*

Stage 2 adds `move_clip` / `trim_clip` / `split_clip`; Stage 3 the plugin commands; Stage 4 the Tier-A neural-insert commands (`add_neural_insert` / `set_neural_param` / `set_neural_lab_mode`) — **removed 2026-06-21** with the synthetic insert (the real-time path is now the gated RAVE insert: `add_rave_insert` / `set_rave_param` / `load_rave_model`, `MOSH_ENABLE_ANIRA`; see [CLAUDE.md](../CLAUDE.md)); Stage 5 the generative commands. Stage 6 adds `export_audio` with `{file?, renderMode?}` where `renderMode` is `"auto" | "fast" | "realtime"`; `"auto"` keeps fast render unless a known realtime-only hosted plugin such as Xfer Serum 2 is enabled, then selects realtime render. Its result includes `{file, bytes, seconds, renderModeRequested, renderMode, renderModeReason, realTimeRender}`. All follow the same envelope.

**G10 (2026-07-17): parameter automation RECORDING (v0).** `add_automation_point` / `remove_automation_point` / `set_automation_point` / `clear_automation` (Wave 7) address a parameter by `(trackId, pluginIndex, paramIndex)`; values cross the seam normalized `0..1`, times in seconds. New this pass: `set_track_automation_mode` arms/disarms a TRACK's record mode — all 4 `AutomationMode` values are validated + stored + round-trip, but **only `write` is behavioral in v0** (`touch`/`latch` are accepted, no-op, Phase 2). While a track is `write`-armed, `set_plugin_param` captures a curve point at the *current transport position* in the SAME transaction as the value change — one `undo` reverts both. This is a deliberate divergence from real-DAW behavior: capture is gated on `automationMode==write` alone, **not** `transport.isPlaying()`, because `--selftest` never opens an audio device (no live `PlaybackContext` to gate on) — see [superpowers/specs/2026-07-17-g10-automation-record.md](superpowers/specs/2026-07-17-g10-automation-record.md) for the full rationale + the deferred native-`AutomationRecordManager` Phase 2. `write_automation_curve` bulk-authors a whole curve in one undoable step (modelled on `add_drum_pattern`): `points` validated (`t` strictly ascending, `v` 0–1, optional bezier `curve` -1–1) BEFORE any mutation; `apply:"replace"` (default) clears the `[minT,maxT]` window the new points span then lays them, `apply:"merge"` only adds. Editors moving a curve boundary may provide `replaceStart` and `replaceEnd` together to replace the union of the old and new bounds; the pair must be finite, nonnegative, ordered, and cover every new point. `points` accepts a native array OR a JSON-encoded string (the agent-catalog form, since `ArgType` has no array type — the same duality `add_drum_pattern`'s `pattern` arg uses). Bundled bug fix: `set_plugin_param` previously called `param->setParameter()` directly, which left the live parameter value STALE after `undo` (a G14-class bug — the snapshot's `params[].value` read the wrong value post-undo even though the persisted property had correctly reverted); it now routes through a generalized `SetPluginParamValueAction` (the same replay-via-`setParameterWithoutUndo` pattern G14 established for track vol/pan).

**clip-ops wave (2026-07-17): reverse / auto-crossfade / normalize.** Three more audio-clip-only commands, mirroring `set_clip_gain`/`set_clip_mute`/`set_clip_fade`'s shape exactly (Clip-scoped MP lock, `AudioClipBase`-cast, one `CachedValue`-backed flip, undoable, free persistence — no `src/state` schema change). `set_clip_reverse {clipId, reversed}` → `te::AudioClipBase::setIsReversed`. `set_clip_crossfade {clipId, enabled}` → `te::AudioClipBase::setAutoCrossfade`; **auto-crossfade only has an audible effect when the clip overlaps a neighbor on the same track** (Tracktion auto-computes a triangular fade via `getOverlappingClip`) — Mosh otherwise leaves it off, so overlapping clips still sum at full volume by default (see the `set_clip_fade` comment above). `normalize_clip {clipId, targetDb?: number}` (default `0.0`) is wave-clip-only and **non-destructive**: it reads the source's true peak sample via the same reader path `get_clip_peaks` uses (no re-render, no source-file mutation), then sets the clip's own gain — `newGainDb = targetDb - peakDb`, clamped to the same `[-48, 24]` ceiling as `set_clip_gain` — so the peak lands at the target; a silent clip (peak 0) errors instead of dividing by zero. Snapshot adds `reversed`/`autoCrossfade` (unconditional booleans on wave clips, default `false`, alongside `gainDb`/`fadeInSec`).

**CLP-LOOP (2026-07-18): clip loop region.** `set_clip_loop {clipId, enabled, start?: number, length?: number}` (seconds) fills reality-pack invariant 28 — a clip can loop a defined sub-region of its source. Audio-clip-only (rejects MIDI/non-audio clips like `set_clip_gain`), Clip-scoped MP lock, one transaction, undoable, and free-persisting: it drives `te::AudioClipBase::setLoopRange (TimeRange)` (`tracktion_AudioClipBase.h`:268), whose `loopStart`/`loopLength` are `CachedValue`s on the clip's own ValueTree — **no `src/state` schema change**. **There is exactly ONE notion of "looping"**: the engine has no separate enabled flag — a clip loops iff its loop *length* is `> 0`, which is what `isLooping()` (`:252`) reports and what `normalize_clip`'s `clipAudibleSourceSpan` LOOPING branch already consumes. So `enabled:false` writes an EMPTY range rather than adding a second Mosh-side flag, and `enabled:true` with a non-positive `length` errors (before opening the transaction) instead of silently producing a non-looping clip. Disabling deliberately does **not** call `AudioClipBase::disableLooping()`, which additionally rewrites the clip's position/offset to bake the loop away — toggling a loop off must never move or resize the clip. Defaults when enabling without bounds: keep any existing loop range, else loop the clip's whole current length from `0`. Tracktion clamps what it stores (`start ≤ sourceLength/speed`, `length ≤ 50× sourceLength/speed`; auto-tempo clips route through `setLoopRangeBeats`), so the result echoes the ACTUAL post-clamp `{clipId, loopEnabled, loopStart, loopLength}` read back off the clip, never the raw request. Snapshot adds `loopEnabled`/`loopStart`/`loopLength` on wave clips (unconditional, defaults `false`/`0`/`0`, alongside `reversed`/`gainDb`).

**ARR-011 (2026-07-18): opt-in RIPPLE on `delete_time_range` + `trim_clip`.** Both commands gain one optional `ripple?: boolean` arg, **default `false` — when absent the pre-existing behaviour is byte-identical** (`delete_time_range` stays a lift/cut that leaves the gap open; `trim_clip` stays a pure single-clip resize). With `ripple:true`, downstream clips slide to close/open the gap inside the SAME Tracktion transaction, so **one `undo` reverts both the removal/trim and the shift**. The shift itself is one shared helper (`rippleShiftClipsAfter`, `src/moshops/MoshOps.cpp`) using `Clip::setStart(pos, false, true)` — the same primitive as `move_clip`. A resulting start is **clamped at 0**: a ripple can never push a clip to a negative position. `delete_time_range` shifts every clip starting at or after the range END left by the range length (phases 1+2 guarantee nothing straddles that bound, so it is a clean translation); `trim_clip` shifts every clip on the trimmed clip's own track starting at or after its OLD end by `newEnd - oldEnd` (shortening pulls left, lengthening pushes right), excluding the trimmed clip itself. **Ripple SCOPE for `delete_time_range` is the tracks it already targets** (`trackIds`, defaulting to every audio track) — *not* unconditionally all tracks: the command already scopes its removal that way, so rippling the same set keeps "what got cut" and "what got closed up" identical, and a `trackIds`-scoped call never silently shifts clips on tracks the caller excluded. Result gains `ripple: boolean`. `trim_clip`'s ripple scope is necessarily just its own clip's track (it is a single-clip command). `delete_time_range` remains non-agent-callable and keeps its existing SessionGlobal lock scope; `trim_clip` stays Clip-scoped.

**CAP-CLP-017 (2026-08-03): `insert_time`, and RIPPLE on `move_clip`.** The other half of ripple editing — ARR-011 above shipped the close-the-gap direction; this opens one.

`insert_time {start, duration, trackIds?}` (seconds) pushes everything at or after `start` later by `duration`, in ONE transaction. An UNSCOPED call (no `trackIds`) moves six things, and the list is the contract, not an implementation note: **(1) clips** on every audio track — a clip straddling the point is SPLIT there first (`ClipTrack::splitClip`, `delete_time_range`'s phase-1 primitive) so the space opens inside it; **(2) automation curves** on every one of those tracks' racks **and on the master bus**, with a hold point written at each edge of the new span so the value in force at the insertion point is held FLAT across it instead of a ramp being stretched through; **(3) tempo + time-signature + pitch changes**; **(4) MOSH_SECTIONS** and **(5) MOSH_ANNOTATIONS**, both beat-anchored, shifted by the BEAT width of the new span measured across the tempo edit in (3); **(6) the transport LOOP REGION**. A span that STRADDLES the point grows (its start holds, only its end moves) — the same rule for a section and for the loop, and the only rule under which "insert then ripple-delete the same span" is an exact inverse.

Two implementation choices worth knowing. The automation half is **the engine's own** `te::Track::insertSpaceIntoTrack`, reached by a qualified base call rather than `te::ClipTrack`'s override — the override's clip loop walks `getClips()` backwards and `break`s at the first clip whose centre precedes the point, which is only correct on a start-sorted list, and Tracktion sorts that list in an **async** `handleAsyncUpdate` MoshOps never pumps mid-command (AUD-001). The clip move is therefore `rippleShiftClipsAfter` (order-independent, no early break, the same helper ARR-011 uses). And the loop region is shifted through a `SetLoopRangeAction` `juce::UndoableAction` — `TransportControl::loopPoint1/2` are CachedValues with no UndoManager (which is why `set_transport` is NonUndoable), so without it the one-undo promise would have a hole in exactly the place a producer would notice last.

**Deliberately NOT moved**, named rather than left to be found: a SCOPED call (`trackIds` present) moves only those tracks' clips and their own rack automation — tempo/sections/annotations/loop/master are project-global and shifting them for a partial insert would desync every track the caller excluded (the same rationale as ARR-011's ripple scope). Also out: non-audio clip tracks (marker/chord/arranger — the target set is `te::getAudioTracks()`, identical to `delete_time_range`'s, and Mosh creates none of them); automation inside a `RackType`/`MacroParameter`/`Modifier` (Mosh authors none and never creates a rack); a lyric line's baked `lyricScore` blob, which carries an absolute `bar` that goes stale; and multiplayer peers (`insert_time` does not broadcast — the same pre-existing hole `delete_time_range` has). Classified **SessionGlobal** (the fail-closed default is also the right answer: no single track key describes what a whole-timeline rewrite contends for) and held OUT of the `TransactionSafe.h` registry for the same cross-track blast-radius reason as `delete_time_range`.

`move_clip` gains the same optional `ripple?: boolean` (default `false` ⇒ byte-identical when absent) that `trim_clip` has: clips on the clip's OWN track starting at or after its OLD end shift by `newStart - oldStart`. **`ripple:true` combined with a move to a DIFFERENT track is an error**, validated before any side effect — the neighbours it would carry live on the track the clip is leaving, so the shift distance describes nothing there; an explicit `trackId` naming the clip's own track is fine.

UI: `insert_time` is an explicitly-labelled "Insert time" button on the v2 time-range band (alongside Delete / Delete-close-gap), and ripple is a **modal, visible** top-bar toggle (`store.ripple`, UI-local view state) that `move_clip`/`trim_clip` drags read — modal because two of the four reference DAWs (Pro Tools Shuffle, Reaper ripple) agree the mode should be one the user is told about, and a hidden ripple mode is a way to destroy an arrangement by accident.

**G1 (2026-07-17): export range/section + delay-tail policy.** Four more optional, additive args — absent behaves byte-identically to the pre-G1 call: `range` (`"full" | "loop" | "custom"`, default `"full"`; presence of `start`+`end` alone also implies `"custom"`), `start`/`end` (seconds, required for `range:"custom"`, clamped into `[0, editLength]`), `tail` (`"cut" | "include"`, default `"cut"`), `tailSeconds` (seconds, default `2.0`, clamped to `[0.05, 30]`, used only when `tail:"include"`). `range:"loop"` renders the transport's current loop region (errors if none is set); `tail:"include"` sets Tracktion's `Renderer::Parameters::endAllowance` so a decaying reverb/delay tail rings out past the requested end instead of being cut. Result gains `{range, rangeStart, rangeEnd, tail, endAllowance}`; `seconds` is redefined to the rendered span's length (`rangeEnd - rangeStart`, which equals the full edit length for the default range, so existing `seconds`-blind assertions are unaffected). Pure resolution/validation math lives in `src/moshops/ExportRange.h` (`resolveExportRange`, engine-free, unit-tested by `tests/test_export_range.cpp`). `export_audio` is UI-only (not agent-callable), unchanged by G1.

Hosted plugin snapshots/results include external-plugin diagnostics when Tracktion has the instance: `{manufacturer, file, identifier, numInputs, numOutputs, isNonRealtime}`. `open_plugin_editor` warms the playback context before opening native editors when audio is available and returns `{audioEnabled, playbackContextActiveBefore, playbackContextActive, plugin}`.

**Master-bus plugins (post-Stage-6): host plugins (limiter, bus EQ, …) on the master output.** `load_master_plugin {pluginId, index?}` / `load_master_builtin {type, index?}` / `remove_master_plugin {index}` / `reorder_master_plugin {index, toIndex}` / `bypass_master_plugin {index, bypassed}` / `set_master_plugin_param {index, paramIndex, value: 0-1}` / `open_master_plugin_editor {index}` — the SAME seven-command shape as `load_plugin` / `load_builtin` / `remove_plugin` / `reorder_plugin` / `bypass_plugin` / `set_plugin_param` / `open_plugin_editor`, one level up: they address `eng.edit().getMasterPluginList()` instead of a track's `pluginList`, so there is no `trackId` arg. All undoable except `open_master_plugin_editor` (a native pop-out, same as its per-track counterpart). Snapshot gains `master.plugins` (an array of the same plugin shape as `tracks[].plugins`, via `pluginToVar`). **Internal-plugin invariant:** the master plugin list also carries Mosh's own internal utility plugins (currently only `MasterSpectralTapPlugin`, the Moshi-reactivity tap `ensureMasterSpectralTap()` appends lazily during live playback) — these are never user-visible or user-addressable. `isInternalMasterPlugin()` filters them out of `master.plugins`, and `masterVisibleBoundary()` (the physical index of the first internal plugin, or the list's true size if none exists yet) is the one invariant every master-plugin command clamps inserts/reorders inside — so a tap created later still taps the fully-processed master signal, and a user-facing index never means "some internal plugin." Classified `SessionGlobal` (fail-closed default, same posture as `set_master_volume`/`set_master_pan` — the master bus is the session's one shared resource, not a track) except `open_master_plugin_editor`, which is `Unguarded` like `open_plugin_editor` (a viewer-local pop-out, nothing to sync). MP sync for the six mutating commands rides the same LWW `broadcastStructuralIfActive` replay as `set_master_volume`/`set_master_pan` — a peer without the same VST3 installed will fail to replay `load_master_plugin` locally, the same inherent limitation any VST3-identity-dependent sync has.

**Track-chain presets (2026-10-01): one preset applies an ordered group of BUILT-IN effects to one audio track.** `apply_track_preset {trackId, file}` — `file` is a schema-1 `mosh.track-chain` JSON from the preset library (`list_presets {plugin:"track-chain"}`; bundled: `resources/presets/track-chain/`). One undo step. **UI-only**: absent from the agent catalog and from `TransactionSafe.h` (fails closed inside an agent transaction); `load_preset` refuses a track-chain file by name. Preflight performs no mutation and opens no transaction — it refuses a missing/unknown `trackId` (no fallback to a selected track), a non-audio, instrument, return or frozen track, a recording transport, a missing or invalid file, any processor/parameter/state/unit/value the pinned table in `src/moshops/TrackPreset.h` does not admit (values are never clamped), and a track without room. Each stage is created from a finished `PLUGIN` state tree, so the only undoable action is adding it; stages are inserted after the user's existing inserts and ahead of the first send and the fader. Every inserted plugin carries ownership tags (`moshPresetId` / `moshPresetRevision` / `moshPresetStage` / `moshPresetName`): re-applying an untouched group returns `changed:false` without a transaction, and re-applying over an edited or partial group replaces **only** that group. A preset file cannot name a filter slope, so a preset's low/high-pass runs at 12 dB/oct; a stage the user set to another slope counts as edited (2026-10-05), and re-applying replaces it at 12. Result `data`: `{trackId, presetId, revision, name, changed, replaced, stages:[{index, processor, enabled, state, params:[{id, unit, native, value, display}]}]}` — values read back from the live plugins; a low/high-pass stage's `state` also carries `slope` (dB/oct, the slope it runs at). Snapshot: `tracks[].plugins[].preset {id, name, revision, stage}` (additive; absent on plugins a user loaded; it records origin, not that the values still equal the preset's). Lock scope `Track`; in the freeze guard. Not broadcast to multiplayer peers (no per-track plugin command is). See `docs/vocal-presets/`.

*The MP-001 multiplayer commands (`mp_create_session`, `mp_commit_track`, `mp_apply_bootstrap`, etc.) are backend-only — not in this Stage-1 catalog, not in the agent catalog — see [docs/MULTIPLAYER.md](MULTIPLAYER.md) for the collaboration model. One addition of note: **`mp_fetch_missing_stems`** `{wait?}` → `✗` (non-undoable, Unguarded) → `{fetched, failed, stillMissing}` — self-heals a wave clip whose audio is `sourceMissing` by re-deriving the missing hash/ext from its own by-hash source ref (`audio/by-hash/<64-hex>.<ext>`) and retrying the download; `wait:true` runs synchronously (harness/agents), otherwise it's async (mirrors `transcribe_clip`'s dual-mode shape). Fires automatically at the end of `mp_apply_bootstrap` so a late-joiner's audio self-heals without a manual retry. Closes the "one transient upload/download failure strands a clip forever" gap (previously the only recovery was the host re-committing that track).*

## Snapshot

Plugin `params[]` entries add optional `display`, `unit`, `min`, and `max`.
`value` and all setters remain normalized 0–1. `display` comes from the host's
current-value formatter; a separately supplied label is appended once and also
exposed as `unit`. Missing text or labels leave the respective field absent.
A formatter may include units in `display` without supplying a separate `unit`.

Physical endpoints are published for native low/high-pass frequency;
compressor attack, release, output gain, and sidechain gain; and (2026-10-05)
every parameter of `4bandEq` (Hz 20–20000, dB −20–20, Q 0.1–4), `delay`
(feedback −30–0 dB, mix 0–1), `pitchShifter` (−24–24 semitones), `moshOTT`,
`softclip`, `moshXFeedback` and `moshAutoTune` (whose key 0–11 and scale 0–2
index its `choices`). They come from the live parameter range. For all of these
built-ins the normalisation is linear: `phys = min + value × (max − min)`.
The `4osc` (2026-10-05) publishes min/max on all 68 parameters, but its ranges are
JUCE NormalisableRanges that are NOT all linear, so each parameter also carries
`skew` when it is not 1 (times 0.2, levels 4, LFO rates 0.3) and `step` when the
range has an interval (Tune 1–4: 1): `phys = min + (max − min) · value^(1/skew)`,
`value = ((phys − min) / (max − min))^skew`, phys snapped to `step` when present;
no `skew` means linear (`symmetricSkew`, only when true, would mean JUCE's
symmetric mapping; no 4OSC parameter has it). An amp time at 0.5 is 1.876 s of
0.001–60 s; a level at 0.5 is −15.91 dB of −100–0 dB. Every 4OSC parameter also
carries its paramID as `id`. Its `display` strings are Tracktion's (Fine Tune is
cents and master Level is dB without a unit in the text).
Other ranges are omitted, including external-plugin ranges and the builtin
compressor's gain-domain threshold and inverse ratio (map those with the
encodings in `src/moshops/TrackPreset.h`: threshold is linear gain 0.01–1, ratio
slope ρ = 0.95·v with N = 1/ρ and v = 0 meaning ∞:1). Neither endpoints nor
display strings establish a conversion for any other processor. `set_plugin_param`
stays normalised; `set_plugin_state` (above) is physical, for state keys only.
The 16-parameter snapshot limit and all previous fields remain intact for every
plugin except the `4osc`, which publishes all 68 parameters (indices 0–67); its
first 16 only gained `id`, `min`, `max`, `skew` and `step`.

Every plugin entry (track and master) also carries `itemId`, the plugin's
EditItemID: a stable key that follows the plugin through a reorder (`index` does
not) and survives save/reload and remove+undo. Plugins with CachedValue-only
settings (`delay`, `chorus`, `phaser`, `lowpass`, `highpass`, `4osc`) carry
`state: { <key>: { value, min?, max?, step?, unit?, choices? } }` from the same
whitelist `set_plugin_state` accepts — e.g. `"state": {"lengthMs": {"value": 150,
"min": 1, "max": 2000, "step": 1, "unit": "ms"}}` on a delay, `"state": {"mode":
{"value": "highpass", "choices": ["lowpass", "highpass"]}, "slope": {"value": 12,
"min": 6, "max": 48, "step": 6, "unit": "dB/oct"}}` on a high-pass. A
value is what the plugin holds (a saved session can hold one outside the range;
the slope reports the snapped value the filter runs at);
`step` appears only on integer keys (the key's own step: 6 for `slope`, 12 for the
4OSC's `filterSlope`, 1 otherwise; `set_plugin_state` snaps onto it) and `unit` only
when there is one.
`slope` is absent on a filter that is not Mosh's subclass. All of these fields
are additive.

Every sampler plugin entry (2026-10-05) carries `sampler: { primary, kit?, sounds,
limits }`, read on the message thread from the `SOUND` children of its persisted
state (never from the list the sampler loads asynchronously). `primary` is true for
the sampler the pad commands address (the track's first; a second sampler, or one on
the master bus, is false and is read-only to the pad commands); `kit` is the track's
`drumKit` id (primary only, when set: `load_drum_kit` records it, a drum track's
default kit does not); `limits` is `{maxVoices: 32, maxSounds: 64,
minGainDb: -48, maxGainDb: 48}` (Tracktion's). Each of `sounds` (in sound-index order)
is `{index, name, file, path, missing, pitch, minNote, maxNote, gainDb, userGainDb,
silenced, pan, openEnded, chokeGroup?, mode, addressNote?, durationSec?, sampleRate?,
channels?}`: `file` is the persisted source string, `path` the absolute file the
sampler resolves it to (through the edit's resolver, so it stays absolute after
Save-As makes `file` edit-relative; `""` if unresolvable), `missing` whether nothing
is at `path`; `pitch` is the root (keyNote); `gainDb` is the live gain and
`userGainDb` the producer's level (the parked copy while `silenced`, which is true for
a muted lane AND for a pad silenced by another lane's solo); `chokeGroup` only when it
is above 0; `mode` is `"drum"` (minNote = maxNote), `"melodic"` (0–127) or `"range"`;
`addressNote` is the lowest note `set_drum_pad` / `clear_drum_pad` resolve to THIS
sound (absent when every note it covers reaches a narrower one); `durationSec`,
`sampleRate`, `channels` come from the file's header when it is readable.
`track.drumPads` / `drumKit` / `drumMutedPitches` / `drumSoloPitches` are unchanged.

```jsonc
{
  "schemaVersion": 1,
  "session":   { "sampleRate": 44100, "tempo": 120.0, "editFile": "…/session.tracktionedit" },
  "tracks": [
    { "id": "1023", "index": 0, "name": "Track 1", "type": "audio",
      "clips": [
        { "id": "1041", "name": "tone-220", "type": "wave",
          "start": 0.0, "length": 2.0, "offset": 0.0,
          "sourceFile": "…/audio/tone-220.wav", "hasRenderLayer": false }
      ] }
  ],
  "transport": { "playing": false, "recording": false, "position": 0.0,
                 "looping": false, "loopStart": 0.0, "loopEnd": 0.0 }
}
```

## Events (channel `"mosh_event"`, payload `{type, payload?}`)

- `snapshot_invalidated` — structural change; the UI refetches the snapshot. This is the documented "resync" choice (`02 // VERIFY`: snapshot_invalidated vs precise inverse-deltas). Undo/redo and reload use it. Stage 2 may refine hot paths to precise deltas.
- `transport` — `{playing, recording, position, looping, loopStart, loopEnd}`. Pushed on every `set_transport` AND **decimated to 30 Hz** by a backend timer while playing (telemetry never per-block). Drives the animated playhead without polling.
- `plugin_meters` — `{plugins: [{trackId, index, itemId, type, seq, …fields}]}`, the 30 Hz live meters of
  the native plugins that publish them (`MoshOps::pluginMeters`, public so `--selftest` asserts it).
  Volatile telemetry: never in the snapshot. An entry appears only for a TRACK plugin that is
  enabled AND was run by the audio thread since the previous tick; the rail is emitted while any
  entry exists plus ONE empty payload on the falling edge. A plugin that was not in a chain at the
  previous tick (newly loaded, or back from an undone removal, which can return the same plugin
  object) has its reading consumed and not reported, so it appears one tick later and never with
  data from before its removal. Peaks and gain reduction ACCUMULATE (largest) between ticks — at
  small buffers many blocks pass per tick. Every value is finite (a non-finite input such as +inf
  from an upstream plugin is clamped, never sent as JSON `null`): level dB values are clamped to
  [−100, +100], `grDb` to [0, 100]. `seq` (2026-10-05, every type) is a per-plugin frame counter:
  it rises by one on every entry reported for that plugin (keyed by its EditItemID, never reset,
  so it keeps rising across an undone removal and a reload), so a consumer can tell a NEW frame
  from the same frame held on screen; event fields (the 4OSC's `struck`) must fire once per `seq`.
  Fields by type:
  - `compressor`: `{grDb, inDb, outDb}`. `grDb ≥ 0` is the largest gain reduction actually applied
    since the last tick, measured as |out|/|in| per sample relative to the makeup (output) gain, on
    samples above −80 dBFS (independent of the detector's internals; a block during which the
    makeup gain changed contributes no `grDb`); `inDb`/`outDb` are sample
    peaks (max over channels 0–1) in dBFS. Every Mosh `compressor` is a `MoshCompressorPlugin`
    (Tracktion's CompressorPlugin, same `"compressor"` type, audio bit-identical, measured around
    the base class), registered from `MoshEngineBehaviour::autoInitialiseDeviceManager()` before
    Tracktion registers its own; `--selftest` fails if a loaded compressor is not one.
  - `softclip`: `{grDb, inDb, outDb}`; `grDb` = max of 20·log10(|drive·x| / |y|).
  - `moshOTT`: `{bands: [{levelDb, gainDb}] ×3 (low, mid, high), clipped}`. `levelDb` = the band's
    envelope peak since the last tick (max over channels); `gainDb` = the band's dynamic gain change
    at the end of the last block in dB (positive = upward lift, negative = downward cut; the static
    Low/Mid/High Gain trim is NOT included; across channels the one furthest from 0 dB); `clipped`
    = the output clamp (±0.999) engaged since the last tick. With Amount at 0 the band dynamics do
    not run: `levelDb` −100 and `gainDb` 0.
  - `moshXFeedback`: `{candidates: [{hz, score}], cuts: [{hz, score, depthDb}]}`, the last block's
    (channel 0), carried with a serial so a frame is never reported twice. A frame is always ONE
    block's (the latch's "latest" slots are a seqlock): if the audio thread is writing the next
    block at the tick, the previous whole frame is reported instead of a mixture.
  - `4osc` (2026-10-05): `{outDb, held: [notes], struck: [notes]}`. `outDb` = the synth's output
    sample peak since the last tick (dBFS, max over channels 0–1, floored at −100); `held` = the
    MIDI keys down at the synth now, ascending, from the MIDI it received (KEYS, not voices: the
    sustain pedal, voice stealing and release tails are not reflected); `struck` = the note-ons
    since the last tick, ascending, each once. MIDI is read exactly as the synth reads it: only
    messages whose `round(timestamp × rate)` falls inside the block, a velocity-0 note-on is a
    note-off, and a note-off, all-notes-off or reset-all-controllers acts on its own channel
    (JUCE's MPEInstrument in legacy mode, FourOsc's mode unless its `mpe` property is set, which
    Mosh never does); a block flagged all-notes-off, `reset()` and `midiPanic()` drop every key.
    Unlike the other types, an entry appears only while the synth is enabled and NOT rendering
    offline (an export or bounce is not live), and only for a tick in which a key was down, a note
    was struck or the peak exceeded 1e-5: an idle synth drops off the rail. No voice count and no
    envelope position: Tracktion keeps the voices behind a private base class.
  - `sampler` (2026-10-05): `{outDb, held: [notes], hits: [{note, vel}]}`. `hits` = the note-ons
    the sampler received since the last tick, ascending by note, each once at its largest
    velocity (`vel` 0–1 = MIDI velocity / 127), including `audition_note`'s clipless-track road
    (Tracktion's `playNotes`, reported at 0.75, the velocity it plays at); a hit is MIDI
    RECEIVED, not a voice started (a note no sound covers is still a hit). `held` = the keys
    down now (MIDI, read as the sampler reads it: any channel, a velocity-0 note-on is a
    note-off, an all-notes-off or all-sound-off releases every key; plus the audition road's
    keys); a one-shot pad rings past its note-off. `outDb` = the peak of what the sampler ADDED
    (max |out − in| over channels 0–1, dBFS, floored at −100): it passes its input through, so
    a signal before it in the chain does not count. Gated like the 4OSC: only while enabled
    and not rendering offline, and only for a tick with a hit, a key down or an added peak
    above 1e-5. An audition made while the sampler is bypassed is dropped. No voice count:
    Tracktion keeps the voices private.
  Mosh AutoTune is NOT on this rail (it keeps `tuner`; its latch has a single reader). Known limit:
  an offline render (export, bounce) runs the same plugin objects, so a meter can report during an
  export as the `tuner` rail can (the 4OSC's and the sampler's entries are gated on not rendering;
  the others are not).

## Undo / threading invariants

- **One undo system:** `edit.getUndoManager()` (a `juce::UndoManager`) is the implementation. `beginNewTransaction("<command>")` groups each undoable command. No shadow model.
- **CAP-PRJ-005 — the log and the undo stack are two different lists, and `jump_to_history` is what reconciles them.** `mosh-log.jsonl` records *every* command including the deliberately non-undoable ones (`set_metronome`, `set_project_settings`, transport moves); the `UndoManager` holds only the transactions that materialised. So "jump to log entry N" can never be "undo N times" — the counts diverge the moment a preference command lands, and they diverge *silently*. Every log line therefore carries a `txn` stamp: `"<per-process token>:<transaction id>"`, the **identity** of the undo point that command left the session at, read off the `UndoManager` rather than off the caller's `undoable` claim (so a command that opened an *empty* transaction — the G14 class — correctly shares the previous point). `jump_to_history {txn}` resolves that identity against the live timeline and calls `undo()`/`redo()` the right number of times; a point that is gone (undone past then overwritten, evicted as the history filled, or stamped by an earlier process) **refuses** rather than landing somewhere else. `get_command_log` publishes `currentTxn` + `restorableTxns` so the UI can render an unreachable row as unreachable *before* it is clicked. Deliberately **not** an index: JUCE reuses indices when a new edit discards the redo tail, and shifts them all down when `dropOldTransactionsIfTooLarge()` evicts the oldest transaction.
- **Threading:** `execute()`, `snapshot()`, and event emission run on the **message thread** (WebView native callbacks land there). Audio stays on the RT graph. The 30 Hz transport timer is the only periodic emit.

## JSONL log (`<session>/mosh-log.jsonl`)

One line per executed command — the semantic audit trail / taste-signal flywheel:
```jsonc
{ "ts": 1719…, "seq": 7, "command": "import_clip", "args": {…}, "ok": true, "undoable": true, "txn": "a1b2c3d4:5" }
```
`txn` (CAP-PRJ-005) is the undo point this command left the session at — see *Undo / threading invariants* above. Absent on lines written before it shipped, which reads as "not a restore point".
Stage 5 adds `accept_render` / `reject_render` lines as explicit **taste labels**.

*`freeze_layer` / `unfreeze_layer` (2026-07-26): freeze keeps the rendered audio and DISARMS the Phase-3 reactive loop — it sets `ids::reactive=false`, the flag `reactiveTouch` gates on, so edits stop re-rendering the layer. It also writes `status="frozen"`, but that is only a label: a later `set_render_param` overwrites it with `"dirty"` while the layer stays frozen, so the snapshot's `renderLayer.reactive` is the ONLY reliable read of the freeze (a UI keying on `status` loses the badge at the first knob turn). `unfreeze_layer` re-arms the loop and reports `"dirty"` rather than `"ready"` — edits made while frozen deliberately skipped their re-render, so freshness cannot be claimed. Both are undoable, one transaction each. Until this landed, freeze wrote the label and nothing else: nothing read it, no thaw existed, and a "frozen" layer re-rendered on the very next edit.*

*TASTE-002 (2026-07-19): the in-place overhaul (PR #185) removed accept/reject from the wave loop, so the flywheel stalled. The restored spigot: `reset_render_layer` logs as the workflow's explicit **negative** label, and a successful `save` / `export_audio` sweeps every still-applied (`appliedInPlace`, not bypassed) layer and logs one `render_kept` line — a **soft positive**, deduped on layerId per process. `render_kept` is a log-line type, NOT an executable command. All three carry `{clipId, layerId, cacheKey, adapter}` so each label joins to its render artifact. Consumer: `service/taste/census.py` (branch `claude/taste-loop-week1`) — explicit labels supersede a same-segment `render_kept`.*
