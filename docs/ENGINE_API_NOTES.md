# Engine API Notes — resolved `// VERIFY` items

*Resolved against the **pinned** clone `tracktion_engine @ 2877b621f2fbee564d0696a616b86bf8ba8c8ab0` (JUCE submodule `7c89e11f6b7316c369f3d3f22227c60e816e738b`). These are the source-of-truth signatures the MoshOps handlers wrap. Update if the pin moves.*

Namespace alias used throughout: `namespace te = tracktion::engine;`

---

## Engine bootstrap (01 §1)

```cpp
te::Engine (juce::String applicationName);                                    // simplest
te::Engine (juce::String, std::unique_ptr<UIBehaviour>, std::unique_ptr<EngineBehaviour>);
te::Engine (std::unique_ptr<PropertyStorage>, std::unique_ptr<UIBehaviour>, std::unique_ptr<EngineBehaviour>);
```
For a standalone app, the 3-arg form with `te::ExtendedUIBehaviour` is the documented choice; the 1-arg form is fine for bring-up. Device manager auto-inits.

Out-of-process VST3 scan hook (call early in `initialise`, before constructing the window):
```cpp
if (te::PluginManager::startChildProcessPluginScan (commandLine)) return;  // PluginManager.h:29
```

## Edit creation / load / save (01 §2.1, §6) — **RESOLVED**

From `model/edit/tracktion_EditFileOperations.h`:
```cpp
std::unique_ptr<te::Edit> te::createEmptyEdit (te::Engine&, const juce::File&);   // :61  ← new project
juce::ValueTree           te::createEmptyEdit (te::Engine&);                       // :79  (state only)
std::unique_ptr<te::Edit> te::loadEditFromFile (te::Engine&, const juce::File&);   // open existing
```
Demos use exactly these (`PlaybackDemo.h:35/49`). Edit also has direct ctors:
```cpp
te::Edit (te::Edit::Options);          // full control (engine, editState, editProjectItemID, role, numUndoLevelsToStore, numAudioTracks, ...)
te::Edit (te::Engine&, te::Edit::EditRole);   // new empty edit
```
**Save** — use `EditFileOperations` (NOT a bare `edit.save()`):
```cpp
te::EditFileOperations (edit).save (bool warnOfFailure, bool forceSaveEvenIfNotModified, bool offerToDiscardChanges);  // :26
te::EditFileOperations (edit).writeToFile (const juce::File&, bool writeQuickBinaryVersion);                            // :30
te::EditFileOperations (edit).saveAs (const juce::File&, bool forceOverwriteExisting = false);                          // :27
```
→ Stage 1 save: `te::EditFileOperations (*edit).save (false, true, false);`

## Tracks (01 §2.2) — **RESOLVED**

```cpp
te::AudioTrack::Ptr edit.insertNewAudioTrack (te::TrackInsertPoint, te::SelectionManager*, bool addDefaultPlugins = true);  // Edit.h:387
// Easiest (demos):
edit.ensureNumberOfAudioTracks (n);
auto* track = te::getAudioTracks (edit)[index];      // EngineHelpers::getOrInsertAudioTrackAt
```

## Clips (01 §2.2) — **RESOLVED**

`ClipPosition { TimeRange time; TimeDuration offset; }`, `TimeRange { TimePosition start; TimeDuration length; }` (EditTime.h:357).
```cpp
te::WaveAudioClip::Ptr track->insertWaveClip (const juce::String& name, const juce::File& sourceFile,
                                              te::ClipPosition position, bool deleteExistingClips);   // ClipTrack.h:73
te::MidiClip::Ptr      track->insertMIDIClip (te::TimeRange position, te::SelectionManager*);          // ClipTrack.h:79
Clip*                  track->insertNewClip (TrackItem::Type, name, TimeRange, SelectionManager*);
void                   track->deleteRegion (te::TimeRange, te::SelectionManager*);
// split: ClipTrack::splitClip(...)  ("breaks a clip into 2 bits")
```
Canonical clip-from-file (EngineHelpers::loadAudioFileAsClip):
```cpp
te::AudioFile audioFile (edit.engine, file);
if (audioFile.isValid())
    track->insertWaveClip (file.getFileNameWithoutExtension(), file,
                           { { {}, te::TimeDuration::fromSeconds (audioFile.getLength()) }, {} }, false);
```
> Pitfall (01 §2.2): garbled/silent clips ⇒ wrong ClipPosition/offset or the source AudioFile went out of scope. Use strong time types.

### Audio warp / time-stretch (easy-warp) — **RESOLVED**
`te::AudioClipBase`: `setTimeStretchMode(mode)` + `getLoopInfo().setBpm(sourceBpm, audioFile.getInfo())` + `setAutoTempo(true)` make a wave clip re-anchor in beats and time-stretch to follow the tempo map (vendored SoundTouch; `te::TimeStretcher::checkModeIsAvailable(defaultMode)`). `ac->getAudioFile().getLength()` = source seconds. With auto-tempo on, the warped seconds-length is `sourceLen × sourceBpm / projectBpm`, so `stretch_clip` derives `sourceBpm = projectBpm × targetLen / sourceLen` (and, for a bar target, `sourceBpm = bars × beatsPerBar × 60 / sourceLen`, project tempo cancelling) then `setPosition` to fill the target span explicitly. `detect_clip_bpm` reads the source via `juce::AudioFormatReader` (same path as `get_clip_peaks`) and autocorrelates a per-hop onset envelope — pure C++, no service, deterministic in `--selftest`. Warp MARKERS (per-transient anchors, `WarpTimeManager`) remain deferred.

## Transport & device (01 §5) — **RESOLVED**

`auto& transport = edit.getTransport();` (`TransportControl`):
```cpp
void play (bool justSendMMCIfEnabled);            // :72
void playFromStart (bool);                         // :75
void stop (bool discardRecordings, bool clearDevices /*…*/);  // :98
void record (bool, bool allowRecordingIfNoInputsArmed = false); // :91
void setPosition (te::TimePosition);               // :159
void setLoopRange (te::TimeRange);                 // :193
bool isPlaying(); bool isRecording();
LoopBoolProxy looping;                             // transport.looping = true;
void ensureContextAllocated (bool alwaysReallocate = false);   // :214  ← create EditPlaybackContext
te::EditPlaybackContext* getCurrentPlaybackContext() const;    // :206  (non-null when attached)
```
Device selector binds `engine.getDeviceManager().deviceManager` (a `juce::AudioDeviceManager`) — Utilities.h:112.
> **Render/playback exclusivity (matters for 05):** offline render asserts if the Edit is attached to the device. Generative render flow renders on a detached Edit / detaches the playback context.

## VST3 hosting + editor (04 PART 1) — **RESOLVED**

```cpp
auto plugin = edit.getPluginCache().createNewPlugin (te::ExternalPlugin::xmlTypeName, desc);
track->pluginList.insertPlugin (plugin, index, nullptr);     // order = signal order
plugin->removeFromParent();   // detach     plugin->deleteFromParent();  // full remove
```
**Editor accessor (was the thin `// VERIFY`) — RESOLVED** (examples/common/PluginWindow.h):
```cpp
struct AudioProcessorEditorContentComp : public te::Plugin::EditorComponent {
    AudioProcessorEditorContentComp (te::ExternalPlugin& plug) : plugin (plug) {
        if (auto pi = plugin.getAudioPluginInstance()) {        // ← the accessor
            editor.reset (pi->createEditorIfNeeded());
            if (editor == nullptr)
                editor = std::make_unique<juce::GenericAudioProcessorEditor> (*pi);
        }
    }
};
// Window: te::PluginWindowState (plugin.windowState), DocumentWindow wrapper.
```
Params: `AutomatableParameter` / `ExternalAutomatableParameter`; `getAutomatableParameterByID`, `setParameter(v, juce::sendNotification)`, `getCurrentValue()`, `getCurve()`.

## Custom Plugin = Tier-A neural insert (04 PART 2) — template RESOLVED

`examples/DemoRunner/demos/DistortionEffectDemo.h` is the exact template:
```cpp
struct DistortionPlugin : public te::Plugin {
    static const char* xmlTypeName;                                     // = "Distortion"
    DistortionPlugin (te::PluginCreationInfo info) : Plugin (info) { … } // CachedValue/param setup
    juce::String getName() const override;
    juce::String getPluginType() override            { return xmlTypeName; }
    void applyToBuffer (const te::PluginRenderContext& fc) override;     // RT thread
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;
    // + initialise / deinitialise / getNumOutputChannelsGivenInputs / getLatencySeconds
};
const char* DistortionPlugin::xmlTypeName = "Distortion";
// register once:   engine.getPluginManager().createBuiltInType<DistortionPlugin>();
// instantiate:     edit.getPluginCache().createNewPlugin (DistortionPlugin::xmlTypeName, {});
```
`PluginRenderContext fc`: `fc.destBuffer` (`juce::AudioBuffer<float>*`), `fc.bufferNumSamples`, `fc.bufferStartSample`, `fc.bufferForMidiMessages`. Base stores `sampleRate`, `blockSizeSamples`. Latency base: `virtual double getLatencySeconds() { return 0.0; }`.

## Drum pattern (DRM-002 `add_drum_pattern`) — RESOLVED

Verified against the pinned clone for the composite grid command:
- **Beats↔seconds at a position:** `BeatPosition TempoSequence::toBeats (TimePosition)` /
  `TimePosition TempoSequence::toTime (BeatPosition)` (`model/edit/tracktion_TempoSequence.h:169,178`;
  in-repo precedent MoshOps.cpp sections code). New-clip span:
  `endTime = toTime (fromBeats (toBeats (fromSeconds (start)).inBeats() + bars * beatsPerBar))`.
- **Time signature at a position:** `TimeSigSetting& TempoSequence::getTimeSigAt (TimePosition)`
  → `numerator.get()` (`tracktion_TimeSigSetting.h:50`; precedent `ts->numerator.get()` in the
  sections code). NB `beatsPerBar` here is the NUMERATOR — same convention as the UI drum grid
  (`drumGrid.ts stepBeats`), which coincides with Tracktion quarter-note beats for `x/4` meters;
  `x/8` meters would diverge (pre-existing drum-grid convention, not resolved here).
- **Notes:** `MidiList::addNote (pitch, BeatPosition, BeatDuration, velocity, colourIndex, UndoManager*)`
  (`tracktion_MidiList.h:85`, the `cmdAddNote` idiom). Selective removal (per-lane replace):
  descending-index loop of `seq.removeNote (*seq.getNote (i), &undoManager())` — the
  `cmdRemoveNote` idiom; `MidiList::clear` NOT used (replace must leave unnamed lanes intact).
- **Clip:** `track->insertMIDIClip (name, { TimePosition, TimePosition }, nullptr)` exactly as
  `cmdAddMidiClip`; clip-note beats are clip-local (no clip-start offset).
- clipId→track resolution: `clip->getTrack()` (proven via `lockKeyFor`'s Clip branch).

## Count-in / pre-roll before recording (G2b `set_count_in`) — RESOLVED, engine ALREADY had it

`tracktion_engine` ships a REAL, engine-native pre-roll — no new recording machinery was
needed, only exposing + persisting the setting:

- **`te::Edit::CountIn`** (`model/edit/tracktion_Edit.h:707`): `enum class CountIn { none=0,
  oneBar=1, twoBar=2, twoBeat=3, oneBeat=4 }`; `void setCountInMode (CountIn)` / `CountIn
  getCountInMode() const` / `int getNumCountInBeats() const` (`tracktion_Edit.cpp:2500`).
  `setCountInMode` writes through `engine.getPropertyStorage()` — engine-global storage, NOT
  part of the Edit's own ValueTree, so it does NOT persist with a specific project on its own.
  Mosh's `countInBars` (0/1/2, matching `none`/`oneBar`/`twoBar`'s literal underlying values —
  see `state/CountIn.h`) is instead the durable, per-project, on-tree source of truth (same
  `MOSH_PROJECT` node as `timeBase`/`musicalTonic`); `MoshOps::applyCountInToEdit()` re-pushes
  it into the live `Edit::setCountInMode` both immediately (`cmdSetCountIn`) and right before
  every `record` action (`cmdSetTransport`), so the engine's live state always matches the
  stored project preference regardless of load order.
- **Where the engine actually consults it:** `TransportControl::performRecord()`
  (`playback/tracktion_TransportControl.cpp:~1483`) reads `edit.getNumCountInBeats()`,
  rolls `prerollStart` back that many beats from the punch-in time, and — when count-in beats
  > 0 — calls `edit.setClickTrackRange(...)` so the click track audibly counts in through the
  pre-roll; `playbackContext->prepareForRecording(prerollStart, punchInTime)` is what actually
  delays capture until the real punch-in point. This is exactly "N bars of pre-roll before
  capture begins" — Mosh gets it for free once `setCountInMode` is set correctly.
- **v0 scope:** only `none`/`oneBar`/`twoBar` are exposed (bars 0/1/2); `oneBeat`/`twoBeat`
  exist in the engine but aren't surfaced — a small future extension, not a v0 need.
- **Verification ceiling:** headless (`--selftest`/`--run-script`) can prove the command's
  validation/snapshot/persistence/non-undoable-preference contract, but NOT the audible click
  or the actual delayed capture start — that needs a live audio device (`transport.record()`'s
  branch is gated on `eng.hasAudio()`), same posture as `fam_transport_play` in
  `scripts/daw-conformance/conformance.py`.

## Metronome / click track (CAP-TRN-005 `set_metronome`) — RESOLVED, engine ALREADY had all of it

`tracktion_engine` owns sound, level, emphasis, recording-only and routing already. Mosh
adds no model of its own — `set_metronome` grew from a one-arg toggle into a partial patch
over exactly this surface. The split below is the ENGINE's, and it is the thing to know
before designing args: **five of the settings are per-Edit, four are app-global.**

### Per-Edit — the `CLICKTRACK` child of the Edit's own ValueTree

`Edit::initialiseClickTrack()` (`model/edit/tracktion_Edit.cpp:985`) creates
`state.getOrCreateChildWithName (IDs::CLICKTRACK, nullptr)` and binds:

| CachedValue | ValueTree property | Notes |
|---|---|---|
| `clickTrackEnabled` (`bool`) | `IDs::active` | what `set_metronome` already wrote |
| `clickTrackGain` (`float`) | `IDs::level` | defaults from `SettingID::lastClickTrackLevel` (0.6) |
| `clickTrackEmphasiseBars` (`bool`) | `IDs::emphasiseBars` | big click on beat 1; engine default **off** |
| `clickTrackRecordingOnly` (`bool`) | `IDs::onlyRecording` | consulted in `ClickGenerator::isMutedAtTime` |
| `clickTrackDevice` (`String`) | `IDs::outputDevice` | **private** — see the read-back trap below |

Because they live in the Edit's tree they **save and reload with the `.tracktionedit`** —
no `MOSH_PROJECT` mirror is needed (unlike REC-001, whose engine homes are per-device and
unreachable headless). And every one of those `referTo` calls passes a **`nullptr`
UndoManager**, which is why `cmdSetMetronome` still takes no Tracktion transaction: one
here could only ever be an EMPTY transaction, and an empty transaction's undo destroys the
*previous* real edit (the G14 class).

Accessors (`tracktion_Edit.h:684-722`, `tracktion_Edit.cpp:2450-2496`):

```cpp
float  Edit::getClickTrackVolume() const noexcept;      // jlimit (0.2f, 1.0f, clickTrackGain)
void   Edit::setClickTrackVolume (float gain);          // clamps the SAME way, and mirrors
                                                        //   to SettingID::lastClickTrackLevel
juce::String Edit::getClickTrackDevice() const;         // NORMALISES — see below
bool   Edit::isClickTrackDevice (OutputDevice&) const;
void   Edit::setClickTrackOutput (const juce::String& deviceName);   // + restartPlayback()
void   Edit::setClickTrackRange (TimeRange) noexcept;   // what the count-in pre-roll uses
```

- **The level has a FLOOR, and 0 is not silence.** `getClickTrackVolume()` re-clamps to
  `[0.2, 1.0]` on every *read*, so a 0..1 UI slider would have a dead bottom fifth. Mosh
  surfaces `levelMin`/`levelMax` in the snapshot so the UI draws the honoured range, and
  the command returns the *effective* value rather than the requested one.
- **Read-back trap for routing.** `clickTrackDevice` is a **private** member, and
  `getClickTrackDevice()` returns `DeviceManager::getDefaultAudioOutDeviceName (false)` for
  any name `findOutputDeviceWithName` cannot resolve. Headless — no output devices at all —
  that means *every* stored route reads back as the default, which is indistinguishable
  from "it never persisted". `clickSettingsToVar()` therefore reads the raw intent straight
  off the tree (`state.getChildWithName (te::IDs::CLICKTRACK).getProperty (te::IDs::outputDevice)`)
  and reports it as `outputDevice` alongside the normalised `outputDeviceResolved`.
- **Routing is by NAME, not deviceID** — the opposite of `set_track_output`.
  `DeviceManager::findOutputDeviceWithName` (`tracktion_DeviceManager.cpp:1411`) matches
  wave outs *and* MIDI outs, and resolves two sentinels: `"(default audio output)"` and
  `"(default MIDI output)"` (`getDefaultAudioOutDeviceName`/`getDefaultMidiOutDeviceName`,
  both `bool translated` → pass `false` for the storage form).
- **Where the routing lands:** `createNodeForEdit` (`playback/graph/tracktion_EditNodeBuilder.cpp:1876,1951`)
  ensures the click's device is in the device map, then sums a `ClickNode` into that
  device's node. So "click to headphones only" is a real engine capability, not an emulation.

### App-global — `te::PropertyStorage`, via the `Click` free functions

`playback/graph/tracktion_ClickNode.h:15-21`:

```cpp
namespace Click {
    int          getMidiClickNote  (Engine&, bool big);                        // 37 / 76 default
    juce::String getClickWaveFile  (Engine&, bool big);                        // "" ⇒ built-in
    void         setMidiClickNote  (Engine&, bool big, int noteNum);
    void         setClickWaveFile  (Engine&, bool big, const juce::String&);
}
```

- Backed by `SettingID::clickTrackSampleBig/Small` + `clickTrackMidiNoteBig/Little`. The
  engine has **no per-Edit home** for these — they are a machine preference like the audio
  device, and Mosh stores them where the engine does rather than inventing a second truth.
- Both setters call `TransportControl::restartAllTransports (e, false)`, so a change takes
  effect on a running transport.
- **The click loader is WAV-only.** `ClickGenerator::prepareToPlay` reads the file through
  `juce::WavAudioFormat` *directly* (`loadWavDataIntoMemory`, `tracktion_ClickNode.cpp:17-55`),
  not the format manager, and falls back to `TracktionBinaryData::bigclick_wav` /
  `littleclick_wav` when the buffer comes back empty. That fallback is **silent**, so
  `cmdSetMetronome` refuses a non-`.wav` (or missing) path rather than storing a setting
  that looks applied and is not.
- **The MIDI notes only exist on a MIDI route.** `ClickGenerator::processBlock`
  (`tracktion_ClickNode.cpp:139-161`) reads them in its `midi` branch alone; on an audio out
  they are inert. The UI reveals them only once a MIDI destination is chosen.
- **Include trap:** `tracktion_ClickNode.h` is NOT reachable from client code — the module
  includes it only from `tracktion_engine_playback.cpp`, and it also declares `ClickNode`,
  which derives from `tracktion::graph::Node` (not in the public include set), so including
  it by path fails on an incomplete base class. `MoshOps.TempoProject.cpp` re-declares the
  four `Click` functions verbatim instead; they have external linkage, so this still *calls*
  the engine's implementation, and a signature change becomes a link error rather than a
  silent divergence.

### Emphasis, and what "big" means

`ClickGenerator::processBlock` reads `edit.clickTrackEmphasiseBars` and picks `bigClick` vs
`littleClick` (audio) or `bigClickMidiNote` vs `littleClickMidiNote` (MIDI) on
`tempoPosition.getBarsBeats().getWholeBeats() == 0`. With emphasis **off** — the engine
default — every beat is the little click, which is why "accent the downbeat" is a real
capability gain and not a cosmetic toggle.

### Verification ceiling — and why `verify.py` cannot close it either

Stricter than count-in's, and worth stating precisely because the obvious assumption is
wrong. **The click is not in an offline render at all.** `makeNode<ClickNode>` appears
exactly once in the whole engine — `tracktion_EditNodeBuilder.cpp:1954`, inside
`createNodeForEdit (EditPlaybackContext&, …)`, the **live playback** builder, where it is
summed into a specific output device's node. The **offline** overload
`createNodeForEdit (Edit&, const CreateNodeParams&)` (`:1970`) — the one
`Renderer::renderToFile`/`turnEditIntoRenderJob` call, and therefore the one behind
`export_audio` and every `scripts/verify-hardware/verify.py` WAV — builds tracks → master
plugins → master fades → racks and **never adds a ClickNode**. (This is also correct DAW
behaviour: your bounce should not have the metronome in it.)

So the three lanes are:

| Lane | Proves | Cannot |
|---|---|---|
| `Mosh --selftest` | arg validation, refusals, clamping, the snapshot block, save+reload persistence, the write reaching `te::Edit`'s own state, `undoable:false` | any audio — headless has no device |
| `verify.py` (offline `renderToFile`) | nothing about the click | **the click is not in the graph it renders** |
| A live session at a real device | the click, its level, its accent, its route | — |

For level, sound and routing there is therefore **no harness that can hear it**: it is an
owner listen or nothing. Do not report a green `--selftest` (or a green `verify.py`) as
evidence the click got quieter.

## Export range/section + delay-tail policy (G1 `export_audio`) — RESOLVED

Verified against the pinned clone (`model/export/tracktion_Renderer.h`):
- `Renderer::Parameters::time` (`TimeRange`) is the render span — set from two
  `TimePosition::fromSeconds(...)` values exactly like `params.time` was already built
  from `TimePosition()`/`edit.getLength()`; no new idiom needed.
- `Renderer::Parameters::endAllowance` (`TimeDuration`) is the delay-tail policy,
  already built into the engine ("optional tail time for notes to end, delays/reverbs
  to decay… stopped early once the level drops to silence within the allowance" —
  `tracktion_NodeRenderContext.cpp:147,302-312`). `tail:"cut"` leaves it at the default
  `0s`; `tail:"include"` sets it to the clamped `tailSeconds`.
- `TransportControl::getLoopRange()` (`playback/tracktion_TransportControl.h:196`) reads
  `CachedValue<TimePosition> loopPoint1/loopPoint2` — context-independent (no playback
  context needed), so it's safe to read before the render-exclusivity teardown; a fresh
  Edit's loop defaults to `{0,0}` (empty — the "no loop set" error case).
- `endAllowance>0` disables the WAV ACID-loop metadata (`tracktion_Renderer.cpp:83`
  only stamps it when `endAllowance==0s`) — harmless; a tail-included render isn't a
  clean one-shot loop by definition.
- Range/tail resolution + validation is pure and engine-free
  (`mosh::resolveExportRange`, `src/moshops/ExportRange.h`), unit-tested directly by
  `tests/test_export_range.cpp` without a live `MoshEngine`.

## Track mute (CAP-AUT-006) — RESOLVED: the engine has NO automatable mute parameter

Searched before designing anything, because the whole shape of the ticket turns on the
answer. **There is none, on any axis, in the pinned clone.** What exists:

- **Track mute is a property, not a parameter.** `Track::setMute(bool)` /
  `AudioTrack::setMute` (`model/tracks/tracktion_AudioTrack.cpp:426`) writes
  `muted`, a `CachedValue<bool>` on `IDs::mute` (`:110`). Nothing automatable is attached
  to it.
- **It is applied in the graph, not in a plugin.** `TrackMuteState` reads
  `track->shouldBePlayed()` once per block from `TrackMutingNode::prefetchBlock`
  (`playback/graph/tracktion_TrackMutingNode.cpp:36,63`), and
  `createNodeForAudioTrack` (`playback/graph/tracktion_EditNodeBuilder.cpp:1418`) wraps
  an audio track in **two** of those nodes — one over the clips, one over the whole
  track output — while `PluginNode` skips a muted track's plugins entirely
  (`tracktion_PluginNode.cpp:185-191`, gated on
  `TrackMuteState::shouldTrackContentsBeProcessed()`). That is why the routing mute is
  cheaper than any gate: nothing on the track runs.
- **`VolumeAndPanPlugin::muteOrUnmute()` is not it.** It stores `lastVolumeBeforeMute`
  and drives the fader to −100 dB and back (`plugins/internal/tracktion_VolumeAndPan.cpp:322`) —
  a UI convenience on the existing `volume` parameter, not a parameter of its own, and
  gain rather than routing.
- **The internal plugins' full automatable-parameter set** is `volume`/`pan` on
  `VolumeAndPanPlugin`, `vca` on `VCAPlugin`, and the four Rack in/out params
  (`grep addAutomatableParameter plugins/internal/*.cpp`). No mute anywhere.
- `AutomatableParameter` *does* support stepped parameters —
  `isDiscrete()`/`getNumberOfStates()`/`getValueForState()`/`snapToState()`
  (`model/automation/tracktion_AutomatableParameter.h:176-184`), and
  `setParameterValue` runs **every** applied value through `snapToState`
  (`:1387`), including each sample taken off a curve. So a two-state parameter is
  applied as a step, which is what a mute lane must be.

**What Mosh built instead** (`src/plugins/mixer/TrackMutePlugin.{h,cpp}`): a hidden
per-track plugin carrying one discrete `mute` parameter, applied as a 5 ms-ramped
multiply by zero, inserted immediately upstream of the post-fader metering tap. It is a
**gate, not routing** — the clips and plugins still run and are silenced, where
`set_track_mute` stops them running at all. `TrackMutePlugin.h` states the difference in
full; the audible proof is `scripts/verify-hardware/verify.py::check_mute_automation`.

No engine patch was needed or taken for this.

## Still to verify at their stages

- **Takes / CompManager / WaveCompManager** external-take injection — Stage 5. If opaque → new-clip-on-neural-lane fallback (already a user-selectable mode, 05 §3.1).
- **LatencyPlugin .h/.cpp** exact latency-reporting pattern — Stage 4. `modules/tracktion_engine/plugins/effects/`.
- **anira `InferenceHandler::process/prepare`** signatures — Stage 4, against the pinned anira.
- **Bypassed-plugin PDC** (`allowBypassedProcessing` / `canProcessBypassed`, forum #53709) — Stage 4, in `tracktion_PluginNode.cpp`.

## Applied engine patches (committed under `patches/`, wired in `cmake/Dependencies.cmake`)

- **`0001-tracktion-createNewItemID-scan-all-caches.patch`** — `Edit::createNewItemID()`
  seeded its ID allocator by scanning only `trackCache` + `clipCache`, not the other three
  `EditItemCache`s. A plugin whose ID lived only in `automatableEditItemCache` (reconstructed
  on reload, or outliving its removal via the undo stack) was invisible to the allocator, so
  a new plugin could be handed a duplicate ID → `EditItemCache::addItem` jassert (and, in
  release, a silently overwritten `itemID → item` map). The patch adds `visitItems` scans for
  `clipSlotCache`, `automatableEditItemCache`, and `automationCurveModifierEditItemCache`.
  Additive, message-thread-only, once-per-Edit; no behavior change for normal edits. Verified:
  `--selftest` JUCE-assertion count 1 → 0. **Re-pinning tracktion (GIT_TAG) requires
  re-rolling this patch against the new revision.**
