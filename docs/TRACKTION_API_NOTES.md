# Tracktion Engine API Notes (resolved `// VERIFY` items)

**Pin:** `tracktion_engine` tag **v3.2.0** (commit `0a5f4e6a5f53d09c89b414a44386a12df7fa1ec6`, `VERSION.md` = `3.2.0`).
**Clone path:** `C:\Users\dawha\Documents\MBMC\.refclone\tracktion_engine`
**Read scope:** tracktion's own headers/source under `modules/tracktion_engine/` plus `examples/` (no submodules fetched — none needed).
**Citations** are `relative/path:LINE` from the clone root.

All public API lives in `namespace tracktion { inline namespace engine { ... } }`. The examples alias it as `namespace te = tracktion;` (see `examples/common/Utilities.h:11`). Strong time types (`TimePosition`/`TimeDuration`/`TimeRange`/`BeatPosition`/`EditTime`/`EditTimeRange`) are used throughout the clip/transport/render API on this commit — raw `double` seconds appear only in legacy/internal comping helpers.

---

## 1. Edit creation

**Free functions (the call examples use):**
```cpp
// modules/tracktion_engine/model/edit/tracktion_EditFileOperations.h
std::unique_ptr<Edit> loadEditFromFile  (Engine&, const juce::File&,
                                         Edit::EditRole role = Edit::EditRole::forEditing);   // :53
std::unique_ptr<Edit> loadEditFromState (Engine&, const juce::ValueTree&,
                                         Edit::EditRole role = Edit::EditRole::forEditing);   // :57
std::unique_ptr<Edit> createEmptyEdit   (Engine&, const juce::File&);                         // :61
```

**`Edit::Options` struct** — `modules/tracktion_engine/model/edit/tracktion_Edit.h:107`:
```cpp
struct Options {
    Engine& engine;                                              // :109
    juce::ValueTree editState;                                   // :110  @see createEmptyEdit
    ProjectItemID editProjectItemID;                             // :111  must be valid
    EditRole role = forEditing;                                  // :113
    LoadContext* loadContext = nullptr;                          // :114
    int numUndoLevelsToStore = Edit::getDefaultNumUndoLevels();  // :115  (default 30, :356)
    EditFileRetriever editFileRetriever = {};                    // :117
    FilePathResolver filePathResolver = {};                      // :118
    uint32_t numAudioTracks = 1;                                 // :120  ensures this many audio tracks
    float defaultMasterVolumedB = -3.0f;                         // :122
};
```
**Constructors:** `Edit (Options);` (`:129`), `Edit (Engine&, EditRole);` (`:132`).
**Factory (preferred over direct ctor, catches throws):** `static std::unique_ptr<Edit> Edit::createEdit (Options);` (`:220`). Convenience: `Edit::createSingleTrackEdit (Engine&, EditRole = forEditing)` (`:242`).
`EditRole` enum at `:74` (`forEditing=0`, `forRendering`, `forExporting`, `forExamining`).

**Real call from the repo (`examples/DemoRunner/demos/PlaybackDemo.h:49`):**
```cpp
edit = te::createEmptyEdit (engine, editFile);   // new edit
// ...or load:
edit = te::loadEditFromFile (engine, editFile);  // :35
```

**Mosh usage:** Stage 1 — construct the single `Engine` once, then `te::createEmptyEdit(engine, editFile)` for a fresh edit (or `loadEditFromFile` to reopen). Use `Edit::createEdit(Options{})` only if you need `numAudioTracks`/custom undo levels up front.

---

## 2. Loading / saving an Edit

**Loading:** free function `loadEditFromFile(Engine&, File&, EditRole)` returns `std::unique_ptr<Edit>` (EditFileOperations.h:53). Used in `PlaybackDemo.h:35`.

**Saving:** there is **no `edit.save()`** method. Saving goes through the `EditFileOperations` helper class — `modules/tracktion_engine/model/edit/tracktion_EditFileOperations.h:18`:
```cpp
class EditFileOperations {
    EditFileOperations (Edit&);                                                   // :21
    bool save (bool warnOfFailure, bool forceSaveEvenIfNotModified,
               bool offerToDiscardChanges);                                       // :26
    bool saveAs (const juce::File&, bool forceOverwriteExisting = false);         // :27
    bool writeToFile (const juce::File&, bool writeQuickBinaryVersion);           // :30
    bool saveTempVersion (bool forceSaveEvenIfUnchanged);                         // :32
};
```
**Canonical save call used across the engine** (e.g. `model/export/tracktion_ExportJob.cpp:272`, `utilities/tracktion_AppFunctions.cpp:367`, `plugins/tracktion_Plugins.test.cpp:325`):
```cpp
EditFileOperations (*edit).save (true, true, false);
// (warnOfFailure=true, forceSaveEvenIfNotModified=true, offerToDiscardChanges=false)
```
Note: `EditFileOperations` is constructed as a short-lived stack object wrapping the `Edit&`. It must know the edit file — `createEmptyEdit`/`loadEditFromFile` set the edit's `EditFileRetriever`, so the plain `save(...)` works. Otherwise use `saveAs(file)`.

**Mosh usage:** the MoshOps `save` command does `EditFileOperations (edit).save (false, true, false)` (no UI prompt, always write). For "save as" pass a `File` to `saveAs`.

---

## 3. Tracks

**Insert (member of `Edit`)** — `tracktion_Edit.h:381`:
```cpp
juce::ReferenceCountedObjectPtr<AudioTrack>
Edit::insertNewAudioTrack (TrackInsertPoint, SelectionManager*, bool addDefaultPlugins = true);
```
Related: `insertNewFolderTrack` (:384), `insertNewTrack(TrackInsertPoint, Identifier xmlType, SelectionManager*)` (:390), `ensureNumberOfAudioTracks(int)` (:414).

**`TrackInsertPoint`** — `modules/tracktion_engine/model/tracks/tracktion_TrackUtils.h:18`:
```cpp
struct TrackInsertPoint {
    TrackInsertPoint (Track* parent, Track* preceding);                       // :25
    TrackInsertPoint (EditItemID parentTrackID, EditItemID precedingTrackID); // :32
    TrackInsertPoint (Track& currentPos, bool insertBefore);                  // :37
    TrackInsertPoint (const juce::ValueTree&);                                // :40
    static TrackInsertPoint getEndOfTracks (Edit&);                           // :43
    EditItemID parentTrackID, precedingTrackID;                               // :45
};
```

**Iteration / accessors** — `modules/tracktion_engine/model/edit/tracktion_EditUtilities.h`:
```cpp
juce::Array<Track*>      getAllTracks (const Edit&);        // :49
juce::Array<AudioTrack*> getAudioTracks (const Edit&);      // :59
juce::Array<ClipTrack*>  getClipTracks (const Edit&);       // :62
AudioTrack*              getFirstAudioTrack (const Edit&);  // :80
```

**Real pattern (`examples/common/Utilities.h:144`):**
```cpp
inline te::AudioTrack* getOrInsertAudioTrackAt (te::Edit& edit, int index) {
    edit.ensureNumberOfAudioTracks (index + 1);
    return te::getAudioTracks (edit)[index];
}
```

**Mosh usage:** `create_track` → `edit.insertNewAudioTrack (TrackInsertPoint::getEndOfTracks(edit), nullptr)` (pass `nullptr` SelectionManager — selection is UI-local per Mosh). For "first N tracks exist" use `ensureNumberOfAudioTracks`. Enumerate via `te::getAudioTracks(edit)` for the snapshot.

---

## 4. Clips

Two equivalent surfaces: **members of `ClipTrack`** and **free functions on `ClipOwner`**. Both take strong time types.

**`ClipTrack` members** — `modules/tracktion_engine/model/tracks/tracktion_ClipTrack.h`:
```cpp
WaveAudioClip::Ptr insertWaveClip (const juce::String& name, const juce::File& sourceFile,
                                   ClipPosition position, bool deleteExistingClips);   // :73
WaveAudioClip::Ptr insertWaveClip (const juce::String& name, ProjectItemID sourceID,
                                   ClipPosition position, bool deleteExistingClips);   // :76
MidiClip::Ptr      insertMIDIClip (TimeRange position, SelectionManager*);             // :79
MidiClip::Ptr      insertMIDIClip (const juce::String& name, TimeRange position,
                                   SelectionManager*);                                 // :82
Clip*              insertNewClip  (TrackItem::Type, const juce::String& name,
                                   ClipPosition, SelectionManager*);                   // :71
Clip*              splitClip      (Clip&, TimePosition);                               // :91
```

**`ClipOwner` free functions** — `modules/tracktion_engine/model/clips/tracktion_ClipOwner.h`:
```cpp
WaveAudioClip::Ptr insertWaveClip (ClipOwner&, const juce::String& name, const juce::File& sourceFile,
                                   ClipPosition, DeleteExistingClips);   // :107
WaveAudioClip::Ptr insertWaveClip (ClipOwner&, const juce::String& name, ProjectItemID sourceID,
                                   ClipPosition, DeleteExistingClips);   // :111
MidiClip::Ptr      insertMIDIClip (ClipOwner&, const juce::String& name, TimeRange);  // :115
MidiClip::Ptr      insertMIDIClip (ClipOwner&, TimeRange);                            // :118
Clip*              insertNewClip  (ClipOwner&, TrackItem::Type, const juce::String& name, ClipPosition); // :103
```

**`ClipPosition` struct** — `modules/tracktion_engine/model/tracks/tracktion_EditTime.h:118`:
```cpp
struct ClipPosition {
    TimeRange    time;        // :120
    TimeDuration offset = {}; // :121  offset into source material
    TimePosition getStart() const; TimePosition getEnd() const;  // :131,:133
    TimeDuration getLength() const; TimeDuration getOffset() const;
};
```
`EditTime` (variant of `TimePosition`/`BeatPosition`) at `:35`; `EditTimeRange` (variant of `TimeRange`/`BeatRange`) at `:74`. **Strong time types confirmed — no raw-double clip API on this commit.**

**Real call (`examples/common/Utilities.h:161`):**
```cpp
auto newClip = track->insertWaveClip (file.getFileNameWithoutExtension(), file,
                  { { {}, te::TimeDuration::fromSeconds (audioFile.getLength()) }, {} }, false);
// ClipPosition is brace-initialised: { { startPos, duration }, offset }
```

**Mosh usage:** `import_clip` → `track->insertWaveClip(name, file, { { startPos, TimeDuration::fromSeconds(len) }, {} }, false)`. `move_clip`/`trim_clip` mutate the clip's `ClipPosition`; `split_clip` → `ClipTrack::splitClip(clip, TimePosition)`. MIDI clips via `insertMIDIClip(name, TimeRange, nullptr)`.

---

## 5. Transport & device

**`Edit::getTransport()`** — `tracktion_Edit.h:269`: `TransportControl& getTransport() const noexcept`.

**`TransportControl` API** — `modules/tracktion_engine/playback/tracktion_TransportControl.h`:
```cpp
void play (bool justSendMMCIfEnabled);                            // :72
void playFromStart (bool justSendMMCIfEnabled);                   // :75
void record (bool justSendMMCIfEnabled, bool allowIfNoInputsArmed=false); // :91
void stop  (bool discardRecordings, ...);                         // :98
bool isPlaying() const;   bool isRecording() const;               // :128,:131
TimePosition getPosition() const;                                 // :156
void setPosition (TimePosition);                                  // :159
void setLoopRange (TimeRange);   TimeRange getLoopRange() const;  // :193,:196
// Playback-context (device attach):
EditPlaybackContext* getCurrentPlaybackContext() const;           // :206
bool isPlayContextActive() const;                                 // :209
void ensureContextAllocated (bool alwaysReallocate=false);        // :214
void freePlaybackContext();                                       // :216
```
**Looping & position are `CachedValue<>` public members, assigned directly** (`tracktion_TransportControl.h:383,387`):
```cpp
juce::CachedValue<TimePosition> position;          // :383   transport.position = ...
juce::CachedValue<bool>         looping;           // :387   transport.looping = true;
```
So examples do `transport.looping = true;` and `transport.setLoopRange({...});` (`PlaybackDemo.h:37-39`).

**Device init for a standalone app:** the `DeviceManager` is owned by `Engine` and **auto-initialised during `Engine::initialise()`** — the demos never call `initialise()` themselves; they just construct `Engine`, build an `Edit`, and call `transport.play(false)`. Manual control exists at `modules/tracktion_engine/playback/tracktion_DeviceManager.h:35`:
```cpp
void DeviceManager::initialise (int defaultNumInputChannelsToOpen  = 512,
                                int defaultNumOutputChannelsToOpen = 512);
```
Playback graph attaches to the device when the transport allocates an `EditPlaybackContext` (`transport.ensureContextAllocated()` / first `play()`); detach with `freePlaybackContext()`.

**"Rendering whilst attached to audio device" exclusivity assertion — PRESENT.**
`modules/tracktion_engine/playback/graph/tracktion_NodeRenderContext.cpp:67-71`:
```cpp
if (r.edit->getTransport().isPlayContextActive()) {
    jassertfalse;
    TRACKTION_LOG_ERROR("Rendering whilst attached to audio device");
}
```
You must NOT render an Edit while it is attached to the device. Use `Edit::ScopedRenderStatus` (`tracktion_Edit.h:295`) to temporarily detach (and optionally re-attach on scope exit) around a render.

**Mosh usage:** `set_transport` maps to `play/stop/setPosition/setLoopRange` + `transport.looping`. Telemetry (playhead/meters) reads `transport.getPosition()` decimated 30–60 Hz. For Tier-B/freeze renders, wrap the offline render in `Edit::ScopedRenderStatus` so the device-attach assertion never fires.

---

## 6. Engine bootstrap

**`Engine` constructors** — `modules/tracktion_engine/utilities/tracktion_Engine.h`:
```cpp
Engine (juce::String applicationName);                                                       // :38
Engine (juce::String applicationName, std::unique_ptr<UIBehaviour>, std::unique_ptr<EngineBehaviour>); // :41
Engine (std::unique_ptr<PropertyStorage>, std::unique_ptr<UIBehaviour>, std::unique_ptr<EngineBehaviour>); // :44
```
The 3-arg form (the one Mosh wants) is `Engine(juce::String, unique_ptr<UIBehaviour>, unique_ptr<EngineBehaviour>)`. Header docstring shows the intended use:
```cpp
// tracktion_Engine.h:31
tracktion_engine::Engine engine { ProjectInfo::projectName, std::make_unique<ExtendedUIBehaviour>(), nullptr };
```
Passing `nullptr` for either behaviour uses the engine defaults.

**`UIBehaviour` / `EngineBehaviour`** are policy/customisation objects the engine queries for host-app behaviour. `EngineBehaviour` (`utilities/tracktion_EngineBehaviour.h`) controls engine policy — e.g. `getNumberOfCPUsToUseForAudio()` is read by the render context (`graph/tracktion_NodeRenderContext.cpp:62`). `ExtendedUIBehaviour` is the richer UI policy used by full apps (referenced in the Engine docstring). Accessors: `Engine::getUIBehaviour()` (:62), `getEngineBehaviour()` (:63), `getDeviceManager()` (:64).

**`edit.getUndoManager()` returns `juce::UndoManager&` — CONFIRMED.**
`tracktion_Edit.h:326`: `juce::UndoManager& getUndoManager() noexcept { return undoManager; }`.
`Edit` also exposes `undo()`/`redo()` (:329,:332) and `UndoTransactionInhibitor` (:338) for long ops. Default undo levels = 30 (`getDefaultNumUndoLevels()`, :356).

**Mosh usage:** construct one `Engine("Mosh", std::make_unique<ExtendedUIBehaviour>(), nullptr)` for the process. The Tracktion `UndoManager` returned by `edit.getUndoManager()` is the single undo implementation under MoshOps — wrap each command's mutations in one `UndoManager` transaction; never instantiate a second UndoManager.

---

## 7. CMake target & JUCE

**Target(s) consumers link** (from every example's CMake, e.g. `examples/EngineInPluginDemo/CMakeLists.txt:70`):
```cmake
target_link_libraries(${TARGET_NAME} PRIVATE
    tracktion::tracktion_core
    tracktion::tracktion_engine
    tracktion::tracktion_graph
    juce::juce_audio_devices
    juce::juce_audio_processors
    juce::juce_audio_utils
    juce::juce_recommended_warning_flags)
```
So the engine target is **`tracktion::tracktion_engine`** (always linked alongside `tracktion::tracktion_core` and `tracktion::tracktion_graph`).

**How the targets are produced** — `modules/CMakeLists.txt:24`:
```cmake
juce_add_modules(
    INSTALL_PATH "include/JUCE-${JUCE_VERSION}/modules"
    ALIAS_NAMESPACE tracktion          # -> tracktion::<module>
    tracktion_core tracktion_engine tracktion_graph)
```

**Does tracktion add its own JUCE? — YES, it expects JUCE to be added first; it does NOT auto-find an arbitrary system JUCE.** Top-level `CMakeLists.txt:14-21`:
```cmake
if (JUCE_CPM_DEVELOP)
    include(cmake/CPM.cmake)
    CPMAddPackage("gh:juce-framework/JUCE#develop")   # JUCE develop via CPM
else()
    add_subdirectory(modules/juce)                    # JUCE git submodule
endif()
add_subdirectory(modules)                             # tracktion modules (need JUCE targets)
```
The example CMakes do the same in standalone mode (`EngineInPluginDemo/CMakeLists.txt:12-13`):
```cmake
add_subdirectory(../../modules/juce ./tmp/cmake_build_juce)   # JUCE first
add_subdirectory(../../modules     ./tmp/cmake_build_tracktion)
```
`.gitmodules` pins the JUCE submodule to **branch `develop`** (`modules/juce`), **not** a tagged 8.0.x.

**Mosh usage / IMPORTANT:** `tracktion_engine` v3.2.0 does **not** itself pin JUCE 8.0.8 — it tracks JUCE `develop`. For Mosh, add **JUCE 8.0.8 first** (your own CPM pin / `add_subdirectory`) so the `juce::` targets already exist, then `add_subdirectory(.../tracktion_engine/modules)` and link `tracktion::tracktion_core tracktion::tracktion_engine tracktion::tracktion_graph` + the `juce::` modules above. Do NOT also let tracktion pull `develop` — guard against the submodule/CPM JUCE so there's exactly one JUCE. CMake `cmake_minimum_required(3.15...3.20)`, C++20 (`target_compile_features ... cxx_std_20`).

---

## 8. Rendering (module 05 prep)

**`Renderer::Parameters`** — `modules/tracktion_engine/model/export/tracktion_Renderer.h:36`:
```cpp
struct Parameters {
    Parameters() = delete;
    Parameters (Engine&);   // :42
    Parameters (Edit&);     // :45  sets engine+edit
    Engine* engine = nullptr;                  // :52
    Edit*   edit   = nullptr;                   // :53
    juce::BigInteger     tracksToDo;            // :54  empty = all tracks
    juce::Array<Clip*>   allowedClips;          // :55  empty = all clips
    juce::File           destFile;              // :57
    juce::AudioFormat*   audioFormat = nullptr; // :58
    int    bitDepth = 16; int blockSizeForAudio = 512; double sampleRateForAudio = 44100.0; // :60-62
    TimeRange    time;                          // :64  range to render
    TimeDuration endAllowance;                  // :65  tail for reverb/delay decay
    bool createMidiFile=false, trimSilenceAtEnds=false;          // :69-70
    bool shouldNormalise=false, shouldNormaliseByRMS=false;      // :73-74
    bool canRenderInMono=true, mustRenderInMono=false;          // :76-77
    bool usePlugins=true, useMasterPlugins=false;               // :78-79
    bool realTimeRender=false, ditheringEnabled=false, checkNodesForAudio=true; // :80-82
    int quality=0; juce::StringPairArray metadata;              // :84-85
};
```

**Render-to-file overloads** — same header:
```cpp
static juce::File renderToFile (const juce::String& taskDescription, const Parameters&);   // :186
static bool renderToFile (const juce::String& taskDescription, const juce::File& outputFile,
                          Edit& edit, TimeRange range, const juce::BigInteger& tracksToDo,
                          bool usePlugins=true, bool useACID=true,
                          juce::Array<Clip*> clips={}, bool useThread=true);                // :189
static bool renderToFile (Edit&, const juce::File&, bool useThread=true);                  // :200
static ProjectItem::Ptr renderToProjectItem (const juce::String&, const Parameters&,
                                             ProjectItem::Category);                        // :181
```
Async API: `EditRenderer::render (Renderer::Parameters, finishedCallback, thumbnail)` returns a `Handle` with `cancel()`/`getProgress()` (`:286-324`). Block-by-block task: `Renderer::RenderTask` (`:103`), `runJob()` until `jobHasFinished` (`:126`). Statistics-only pass: `Renderer::measureStatistics(...)` (`:212`).

**Mosh usage:** module 05 freeze/bounce uses `Renderer::Parameters{edit}` with `destFile`, `time`, `tracksToDo` (BigInteger bitset), optional `allowedClips`. Prefer **render-to-file** (`renderToFile`) — there is no render-to-buffer in the public Renderer API; capture audio via a file + manifest (matches Mosh's files+manifests transport). Wrap in `Edit::ScopedRenderStatus` (see §5) to satisfy the device-attach exclusivity assertion. For non-blocking job-service progress use `EditRenderer::render(...)`'s `Handle`.

---

## 9. Takes (module 05 prep)

**Take API on `WaveAudioClip`** — `modules/tracktion_engine/model/clips/tracktion_WaveAudioClip.h`:
```cpp
void addTake (ProjectItemID);          // :31  add take from a project source
void addTake (const juce::File&);      // :34  add take from a file
WaveCompManager& getCompManager();     // :47
// overrides:
bool hasAnyTakes() const;              // :94
int  getNumTakes (bool includeComps);  // :96
juce::Array<ProjectItemID> getTakes(); // :98
int  getCurrentTake() const;           // :102
void setCurrentTake (int takeIndex);   // :104
bool isCurrentTakeComp();              // :106
Clip::Array unpackTakes (bool toNewTracks); // :108  promote takes to clips/tracks
```

**`CompManager` / `WaveCompManager`** — `modules/tracktion_engine/model/clips/tracktion_CompManager.h`:
```cpp
class CompManager { ...
    void          setActiveTakeIndex (int index);   // :84  also updates source
    int           getActiveTakeIndex() const;       // :87  == clip.getCurrentTake()
    juce::ValueTree getActiveTakeTree() const;       // :90
    int           getNumTakes() const;              // :93
    int           getTotalNumTakes() const;         // :99
    virtual juce::ValueTree addNewComp() = 0;        // :117  new take w/ new ProjectItemID + blank section
    juce::ValueTree addSection (int takeIndex, double endTime); // :170
    HashCode      getTakeHash (int takeIndex) const; // :136
};
class WaveCompManager : public CompManager { juce::ValueTree addNewComp() override; /* :274 */ };
```

**Feasibility assessment:** Take injection IS feasible and first-class for `WaveAudioClip`:
- Add an alternate take by file: `clip.addTake(File)` (or `addTake(ProjectItemID)`), then `clip.setCurrentTake(idx)` to audition/promote it as the active source. `getNumTakes`/`getTakes`/`getCurrentTake` give the snapshot.
- Comp/section editing goes through `getCompManager()` (`WaveCompManager`), incl. `addNewComp()` and per-section APIs (those section methods use raw-`double` times — internal comping only).
- To split takes back out into independent clips/tracks, `unpackTakes(toNewTracks)` returns a `Clip::Array`.

**Mosh usage:** Tier-B audition/accept maps naturally to takes — render the generative result to a file, `clip.addTake(renderedFile)`, audition via `setCurrentTake`, "accept" = keep that take / `unpackTakes` if you want it as its own clip; "reject" = `setCurrentTake(original)`. The **"new clip on a new track" fallback** (`unpackTakes(true)` or a fresh `insertWaveClip` on a new `insertNewAudioTrack`) remains the more robust path for A/B against source and for non-Wave sources, since the take API is Wave-clip-specific. Recommend: use takes for same-track auditioning, fall back to new-clip/new-track for cross-source A/B and freeze/bounce commits.

---

## Resolution status

| # | Item | Status |
|---|------|--------|
| 1 | Edit creation (`createEmptyEdit`, `Edit::Options`, ctor) | Resolved |
| 2 | Load/save (`loadEditFromFile`, `EditFileOperations::save`) | Resolved |
| 3 | Tracks (`insertNewAudioTrack`, `TrackInsertPoint`, `getAudioTracks`) | Resolved |
| 4 | Clips (`insertWaveClip`/`insertMIDIClip`, `ClipPosition`, strong types) | Resolved |
| 5 | Transport/device + render-exclusivity assertion | Resolved |
| 6 | Engine ctor, behaviours, `getUndoManager() -> juce::UndoManager&` | Resolved |
| 7 | CMake target `tracktion::tracktion_engine`; JUCE added first (submodule=develop) | Resolved |
| 8 | `Renderer::Parameters` + `renderToFile` overloads | Resolved |
| 9 | Takes / `WaveCompManager` (`addTake`/`setCurrentTake`/`unpackTakes`) | Resolved |

No items UNRESOLVED.
