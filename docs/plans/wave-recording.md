# Wave 7 (Recording) — Arm / Input Monitor / Capture

**Goal:** make tracks record live audio input. Add MoshOps commands `arm_track` and `set_input_monitor`, surface per-track `armed`/`monitor` flags in the snapshot, add arm + monitor buttons in the track header, and wire the capture-to-clip path (latency-compensated landing) that Tracktion already performs on `transport.record()`.

> **Reality check on the engine API.** The prompt's described API (`setTargetTrack`, plain `setRecordingEnabled`) is **stale**. The pinned clone (`2877b621`) uses an `EditItemID`-keyed API: `InputDeviceInstance::setTarget(EditItemID, …)` and `setRecordingEnabled(EditItemID, bool)`. All signatures below are quoted from the real headers.

---

## 0. The load-bearing constraint (read first)

`Edit::getAllInputDevices()` returns **empty** without a playback context:

```cpp
// modules/tracktion_engine/model/edit/tracktion_Edit.cpp:2417
juce::Array<InputDeviceInstance*> Edit::getAllInputDevices() const
{
    if (auto context = getCurrentPlaybackContext())   // <-- nullptr headless
        return context->getAllInputs();
    return {};
}
```

A playback context only exists after `transport.ensureContextAllocated()`, which `MoshEngine::ensurePlaybackContext()` guards behind `audioOpen` (i.e. `hasAudio()`):

```cpp
// src/engine/MoshEngine.cpp:83
void MoshEngine::ensurePlaybackContext() {
    if (audioOpen) edit().getTransport().ensureContextAllocated();
}
```

**Consequence:** under `--selftest` (`eng.hasAudio() == false`) there are **no input-device instances at all**, so `setTarget` / `setRecordingEnabled` / `isRecordingEnabled` have nothing to operate on and actual capture cannot run. The armed/monitor *destination* state is persisted on the instance's ValueTree (created from `getInstanceStateForInputDevice`), but that tree is only reachable through a live instance. So headless we can verify **command dispatch, validation, no-op-when-no-input behaviour, snapshot field presence, and the monitor-mode enum mapping** — not a non-trivial armed=true round-trip or a captured clip. Those are **hardware/GUI-gated** (see §5).

Design the commands to **degrade gracefully**: if `getAllInputDevices()` is empty, return an `ok` result with `"applied": false` + a reason, never an error. This keeps the selftest green and mirrors how `cmdSetTransport` already skips play/record when `! hasAudio()`.

---

## 1. Exact engine APIs

### 1.1 Getting input-device instances assigned to a track
Header: `modules/tracktion_engine/model/edit/tracktion_Edit.h:271`
```cpp
juce::Array<InputDeviceInstance*> Edit::getAllInputDevices() const;
```
Free helpers — header `playback/devices/tracktion_InputDevice.h:421-437`:
```cpp
[[nodiscard]] juce::Array<std::pair<AudioTrack*,int>> getTargetTracksAndIndexes (InputDeviceInstance&);
[[nodiscard]] juce::Array<AudioTrack*> getTargetTracks (InputDeviceInstance&);
[[nodiscard]] bool isOnTargetTrack (InputDeviceInstance&, const Track&, int idx);   // idx = slot, use 0
[[nodiscard]] bool isAttached (InputDeviceInstance&);
[[nodiscard]] juce::Result clearFromTargets (InputDeviceInstance&, juce::UndoManager*);
```

### 1.2 Assigning a track as a record target (must happen before arming)
Header: `playback/devices/tracktion_InputDevice.h:128`
```cpp
[[nodiscard]] tl::expected<Destination*, juce::String>
InputDeviceInstance::setTarget (EditItemID targetID, bool moveToTrack,
                                juce::UndoManager*, std::optional<int> index = std::nullopt);
```
- `targetID` = `AudioTrack::itemID` (an `EditItemID`).
- `moveToTrack = true` (move this input to the track exclusively — matches `RecordingDemo`).
- `index = 0` (target slot index; `Destination::targetIndex` reads `IDs::targetIndex`).
- Returns `tl::expected` — **check the error**, do not deref blindly.

### 1.3 Arm / disarm (record-enable a destination)
Header: `playback/devices/tracktion_InputDevice.h:147-152`
```cpp
bool isRecordingEnabled (EditItemID) const;
void setRecordingEnabled (EditItemID, bool);   // if transport recording -> punch-in
```
Persistence: the `armed` flag is a `CachedValue<bool>` on `Destination` referring to `IDs::armed` in the `INPUTDEVICEDESTINATION` ValueTree (`tracktion_InputDevice.h:286-294`), so it **saves with the Edit** and is undoable when mutated under a transaction.

### 1.4 Input monitoring
Header: `playback/devices/tracktion_InputDevice.h:58-67` (on `InputDevice`, the **device**, not the instance):
```cpp
enum class MonitorMode { off, automatic, on };
MonitorMode getMonitorMode() const;
void setMonitorMode (MonitorMode);
```
- `off` — never audible. `automatic` — audible when record-enabled. `on` — always audible.
- Per-instance live-monitor query: `bool InputDeviceInstance::isLivePlayEnabled (const Track&) const;` (`:135`).
- **Gotcha:** monitor mode is a property of the **shared `InputDevice`**, not per-track. Two tracks fed by the same physical input share one monitor mode. Model `monitor` per-track in the snapshot but apply it to the device behind the track's instance.

### 1.5 Reference arming pattern (canonical, from the engine's own demo)
`examples/common/Utilities.h:208-263` (`EngineHelpers`) — re-implement these inline in MoshOps (the example header is not compiled into Mosh):
```cpp
inline void armTrack (te::AudioTrack& t, bool arm, int position = 0) {
    for (auto instance : t.edit.getAllInputDevices())
        if (te::isOnTargetTrack (*instance, t, position))
            instance->setRecordingEnabled (t.itemID, arm);
}
inline bool isTrackArmed (te::AudioTrack& t, int position = 0) {
    for (auto instance : t.edit.getAllInputDevices())
        if (te::isOnTargetTrack (*instance, t, position))
            return instance->isRecordingEnabled (t.itemID);
    return false;
}
inline bool isInputMonitoringEnabled (te::AudioTrack& t, int position = 0) {
    for (auto instance : t.edit.getAllInputDevices())
        if (te::isOnTargetTrack (*instance, t, position))
            return instance->isLivePlayEnabled (t);
    return false;
}
```
> **Important difference vs the demo:** in `armTrack` above, if no instance is `isOnTargetTrack`, nothing happens. So `arm_track` must **first ensure a target exists** (`setTarget`) before calling `setRecordingEnabled`. `RecordingDemo::createTracksAndAssignInputs` does `setTarget` + `setRecordingEnabled` together (`RecordingDemo.h:233-234`). We follow that: arming a virgin track assigns the first available wave input to it, then enables.

### 1.6 Enabling wave inputs on the device manager (one-time setup)
Header: `playback/tracktion_DeviceManager.h:125-126`
```cpp
int getNumWaveInDevices() const;
WaveInputDevice* getWaveInDevice (int index) const;
```
`RecordingDemo.h:215-222` enables them:
```cpp
for (int i = 0; i < dm.getNumWaveInDevices(); i++)
    if (auto wip = dm.getWaveInDevice (i)) {
        wip->setMonitorMode (te::InputDevice::MonitorMode::automatic);
        wip->setEnabled (true);   // virtual setEnabled, InputDevice.h:54
    }
```
Do this **once** in `MoshEngine` after the context is allocated and `hasAudio()` (e.g. in `ensurePlaybackContext()` after `ensureContextAllocated()`, guarded by a `bool inputsConfigured` latch), then `edit().restartPlayback()`. Headless this is skipped entirely.

### 1.7 Transport record/stop (already partly wired)
Header: `playback/tracktion_TransportControl.h:91,98`
```cpp
void record (bool justSendMMCIfEnabled, bool allowRecordingIfNoInputsArmed = false);
void stop  (bool discardRecordings, bool clearDevices, bool canSendMMCStop = true);
bool isRecording() const;                              // :131
```
`cmdSetTransport` already calls `transport.record(false)` on `action == "record"` when `hasAudio()` (`MoshOps.cpp:296-300`). The **capture-to-clip + latency-compensated landing is automatic**: when a target is armed and you `record()` then `stop(false /*keep*/, …)`, Tracktion writes the input to a temp WAV, applies record latency compensation, and inserts a `WaveAudioClip` on the target track at the punch position. We do **not** hand-roll capture; arming is the only new engine work. (The async `prepareToRecord/startRecording/stopRecording` API in `InputDevice.h:195-239` is the lower-level path — we stay on the high-level `transport.record()`.)

### 1.8 Level metering (optional, for an arm-time input meter)
Header: `playback/tracktion_LevelMeasurer.h:94-95`, plus `InputDevice::levelMeasurer` is a **public** member (`tracktion_InputDevice.h:84`):
```cpp
std::pair<float,float> LevelMeasurer::getLevelCache() const;   // dB L/R, floor -100 dB
```
So `instance->getInputDevice().levelMeasurer.getLevelCache()` gives input dB. Feed it through the existing 30 Hz `timerCallback`. **Defer to a stretch goal** — it only produces non-trivial values with a live device, and the wave's core is arm/monitor/capture. If included, emit it on the existing `"transport"` event (or a new `"meters"` event) and read `{l,r}` in the UI.

---

## 2. MoshOps commands to add

Follow the house pattern exactly: `validate → undoManager().beginNewTransaction("name") → mutate via te:: → logLine(...) → emitSnapshotInvalidated() → okResult/errResult`. Declare in `MoshOps.h` (alongside the track commands ~line 68), dispatch in `execute()` (`MoshOps.cpp:135`-ish), implement near `cmdSetTrackMute`.

### 2.1 `arm_track`
- **args:** `{ trackId: string, armed: bool }`
- **behaviour:**
  1. `auto* track = findTrack(trackId);` → `errResult` if null.
  2. `beginNewTransaction("arm_track");`
  3. Ensure a target: iterate `eng.edit().getAllInputDevices()`; if none `isOnTargetTrack(*inst, *track, 0)` **and** `armed==true`, pick the first **wave** instance (`getInputDevice().getDeviceType() == te::InputDevice::waveDevice`) and `inst->setTarget(track->itemID, true, &undoManager(), 0)` (check the `tl::expected`).
  4. For the matching instance: `inst->setRecordingEnabled(track->itemID, armed);`
  5. If `getAllInputDevices()` is empty (headless / no audio): **no-op**, set a local `applied=false`.
  6. `logLine("arm_track", args, true, {}, true); emitSnapshotInvalidated();`
  7. `return okResult("arm_track", obj{ trackId, armed, applied });`
- **undoable:** yes (arm/target state lives in the Edit ValueTree; transaction covers it).

### 2.2 `set_input_monitor`
- **args:** `{ trackId: string, mode: "off"|"automatic"|"on" }` (also accept legacy `{ monitor: bool }` → `on`/`off`).
- **behaviour:**
  1. `findTrack` → err if null. Validate `mode` ∈ enum → err on unknown.
  2. `beginNewTransaction("set_input_monitor");`
  3. Map string → `te::InputDevice::MonitorMode`.
  4. For each instance `isOnTargetTrack(*inst, *track, 0)`: `inst->getInputDevice().setMonitorMode(mode);` (set the **device**, per §1.4).
  5. Empty-instance list → `applied=false` no-op.
  6. `logLine(...); emitSnapshotInvalidated(); return okResult(...)`.
- **undoable:** monitor mode is a device prop saved via `saveProps()`; wrap in the transaction for consistency even though it may not strictly round-trip through `UndoManager`. (Note in PROGRESS: monitor is shared across tracks on the same input.)

> Do **not** add a separate `record` command — `set_transport {action:"record"}` already exists and is the correct entry point. Arming is the missing precondition this wave supplies.

---

## 3. Snapshot additions

Builder: **`trackToVar(te::AudioTrack&, int)`** (`MoshOps.cpp:1644`). Add two fields right after `solo`:

```cpp
// requires a live instance; both default false when headless / no input assigned
bool armed = false; juce::String monitor = "automatic"; bool hasInput = false;
for (auto* inst : eng.edit().getAllInputDevices())
    if (te::isOnTargetTrack (*inst, t, 0)) {
        hasInput = true;
        armed   = inst->isRecordingEnabled (t.itemID);
        switch (inst->getInputDevice().getMonitorMode()) {
            case te::InputDevice::MonitorMode::off:       monitor = "off"; break;
            case te::InputDevice::MonitorMode::on:        monitor = "on"; break;
            case te::InputDevice::MonitorMode::automatic: monitor = "automatic"; break;
        }
        break;
    }
o->setProperty ("armed",    armed);     // bool
o->setProperty ("monitor",  monitor);   // "off" | "automatic" | "on"
o->setProperty ("hasInput", hasInput);  // bool — false headless; UI can show "no input"
```

**Transport snapshot** (`transportToVar`, `MoshOps.cpp:1753`) already exposes `recording` — no change needed; the existing `"transport"` 30 Hz event already carries it so the record button lights up live.

**Types** — `ui/src/types.ts` `Track`:
```ts
armed?: boolean;
monitor?: "off" | "automatic" | "on";
hasInput?: boolean;
```

---

## 4. UI plan

Single component touched: **`ui/src/components/Arrangement.tsx`**, function `TrackHeader` (lines 289-336). Keep the existing two-row `.th-row` layout and the `.mixbtn` visual language (M / S buttons). Add an **R** (record-arm) and **I** (input-monitor) button to the second `.th-row`, left of M/S, so the row reads `R I M S [pan] [vol]`.

```tsx
<button
  className={`mixbtn ${track.armed ? "arm-on" : ""}`}
  title={track.hasInput ? "Record-arm" : "Record-arm (no input device)"}
  onClick={() => exec("arm_track", { trackId: track.id, armed: !track.armed })}
>R</button>
<button
  className={`mixbtn ${track.monitor && track.monitor !== "off" ? "mon-on" : ""}`}
  title={`Input monitor: ${track.monitor ?? "automatic"}`}
  onClick={() => exec("set_input_monitor", {
    trackId: track.id,
    mode: track.monitor === "on" ? "off" : "on",   // simple 2-state toggle; cycle off/auto/on optional
  })}
>I</button>
```

Styling — `ui/src/styles.css`: add `.mixbtn.arm-on { background: var(--rec, #e3463f); color:#fff; }` and `.mixbtn.mon-on { background: var(--accent); }`, reusing the existing token palette and the same border-radius/size as `.mute-on`/`.solo-on`. The global record button in `Transport.tsx` already reflects `transport.recording`; no change there beyond confirming it calls `set_transport {action:"record"}`.

**Optional input meter:** if §1.8 is built, add a thin vertical bar in the track header bound to a `meters[trackId]` map in `store.ts` updated from a `"meters"`/`"transport"` event. Match the existing waveform canvas styling. Defer.

No changes to Mixer/PianoRoll. Pure-view state (which button is hovered, etc.) stays UI-local per the swappable-seam directive.

---

## 5. Self-test plan (honest about hardware gating)

`--selftest` runs with `eng.hasAudio() == false` → **no playback context → `getAllInputDevices()` empty**. So:

### Verifiable headless (add to `src/app/SelfTest.cpp`, same `check(...)` style)
- `arm_track` on a valid track → `ok(r) == true` (graceful no-op), and `r.data.applied == false` headless.
- `arm_track` with a bad/missing `trackId` → `ok == false` (validation).
- `set_input_monitor` with `mode:"on"` → `ok == true`; with `mode:"banana"` → `ok == false`.
- Snapshot shape: every track var has `armed` (bool), `monitor` (string), `hasInput` (bool); `armed==false`, `hasInput==false` headless.
- Both commands emit `snapshot_invalidated` (reuse the existing `hadEvent` helper).
- `arm_track` then `undo` → still `ok`, snapshot unchanged shape (no crash; state already false).
- JSONL: `arm_track` / `set_input_monitor` lines appear in `mosh-log.jsonl`.

### Hardware / GUI-gated (cannot run headless — document, don't fake)
- **armed=true round-trip:** needs a real input device so `getAllInputDevices()` is non-empty and `setTarget`/`isRecordingEnabled` have an instance. Verify in the GUI app (or a `--demo7` with a live device) that `arm_track {armed:true}` → snapshot `armed==true`, `hasInput==true`.
- **Actual capture:** arm → `set_transport record` → speak/play → `set_transport stop` → a new `WaveAudioClip` lands on the track at the punch position. Needs live CoreAudio input.
- **Latency-compensated landing:** the recorded clip's start aligns to the metronome/punch point (Tracktion applies record latency comp internally). Verify by recording against the click and checking the clip start offset is sub-block. Hardware-only.
- **Input monitoring audible:** `monitor:"on"` makes live input audible through the output. Ears + hardware.

> There is precedent for a live-audio probe: `SelfTest.cpp:45-108` already defines `LiveAudioProbe`, which counts `inputNonSilentSamples`. A future `--selftest-live` (opt-in, real device) could open the device, arm via `arm_track`, record, and assert a clip appeared + the probe saw input. Keep it **out of the default headless run**.

---

## 6. Risks / gotchas

1. **No instances headless (primary risk).** Everything routes through `getAllInputDevices()`, which is empty without audio. Mitigation: graceful `applied:false` no-op (never error), and keep all headless asserts to shape/dispatch (§5). **Do not** try to allocate a context headless to force instances — `ensureContextAllocated` is gated for a reason and would touch CoreAudio.
2. **`setTarget` returns `tl::expected`.** Must check `if (auto r = inst->setTarget(...); ! r) { logLine(...,false,r.error()); }`. Blind deref of the error case is UB. The demo uses `[[maybe_unused]] auto result` and ignores it — we should at least log failures.
3. **Arm before target = no-op.** `EngineHelpers::armTrack` silently does nothing if the track isn't a target. `arm_track` must `setTarget` first when arming a track that has no input yet (mirror `RecordingDemo.h:233-234`). Disarming a track with no instance is a harmless no-op.
4. **Monitor mode is per-device, not per-track.** Two tracks sharing one physical input share monitor mode. Snapshot shows it per-track (read-through) but the UI toggle mutates the shared device. Document in PROGRESS; acceptable for v0 (one input typical).
5. **`EngineHelpers::enableInputMonitoring` only toggles on↔off** (ignores `automatic`) — don't reuse it verbatim; set the explicit enum from the command's `mode` arg.
6. **One-time input enablement.** Wave inputs need `setEnabled(true)` + `restartPlayback()` once (§1.6). Guard with a latch in `MoshEngine` so it runs once when audio + context first come up; never headless. Forgetting this = armed but silent capture.
7. **`isOnTargetTrack` uses slot index.** Pass `0` consistently for `setTarget`, `isOnTargetTrack`, and the snapshot read, or they won't match.
8. **Persistence / save-reload.** The destination (target + `armed`) lives in the Edit's input-device ValueTree and saves with the Edit. After reload with the same device present, the track should re-arm. With a *different* device it won't match — acceptable; snapshot will show `hasInput:false`.
9. **`itemID` asserts.** `Destination` asserts `targetID.isValid()` (`InputDevice.h:294`). Always pass a real `AudioTrack::itemID` (we get it from `findTrack`), never a default `EditItemID`.
10. **RT-safety.** No new audio-thread code — `transport.record()`/capture is engine-owned and already RT-safe. The optional meter read (`getLevelCache`) is a plain `std::pair<float,float>` read off the message thread at 30 Hz; safe.
11. **Undo of arm during recording.** `setRecordingEnabled` punches in if the transport is recording (`InputDevice.h:149-151`). Don't expose arm toggles mid-record in a way that surprises; the UI button is fine but note the punch-in behaviour.

---

## 7. Implementation order (smallest verifiable slice first)

1. **Snapshot fields (read-only).** Add `armed`/`monitor`/`hasInput` to `trackToVar` with the `getAllInputDevices()` read-through. Headless they're `false/"automatic"/false`. Add the selftest shape checks. *Verifiable immediately, zero behaviour change.*
2. **`set_input_monitor` command + dispatch + decl.** Pure state set on the device; validation of `mode`. Selftest: ok/err + `snapshot_invalidated` + JSONL. *Headless-safe (no-op when empty).*
3. **`arm_track` command** with the `setTarget`-then-`setRecordingEnabled` logic and the `applied:false` graceful path. Selftest: ok/err + invalidated + JSONL + undo-doesn't-crash. *Headless-safe.*
4. **UI: R/I buttons in `TrackHeader`** + `styles.css` tokens + `types.ts` fields. Rebuild the bundle (swappability check: backend byte-identical). *Verifiable via render; live toggle needs §6.*
5. **`MoshEngine` one-time wave-input enablement** (`setEnabled(true)` + monitor default + `restartPlayback()`), latched, audio-only. *Enables real capture in the GUI.*
6. **GUI / `--demo7` live verification** (hardware): arm=true round-trip, record→stop→clip lands, monitor audible. Document results in `docs/PROGRESS.md`; note CoreAudio dependency.
7. **(Stretch) input meter** via `levelMeasurer.getLevelCache()` on the 30 Hz timer → header bar. Defer if time-boxed.

**Definition of done (headless):** `--selftest` green with the new arm/monitor/snapshot checks (target ~+8 checks). **Definition of done (full):** GUI shows armed clip capture landing latency-compensated on the track, monitor toggles audibility — recorded in PROGRESS as hardware-verified.
