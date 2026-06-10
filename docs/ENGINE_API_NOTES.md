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

## Stage 7 — MoshIR engine gaps (phase0 §3.3) — **RESOLVED** (2026-06-09)

**Tempo / time-sig** (`model/edit/tracktion_TempoSequence.h`):
```cpp
edit.tempoSequence.getTempoAt (TimePosition()).setBpm (bpm);        // first setting always exists (120 @ beat 0)
edit.tempoSequence.getTimeSigAt (TimePosition()).numerator = n;     // CachedValue<int>, + denominator
BeatPosition toBeats (TimePosition); TimePosition toTime (BeatPosition);   // :169/:178 — the conversion heart
```
**No global swing/groove** on TempoSequence — only `MidiClip::get/setGrooveTemplate`. → `project.set_swing` is gap-ledgered.

**MIDI notes** (`midi/tracktion_MidiList.h`): `midiClip->getSequence()` → `MidiList&`;
`addNote (int pitch, BeatPosition startBeat /*clip-relative*/, BeatDuration, int vel, int colourIndex, UndoManager*)` (:85);
`removeNote (MidiNote&, um)`; `MidiNote::setNoteNumber/setVelocity/setStartAndLength (..., um)`.

**Sampler** (`plugins/effects/tracktion_SamplerPlugin.h`): xmlTypeName `"sampler"`;
`addSound (path, name, startTime, length, gainDb) → String error ("" = ok)` (:38); `setSoundParams (idx, keyNote, minNote, maxNote)`; `setSoundOpenEnded`.

**Builtin xmlTypeNames** (verified in .cpps): `4osc`, `compressor`, `4bandEq`, `delay`, `reverb`, `lowpass`, `pitchShifter`, `chorus`, `phaser`, `auxsend`, `auxreturn`. Instantiate ALL via `edit.getPluginCache().createNewPlugin (xmlTypeName, {})`.

**Sends/returns/routing**: `AuxSendPlugin::busNumber` (CachedValue<int>) pairs with `AuxReturnPlugin::busNumber`; `setGainDb`. Track routing: `audioTrack->getOutput().setOutputToTrack (dest)` / `setOutputToDefaultDevice (false)` (`model/tracks/tracktion_TrackOutput.h:66`).

**Sidechain** (`plugins/tracktion_Plugin.h:246–377` + `effects/tracktion_Compressor.h`):
`plugin->setSidechainSourceID (track.itemID)`; `comp->useSidechainTrigger = true`; `comp->guessSidechainRouting()` wires the channels. Dynamics params set via name-scan on AutomatableParameters (engine param names are version-fragile).

**Automation** (`model/automation/tracktion_AutomationCurve.h:89`):
`param->getCurve().addPoint (EditPosition, float value, float curve(-1..1), um)`. **Point values are RAW param values**, not normalized — `AutomatableParameter.cpp:236` reads `curve.getValueAt (time, parameter.getCurrentBaseValue())` → convert IR's value_norm via `param->valueRange.convertFrom0to1 (v)`. Mixer lanes: `VolumeAndPanPlugin::volParam/panParam` (public Ptr members, :74).

**Clip pitch/stretch** (`model/clips/tracktion_AudioClipBase.h`): `setPitchChange (float ±48)` (:363); `setTimeStretchMode (TimeStretcher::soundtouchBetter)` + `setSpeedRatio (double)` (:293–306; engine falls back via getActualTimeStretchMode when a mode isn't compiled). **Transient detection is async** (`WarpTimeManager::getTransientTimes() → {done, times}`) → `sample.slice mode=transient` is gap-ledgered; grid slicing = repeated `ClipTrack::splitClip`.

**JUCE gotcha re-learned at the gate:** (1) non-ASCII string literals (e.g. `§`) into `juce::String` fire the UTF-8 assertion — keep selftest labels ASCII. (2) `*someVar.getProperty ("x", {}).getArray()` in a range-for dangles when the PARENT var is itself a temporary (refcount drops) — bind the parent to a named var first.

## Still to verify at their stages

- **Renderer::Parameters** field names + `renderToFile` overload (`tracksToDo` bitset, `allowedClips`) — Stage 5. Grep `modules/tracktion_engine/.../tracktion_Renderer.h`.
- **Takes / CompManager / WaveCompManager** external-take injection — Stage 5. If opaque → new-clip-on-neural-lane fallback (already a user-selectable mode, 05 §3.1).
- **LatencyPlugin .h/.cpp** exact latency-reporting pattern — Stage 4. `modules/tracktion_engine/plugins/effects/`.
- **anira `InferenceHandler::process/prepare`** signatures — Stage 4, against the pinned anira.
- **Bypassed-plugin PDC** (`allowBypassedProcessing` / `canProcessBypassed`, forum #53709) — Stage 4, in `tracktion_PluginNode.cpp`.
