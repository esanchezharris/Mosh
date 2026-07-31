# 01 — Engine Store & the Source-Graph / RenderLayer Model

> **Status:** Design spec — source of truth for *how* this subsystem was built (v0, gate PASSED). New to the repo? Start with [ARCHITECTURE.md](ARCHITECTURE.md); build status is in [CLAUDE.md](CLAUDE.md).

*Scope: bring up Tracktion Engine; create/load Edits; treat the engine's ValueTree + UndoManager as the **store and undo implementation** (mutation flows through MoshOps, `02`); wire transport and device; define the non-destructive source-graph / RenderLayer model.*

**Depends on:** `06` (build/deps). **Consumed by:** `02` (commands wrap these calls), all others.
**Effort:** mostly engine-API wiring; the original design here is the **RenderLayer** model (§4).
**Primary references:** Tracktion Engine Doxygen (`https://tracktion.github.io/tracktion_engine/`), repo `examples/` (`PlaybackDemo`, `examples/common/`), `FEATURES.md`. Signatures reflect master ~mid-2025 — **pin a commit**; confirm `// VERIFY` items against the clone.

> **Authority note:** this module sets up the *store*. It does **not** expose mutation to the UI. Every state change is performed by a MoshOps command handler (`02`) that calls the engine APIs below inside a Tracktion undo transaction. Nothing outside `src/moshops/` (and these low-level handlers) writes the tree directly.

---

## 1. Engine bootstrap

One `tracktion::engine::Engine` for the app lifetime.

```cpp
namespace te = tracktion::engine;
Engine = std::make_unique<te::Engine> ("Mosh",
            std::make_unique<te::ExtendedUIBehaviour>(),     // standalone-app UI behaviour
            std::make_unique<MoshEngineBehaviour>());        // override device/scan/CPU hooks as needed
```

The `Engine` owns the global managers: `getDeviceManager()`, `getPluginManager()` (`04`), `getProjectManager()`, `getAudioFileManager()`, `getAudioFileFormatManager()`, `getRenderManager()` (`05`), `getBackgroundJobManager()`, `getTemporaryFileManager()` (`05`). Device manager auto-inits for a standalone app (§5).

---

## 2. The object model

`Engine` → `Edit` → `Track[]` → `Clip[]` and per-track `pluginList`.

- **Track** subclasses: `AudioTrack` (workhorse — clips, `pluginList`, record, freeze), `FolderTrack`, `TempoTrack`, `MarkerTrack`, `ChordTrack`, `ArrangerTrack`, `AutomationTrack`, `MasterTrack`.
- **Clip** subclasses: `WaveAudioClip` (audio; supports takes — `05`), `MidiClip`, `EditClip`, `StepClip`, `MarkerClip`. Clips live in an `AudioTrack`/`ClipTrack` (the `ClipOwner` interface).

### 2.1 Create an Edit

```cpp
auto edit = std::make_unique<te::Edit> (*engine, te::createEmptyEdit (*engine),
                                        te::Edit::EditRole::forEditing, nullptr, 0);
// VERIFY exact ctor/helper on your commit (createEmptyEdit / Edit::Options / loadEditFromFile).
```

`Edit::Options` carries `juce::ValueTree editState`, `ProjectItemID editProjectItemID`, `EditRole role`, `int numUndoLevelsToStore`.

### 2.2 Add a track / clip (called by MoshOps handlers)

```cpp
auto track = edit->insertNewAudioTrack (te::TrackInsertPoint (nullptr, nullptr), nullptr);
te::AudioFile af (edit->engine, wavFile);
auto clip = track->insertWaveClip (wavFile.getFileNameWithoutExtension(), wavFile,
              {{ te::TimePosition::fromSeconds(0.0), te::TimePosition::fromSeconds(af.getLength()) },
               te::TimePosition::fromSeconds(0.0) }, false);
```

MIDI: `insertMIDIClip(name, TimeRange, SelectionManager*)`. `ClipOwner` also: `insertNewClip`, `insertClipWithState`, `splitClip`, `removeRegion`.

> **Pitfall:** garbled/silent clips from `insertWaveClip` usually mean a wrong `ClipPosition`/offset or the source `AudioFile` went out of scope. Use strong time types (`TimePosition`/`TimeRange`/`EditTime`) on recent commits — no raw doubles.

---

## 3. The store: ValueTree + UndoManager (used *through* MoshOps)

`Edit::state` is a `juce::ValueTree`; the Edit owns `edit.getUndoManager()`. The object model is a typed wrapper over that tree via the `ValueTreeObjectList<T>` pattern (`TrackList`, `PluginList`, `MidiList`, `ModifierList`, `ClipEffects` derive from it): **the tree is authoritative; C++ objects are rebuilt from it.**

Rules (enforced by routing all mutation through `02`):
- MoshOps command handlers wrap each user action in `edit.getUndoManager().beginNewTransaction("<command>")` so one command = one undo step.
- `CachedValue<…>` writes bind `&edit.getUndoManager()`.
- Some internal structural writes are deliberately non-undoable (engine passes `nullptr`, e.g. `tempoSequence.setState(...)`) — preserve that intent.
- UI never calls these directly; it observes via the snapshot/events feed (`02 §4`), which the engine's `ValueTree::Listener`s feed.

For reference, in-tree representations: tempo `TEMPOSEQUENCE`, pitch `PITCHSEQUENCE`; plugins `PLUGIN` children of a track's `pluginList` (`04`); automation `AUTOMATIONTRACK` → `AUTOMATIONCURVE` → `POINT` (`t`/`v`); transport's own `state` tree (`position`, `loopPoint1/2`, `looping`).

---

## 4. The source-graph / RenderLayer model (original design)

Realizes the non-destructive principle (`00 §0`) on top of the Edit tree, inheriting undo/serialization/observation for free.

### 4.1 Principle

- **Tier A (real-time)** needs no extra schema: it's a `Plugin` in `pluginList`, reversible by nature, knobs stored as the plugin's own param/`CachedValue` state.
- **Tier B (generative)** needs a schema: the rendered audio is a **cache** and the *params* are the durable, reversible layer. Store params in state; store audio as a take; invalidate by fingerprint.

### 4.2 The `RenderLayer` (stored as a `MOSH_RENDERLAYER` sub-tree)

Attach per generative transform, parented under the clip (travels with the source) or track. Fields (all `CachedValue`, bound to `&edit.getUndoManager()`):

```
MOSH_RENDERLAYER
    id
    inputRef            // EditItemID of the source clip/region
    timeRange           // the rendered region
    modelAdapter        // e.g. "stable_audio_3"   (model-neutral; 05)
    modelVersion
    adapterVersion
    mode                // "generate" | "reimagine" | "inpaint" | "continue"  (route — part of the cache key)
    modelVariant        // model size / decoder variant, e.g. "sa3-medium" vs "sa3-small" (part of the cache key)
    params              // prompt, colors[], cfg, steps, nl  (see 05 §5–§6)
    seed
    safetyMappingVersion
    sourceFingerprint   // see §4.3 — the full cache key inputs
    cacheKey            // hash(sourceFingerprint)
    cacheArtifact       // path/ref to the rendered WAV (a take id, or file)
    status              // "empty" | "queued" | "rendering" | "ready" | "error" | "dirty"
    createdBy           // "user" | "moshi"; legacy "monster" values remain readable
    userKept            // false until accepted/committed
```

### 4.3 The full cache fingerprint (do not shortcut to source+params)

`cacheKey = hash(` upstream audio/MIDI/plugin-state hash · clip range · tempo/key context · sample-rate/channel layout · `modelAdapter` · `modelVersion` · `adapterVersion` · **`modelVariant` (size/decoder)** · **`mode` (the transform route: generate / reimagine / inpaint / continue)** · prompt/semantic controls · seed · sampling hyperparameters · `safetyMappingVersion` · service build/version `)`. Anything less and you get "why did the cache reuse the wrong audio?" bugs — note especially that the **same clip can be transformed by different routes (text-only vs audio-to-audio vs inpaint) and by different model sizes/decoders**, so route and variant *must* be in the key. On any fingerprint-input change, set `status="dirty"`; the render flow (`05 §3`) reuses `cacheArtifact` only when clean.

### 4.4 Composition cap (enforced here)

SA3 supports ≤3 simultaneous colors, asymmetric and layer-ordered (earlier dominates later — SA3 research §6). Cap `params.colors` at 3, keep order, surface in UI (`03`). A measured product limit, not temporary.

---

## 5. Transport & device

```cpp
auto& transport = edit->getTransport();          // play/stop/record, setLoopRange, looping, position
edit->getCurrentPlaybackContext();               // EditPlaybackContext (non-null when attached)
engine->getDeviceManager();                      // wraps a juce::AudioDeviceManager (.deviceManager)
```

Transport actions are invoked via MoshOps `set_transport` (`02`); the audio-settings UI binds `juce::AudioDeviceSelectorComponent` to `engine->getDeviceManager().deviceManager` (surfaced in the WebView as native, or a native settings window).

> **Render/playback exclusivity (matters for `05`):** offline rendering asserts if the Edit is attached to the audio device ("Rendering whilst attached to audio device"). The generative render flow renders on a **detached** Edit (or detaches the playback context) — design the transport/device lifecycle around this.

---

## 6. Persistence

Tracktion serializes the Edit tree to `.tracktionedit` (XML). Save/load via the project manager / `Edit::loadEditFromFile` + a save helper (`// VERIFY` `EditFileOperations` vs `edit.save()`). `MOSH_RENDERLAYER` is plain ValueTree data and serializes automatically. Generative takes: audition renders → `TemporaryFileManager`; accepted renders → copied to the project audio dir and referenced by the take.

---

## 7. Verification gate (Stage 1 portion)

Through MoshOps (`02`): `create_track` + `import_clip` produce a `WaveAudioClip` on an `AudioTrack`; it loops; playhead scrubs; undo/redo via MoshOps works; save/reload restores the clip; a test `MOSH_RENDERLAYER` node round-trips save/load.

## 8. Honest gaps / `// VERIFY`

- Recent-commit signatures: `createEmptyEdit` / `Edit` ctor / `insertNewAudioTrack` (strong-time-type migration).
- The Edit save call (`EditFileOperations` vs `edit.save()`).
- `MOSH_RENDERLAYER` parent (clip vs track) — start under the clip; revisit for track-wide transforms.
