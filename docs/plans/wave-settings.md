# Wave: Project & engine settings + device picker + import

Concrete, ready-to-implement plan. Adds: audio device selection (type / output / input / sample-rate / buffer-size), the **audio-engine "must" gate** (`audioEnabled` in the snapshot, MON-007 / FLY-004), new / open / save-as project, and a **native file-import picker** wired through `import_clip`.

Scope rule (one mutation path): every session/state change is a MoshOps command following `validate → undoManager().beginNewTransaction("name") → mutate → logLine → emitSnapshotInvalidated → okResult`. **Two exceptions are deliberately NOT undoable** and are flagged in `logLine(..., undoable=false)`: device/buffer changes (a machine preference, like `set_metronome`) and project lifecycle (new/open/save-as — they replace or persist the whole Edit, so there is nothing to put on the Edit's own undo stack). The file dialog itself is pure native I/O (returns paths) and is a **native bridge function, not a command** — it then calls `import_clip` per file so the actual import stays on the command spine.

---

## 1. Exact engine APIs (verified against the pinned clone `2877b621`)

All paths under `.cpm-cache/_fc/tracktion_engine-src/modules`.

### Reaching the device layer
- `te::Engine::getDeviceManager() const` → `te::DeviceManager&`
  (`tracktion_engine/utilities/tracktion_Engine.h:64`).
- `te::DeviceManager` (`tracktion_engine/playback/tracktion_DeviceManager.h`) holds a **public** member
  `TracktionEngineAudioDeviceManager deviceManager { engine };` (line 211) — a subclass of
  `juce::AudioDeviceManager`. This is the object `MoshEngine::applyRequestedAudioOutputDevice()`
  already drives, so we generalize that proven code into commands.

### te::DeviceManager queries (units verified)
- `double getSampleRate() const` (`:53`) — Hz.
- `int getBitDepth() const` (`:54`).
- `int getBlockSize() const` (`:55`) — buffer size in **samples**.
- `double getOutputLatencySeconds() const` (`:58`) — seconds.
- `void rescanWaveDeviceList()` (`:47`) — **must** call after a successful `setAudioDeviceSetup` so Tracktion rebuilds its `WaveInputDevice`/`WaveOutputDevice` wrappers (already done at `MoshEngine.cpp:184`).
- `int getNumWaveOutDevices()` / `WaveOutputDevice* getWaveOutDevice(int)` (`:118-119`) — Tracktion's own device wrappers (not needed for the picker; the JUCE layer below is the source of truth for selection).

### juce::AudioDeviceManager (`juce_audio_devices/audio_io/juce_AudioDeviceManager.h`)
- `const OwnedArray<AudioIODeviceType>& getAvailableDeviceTypes()` (`:402`) — on macOS this is `CoreAudio` (+ possibly an aggregate). Each must be `scanForDevices()`'d before name queries.
- `AudioDeviceSetup getAudioDeviceSetup() const` (`:219`).
- `String setAudioDeviceSetup(const AudioDeviceSetup& newSetup, bool treatAsChosenDevice)` (`:251`) — **returns an error String; empty == success.** Pass `treatAsChosenDevice=true`.
- `AudioIODevice* getCurrentAudioDevice() const noexcept` (`:255`).
- `String getCurrentAudioDeviceType() const` (`:260`).
- `AudioIODeviceType* getCurrentDeviceTypeObject() const` (`:266`).
- `void setCurrentAudioDeviceType(const String& type, bool treatAsChosenDevice)` (`:275`).

### AudioDeviceSetup struct (`:102-157`) — fields + units
```
String     outputDeviceName;              // must be a name from the current type's getDeviceNames(false)
String     inputDeviceName;               // "" == none
double     sampleRate = 0;                // Hz; 0 == "device picks a sensible rate"
int        bufferSize = 0;                // samples; 0 == device default
BigInteger inputChannels;  bool useDefaultInputChannels  = true;
BigInteger outputChannels; bool useDefaultOutputChannels = true;
```
Gotcha: set `useDefaultInputChannels = (inputDeviceName.isNotEmpty())` and clear `inputChannels` when there is no input — copied from the existing working code (`MoshEngine.cpp:172-175`).

### juce::AudioIODeviceType (`.../audio_io/juce_AudioIODeviceType.h`)
- `const String& getTypeName() const noexcept` (`:81`) — e.g. `"CoreAudio"`.
- `virtual void scanForDevices() = 0` (`:89`) — **must** run before `getDeviceNames`.
- `virtual StringArray getDeviceNames(bool wantInputNames = false) const = 0` (`:98`) — `false` → outputs, `true` → inputs.
- `virtual int getDefaultDeviceIndex(bool forInput) const = 0` (`:107`).

### juce::AudioIODevice (`.../audio_io/juce_AudioIODevice.h`) — for valid-options lists
Only valid when a device is open (`getCurrentAudioDevice() != nullptr`):
- `virtual Array<double> getAvailableSampleRates() = 0` (`:208`) — Hz list to populate the picker.
- `virtual Array<int> getAvailableBufferSizes() = 0` (`:213`) — sample list.
- `virtual int getDefaultBufferSize() = 0` (`:219`).
- `virtual double getCurrentSampleRate() = 0` (`:288`), `virtual int getCurrentBufferSizeSamples() = 0` (`:282`).
- `const String& getName() const noexcept` (`:170`).

### Project lifecycle (`tracktion_engine/model/edit/tracktion_EditFileOperations.h`)
- `std::unique_ptr<Edit> createEmptyEdit(Engine&, const juce::File&)` (`:61`).
- `std::unique_ptr<Edit> loadEditFromFile(Engine&, const juce::File&, Edit::EditRole = forEditing)` (`:53`).
- `EditFileOperations(Edit&)` then:
  - `bool save(bool warnOfFailure, bool forceSaveEvenIfNotModified, bool offerToDiscardChanges)` (`:26`) — already used by `MoshEngine::save()`.
  - `bool saveAs(const juce::File&, bool forceOverwriteExisting = false)` (`:27`) — **the save-as path.** Returns success bool. NOTE: this changes the Edit's backing file; we must re-point `MoshEngine::editPath` and `editFileRetriever` to the new file afterwards.
- `MoshEngine` already mirrors the load/create flow in its ctor (`MoshEngine.cpp:50-72`) and reload (`:231-238`) — new_project/open_project replicate that, swapping `editPtr`.

### Import (already shipped, reused unchanged)
- `te::AudioFile(edit.engine, file)` + `track->insertWaveClip(name, file, ClipPosition, bool)` — `MoshOps::cmdImportClip` (`MoshOps.cpp:218-262`). The picker feeds file paths into this.

### Native file dialog (`juce_gui_basics/filebrowser/juce_FileChooser.h`)
- `FileChooser(const String& title, const File& startingDir = {}, const String& filters = {}, ...)` (`:124`).
- `void launchAsync(int flags, std::function<void(const FileChooser&)>, ...)` (`:216`) — **async, message-thread only.** Use this (NOT the blocking `browseFor…`) because it must not block the WebView/native-function completion.
- Flags from `juce::FileBrowserComponent::FileChooserFlags`: `openMode | canSelectFiles | canSelectMultipleItems`.
- Results: `Array<File> getResults() const` (`:250`) for multi-select; `File getResult() const` (`:237`) for save dialogs.
- Filter string for audio: `"*.wav;*.aif;*.aiff;*.flac;*.mp3;*.ogg"`.

---

## 2. MoshOps commands to add

Declarations in `MoshOps.h` (new `cmdX` decls), dispatched in `execute()` (`MoshOps.cpp:101`), bodies near the helpers. All read `args` via `getProperty`, validate, then follow the standard pipeline. A small device handle helper:
```cpp
juce::AudioDeviceManager& adm() { return eng.engine().getDeviceManager().deviceManager; }
```

### `list_audio_devices`  (read-only; no undo/log)
Behaviour: enumerate types + their output/input device names + the current selection + valid sample rates / buffer sizes for the open device. Returns:
```
{ types:[{name, outputs:[str], inputs:[str]}],
  current:{ type, outputDevice, inputDevice, sampleRate, bufferSize, bitDepth, outputLatencyMs },
  sampleRates:[number], bufferSizes:[number], defaultBufferSize:number,
  audioEnabled:bool }
```
Impl: loop `adm().getAvailableDeviceTypes()`, `scanForDevices()`, `getDeviceNames(false/true)`. Read `adm().getAudioDeviceSetup()`; if `adm().getCurrentAudioDevice()` non-null, pull `getAvailableSampleRates()/getAvailableBufferSizes()/getDefaultBufferSize()`. `audioEnabled = eng.hasAudio()`. (Headless: `types` may be empty / `audioEnabled=false` — see §5.)

### `set_audio_device`  (not undoable — machine preference, like set_metronome)
Args: `{ type?:str, outputDevice?:str, inputDevice?:str, sampleRate?:number, bufferSize?:int }` (all optional; absent → unchanged).
Behaviour:
1. Guard `if (!eng.hasAudio()) return errResult(...,"no audio device in this session")`.
2. If `type` given and differs → `adm().setCurrentAudioDeviceType(type, true)`.
3. `auto setup = adm().getAudioDeviceSetup();` apply provided fields. For inputs follow the existing rule (`useDefaultInputChannels`, clear `inputChannels`).
4. `auto err = adm().setAudioDeviceSetup(setup, true);` — **non-empty err → errResult(err)** (don't emit success).
5. On success: `eng.engine().getDeviceManager().rescanWaveDeviceList();` then `runDispatchLoopUntil(50)` (mirrors `MoshEngine.cpp:184-186`).
6. `logLine("set_audio_device", args, ok, err, /*undoable*/false)`; `emitSnapshotInvalidated()`; return the new `current{}` block.

### `set_buffer_size`  (not undoable)
Args: `{ bufferSize:int }`. Convenience wrapper = `set_audio_device` with only `bufferSize`. Validate `bufferSize` is one of `getAvailableBufferSizes()` when a device is open; else accept and let the device round. Same rescan + log(undoable=false) + snapshot.
(Could be folded into `set_audio_device`; keep a thin separate command because the prompt names it and it maps 1:1 to a UI control.)

### `new_project`  (not undoable — replaces the Edit)
Args: `{ name?:str }`. Behaviour: save current Edit, then create a fresh empty Edit at a new file under the session dir (`projects/<name|"untitled-<ms>">.tracktionedit`), strip the default audio track (mirror `MoshEngine.cpp:60-71`), swap `editPtr`, re-point `editFileRetriever`. Returns `{ editFile }`. **Add `MoshEngine::newProject(File)` / `openProject(File)` / `saveProjectAs(File)`** so the swap logic lives in the engine, not MoshOps (matches the existing `reloadFromFile()` placement).

### `open_project`  (not undoable)
Args: `{ file:str }` (path supplied by the native picker; see §4). Validate `file.existsAsFile()`. `eng.openProject(file)` = save-current → `loadEditFromFile` → swap → re-point retriever. `emitSnapshotInvalidated`. Returns `{ editFile }`.

### `save_as`  (not undoable)
Args: `{ file:str }`. `EditFileOperations(eng.edit()).saveAs(File(file), true)`; on success re-point `MoshEngine::editPath`/`editFileRetriever` to the new file (add `MoshEngine::adoptEditFile(File)`). Returns `{ file, ok }`.

### Import: keep `import_clip` as-is.
No new command. The picker (a native fn) calls the already-bound `commandHandler` with `{command:"import_clip", args:{file, trackId?}}` once per chosen file, so each import is a normal logged/undoable command. (Optional nicety: add `import_clips` plural that loops — but the per-file path already gives correct undo granularity, so prefer the loop in the bridge.)

---

## 3. Snapshot additions

All in **`snapshot()`** (`MoshOps.cpp:1605`), inside the existing `session` `DynamicObject` (no new top-level keys except an optional `audio` block). Builders `trackToVar` / `clipToVar` / `transportToVar` are unchanged.

Add to `session`:
- `audioEnabled : bool` = `eng.hasAudio()`. **This is the gate field** (MON-007 / FLY-004) the UI reads to disable play/record/export and show a "No audio device" banner.
- `bitDepth : number` = `eng.engine().getDeviceManager().getBitDepth()`.
- `bufferSize : number` = `getBlockSize()` (samples).
- `outputLatencyMs : number` = `getOutputLatencySeconds() * 1000.0`.
- `audioDeviceName : string` = current output device name (`getCurrentAudioDevice() ? getName() : ""`).
- `audioDeviceError : string` = `eng.audioDeviceError()` (already exists on MoshEngine; surfaces a failed requested-device).

Add a top-level optional `audio` object ONLY the lightweight current-selection summary (full device lists stay behind the on-demand `list_audio_devices` so the 30 Hz-adjacent snapshot stays small):
```
audio?: { type:string, outputDevice:string, inputDevice:string, sampleRate:number, bufferSize:number }
```
`sampleRate` already lives in `session.sampleRate` (`:1610`) — keep it; the `audio` block duplicates it intentionally for the settings panel's edit form.

TS types: extend `Snapshot.session` in `ui/src/types.ts:122` with the new optional fields and add the optional `audio` block + an `AudioDevices` type for the `list_audio_devices` payload.

---

## 4. UI plan (keep current visual style)

Style tokens + `.tool-btn` / `.topbar` / popover patterns already exist (`RemoteCompanion` in `App.tsx`, `styles.css`). Reuse them — no new visual language.

**New component `ui/src/components/Settings.tsx`** (a topbar popover, modeled exactly on `RemoteCompanion`):
- Trigger: a gear `tool-btn` ("⚙") added in `App.tsx` `topbar-right` next to Export/theme (`App.tsx:51-61`).
- Opens a `.remote-pop`-style panel with:
  - **Audio device**: `<select>` device-type, `<select>` output device, `<select>` input device, `<select>` sample-rate, `<select>` buffer-size. Options come from a `list_audio_devices` call on open (lazy, like `openBrowser` in `store.ts:197`). Each change → `exec("set_audio_device", {...})`.
  - **Engine readout** (read-only): bit depth, output latency ms, current device — from `snapshot.session`.
  - **Audio gate banner**: when `!session.audioEnabled`, a `.error-bar`-styled note "No audio device — playback/record/export disabled" plus a "Re-scan / enable" action.
- **Project menu** (same panel or a sibling "File" popover): buttons New / Open… / Save / Save As…. Open… and Save As… call the new native picker (below); New → `exec("new_project")`; Save → `exec("save")`.

**Gate wiring** (MON-007 / FLY-004): in `Transport.tsx` disable Play/Record when `!snapshot.session.audioEnabled` (read it via `useStore`); in `App.tsx` disable the Export `tool-btn` likewise and show the banner. This is pure view logic — no command.

**Store additions** (`store.ts`): `audioDevices: AudioDevices | null`, `loadAudioDevices()` (lazy, mirrors `loadColors`), and the device lists feed the selects. No new bridge plumbing for these (they ride `executeCommand`).

**File picker bridge** — add to `ui/src/bridge.ts` + `WebBridge`:
- `WebBridge`: new `withNativeFunction("pick_files", …)` and `withNativeFunction("pick_save_file", …)` (alongside `ping`/`remote_*` in `WebBridge.cpp:120`). Each builds a `FileChooser`, calls `launchAsync(flags, cb)`, and in the callback resolves the `NativeFunctionCompletion` with `{ ok, files:[paths] }` (or `{ok,file}` for save). Keep the `FileChooser` alive via a member `std::unique_ptr<juce::FileChooser>` on `WebBridge`.
- `bridge.ts`: `pickFiles(): Promise<{ok:boolean; files:string[]}>` and `pickSaveFile(): Promise<{ok:boolean; file:string}>`, guarded by `isNative()`.
- Import button (in `Settings.tsx` File menu **and** a small "+ Import" `tool-btn` near the track header / arrangement toolbar): `const r = await pickFiles(); for (const f of r.files) await exec("import_clip", { file:f, trackId: selectedTrackId ?? undefined });` then `refresh()`.
- Open…: `pickFiles` (single) → `exec("open_project", {file})`. Save As…: `pickSaveFile` → `exec("save_as", {file})`.

Rationale for native-fn (not command) for the dialog: `execute_command` returns a synchronous `var`; `FileChooser` is async on the message thread. A dedicated native fn returns a Promise cleanly (same pattern as `remote_start_pairing`). The **mutation** still happens via `import_clip`/`open_project`/`save_as` commands — the seam is preserved.

---

## 5. Self-test checks (headless, `eng.hasAudio()==false`)

Add to `SelfTest.cpp` (pattern: `cmd(ops,name,args)` + `check(cond,what)`). The harness runs with **no audio device**, so anything touching a live `AudioIODevice` is null — be explicit:

**Verifiable headless:**
- `snapshot().session.audioEnabled == false` (the gate reports honestly with no device).
- `list_audio_devices` returns `ok` and an `audioEnabled:false` payload; `types` array exists (may be empty — `addSystemAudioIODeviceTypes()` returns false headless, `MoshEngine.cpp:18`, so assert **shape**, not non-empty content).
- `set_audio_device` with no device → returns `errResult` ("no audio device in this session"); **does not crash**, logs `undoable:false`.
- `set_buffer_size` headless → same graceful error.
- `new_project` → `ok`; snapshot `tracks==0`; `session.editFile` path changed; a fresh `.tracktionedit` exists. Then `create_track` + `save` + `open_project(thatFile)` round-trips the track count.
- `save_as(tmpFile)` → `ok`; file exists on disk and is non-empty; subsequent `save` writes to the new path (`session.editFile` updated).
- Import still works headless (test tone WAV path): existing `import_clip`/`add_test_tone_clip` checks already prove the import command the picker drives. Add: `import_clip` with a generated WAV path lands a clip (no picker needed in the test — the picker is the only non-headless part).
- JSONL: `set_audio_device`, `new_project`, `save_as` appear in the log with `undoable:false`.
- Undo isolation: after `set_audio_device`/`new_project`, `undo` does **not** revert them (they're not on the Edit undo stack) — assert undo affects only the preceding undoable command.

**Needs live audio / hardware (cannot be asserted headless — note in test output, like the existing `MoshEngine.cpp` no-audio skips):**
- Actual device enumeration content (CoreAudio names), real sample-rate / buffer-size lists from an open `AudioIODevice`.
- A successful `set_audio_device` / `set_buffer_size` round-trip changing `getCurrentBufferSizeSamples()`.
- The native `FileChooser` dialog (modal, requires a window + user) — not scriptable headless and blocked by macOS Accessibility in synthetic-click runs (same constraint noted for drag in Stage 2). Verify via the GUI manually.
- Output latency / bit depth being non-zero.

---

## 6. Risks / gotchas
- **`setAudioDeviceSetup` returns an error String, not a bool** — empty == success. Easy to invert; the existing code at `MoshEngine.cpp:177` is the correct reference.
- **Must `rescanWaveDeviceList()` after a device change** or Tracktion's playback graph keeps stale wave devices (already handled in `applyRequestedAudioOutputDevice`). Follow with a short `runDispatchLoopUntil` so the async device update flushes before the next snapshot.
- **Available sample-rates/buffer-sizes are only valid when a device is open** (`getCurrentAudioDevice() != nullptr`). Null-guard; return empty arrays headless.
- **Project swap invalidates pointers**: after `new_project`/`open_project`/`save_as`, any cached `te::Edit&`/track/clip pointers are dead. The UI already refetches the snapshot on `snapshot_invalidated`, but ensure `editFileRetriever` and `MoshEngine::editPath` are re-pointed (the existing `reloadFromFile` shows the pattern; `editPath` is currently fixed and must become mutable). Also stop the transport + `freePlaybackContext()` before swapping the Edit (see export's render-exclusivity dance, `MoshOps.cpp:1464-1465`) to avoid device/Edit-mismatch asserts.
- **`itemID` asserts**: not directly touched here, but new tracks created in a swapped Edit must go through the existing `createAudioTrack` helper (which drains the AsyncUpdater headless, `MoshOps.cpp:1543-1545`).
- **FileChooser lifetime**: `launchAsync`'s callback must outlive the dialog — hold the `FileChooser` in a `WebBridge` member, not a local. Resolve the `NativeFunctionCompletion` exactly once inside the callback (including the cancel path → `{ok:false, files:[]}`).
- **macOS file/mic permission**: opening an *input* device may trigger a mic-permission prompt; default `inputDeviceName=""` (output-only) unless the user explicitly picks an input — matches the headless mic-avoidance posture (`MoshEngine.cpp:17-18`).
- **Not undoable by design**: device/buffer/project commands set `undoable=false`. If they were pushed as undo transactions, an undo could desync the live device or orphan a file. Keep them off the Edit undo stack (consistent with `set_metronome`, `save`, `reload`).
- **Snapshot size**: do NOT put full device lists in `snapshot()` (it's refetched on every `snapshot_invalidated`); keep them behind on-demand `list_audio_devices`. Only the small `audio{}` summary + gate fields go in the snapshot.
- **`save_as` overwrite**: pass `forceOverwriteExisting=true` only after the native save dialog has already confirmed overwrite (the dialog flag handles the prompt); otherwise `saveAs` may silently fail on an existing file.

---

## 7. Recommended implementation order (smallest verifiable slice first)

1. **Snapshot gate first** (pure, fully headless-verifiable): add `audioEnabled` + `bitDepth`/`bufferSize`/`outputLatencyMs`/`audioDeviceName`/`audioDeviceError` to `session` in `snapshot()`. Self-test: `audioEnabled==false`. UI: disable Play/Record/Export + banner. → ships the MON-007/FLY-004 gate alone.
2. **`list_audio_devices`** (read-only command). Self-test: shape + `audioEnabled:false`. No mutation risk.
3. **`set_audio_device` + `set_buffer_size`** (generalize `applyRequestedAudioOutputDevice` into the command). Self-test: graceful no-device error + `undoable:false` logging. Live verify on GUI.
4. **Project lifecycle** — add `MoshEngine::newProject/openProject/saveProjectAs/adoptEditFile`, then `new_project`/`save_as`/`open_project` commands. Self-test: create→save_as→open round-trip of track count; `editFile` path changes; undo isolation.
5. **Settings/File UI** (`Settings.tsx` popover + store `loadAudioDevices`), wired to 2–4. Visual parity with `RemoteCompanion`.
6. **Native file picker** (`WebBridge` `pick_files`/`pick_save_file` + `bridge.ts` wrappers + Import button). Last because it's the only non-headless piece; verify the dialog manually in the GUI. Import itself already proven via `import_clip` self-test.
