# Wave plan — Channel metering (live level meters)

Per-track + master live level meters. Insert a `LevelMeterPlugin` post-fader on
each `AudioTrack` on demand, register a `LevelMeasurer::Client` against its
`measurer`, read the client at 30 Hz in `timerCallback()`, and push a `"levels"`
event `{ tracks: {trackId -> {l,r}}, master: {l,r} }`. Master reads from the
playback context's built-in `masterLevels` measurer (no plugin needed). The UI
animates meter bars on Mixer strips + track headers from the event — no snapshot
churn (same lightweight path as the existing `"transport"` event).

---

## 0. KEY ENGINE FINDING (read this first — it changes the obvious design)

The prompt suggested reading `measurer.getLevelCache() -> {dBL,dBR}`. **That path
does not work.** Verified by grep across the entire pinned clone
(`2877b621`): `LevelMeasurer::setLevelCache(...)` is **defined but NEVER CALLED
anywhere in the engine**.

- `LevelMeasurer::processBuffer()` (the only thing the audio graph calls) updates
  **registered `Client`s only** — it never touches `levelCacheL/R`. See
  `playback/tracktion_LevelMeasurer.cpp:149-222`.
- `getLevelCache()` therefore always returns the constructed default
  `{-100.0f, -100.0f}`. (The engine's own `LevelMeterPlugin::timerCallback`
  reads `getLevelCache()` and feeds it to control surfaces — meaning **the
  built-in level-meter plugin's level is always -100 on hardware control
  surfaces**; it is effectively dead code in this clone. Do not copy it.)

**Correct path:** allocate a `LevelMeasurer::Client`, call
`measurer.addClient(client)` once, then each frame call
`client.getAndClearAudioLevel(chan).dB` for chan 0/1. This is the path the engine
actually drives in `processBuffer`. `getAndClear*` is the intended read API
(SpinLock-guarded, returns the running peak and resets the floor to -100).

The **master** path works the same way: `EditPlaybackContext::masterLevels` is a
`LevelMeasurer` that the audio graph feeds via `LevelMeasuringNode`
(`EditNodeBuilder.cpp:1940` wires `epc.masterLevels` into the master chain).
Register a client against `getCurrentPlaybackContext()->masterLevels` — no plugin
insertion needed for master.

---

## 1. Exact engine APIs (verified signatures, header paths, units)

### LevelMeasurer — `playback/tracktion_LevelMeasurer.h`
```cpp
class LevelMeasurer {
    void processBuffer (juce::AudioBuffer<float>& buffer, int start, int numSamples); // graph-driven, RT
    void clear();
    enum Mode { peakMode = 0, RMSMode = 1, sumDiffMode = 2 };
    void setMode (Mode);
    int  getNumActiveChannels() const noexcept;
    void addClient (Client&);       // message thread; jassert(!contains) — add ONCE
    void removeClient (Client&);    // MUST call before the measurer/plugin is destroyed
    // setLevelCache/getLevelCache exist but are dead — DO NOT USE.

    struct Client {
        void reset() noexcept;
        DbTimePair getAndClearAudioLevel (int chan) noexcept;  // <-- the read we use
        bool       getAndClearOverload() noexcept;             // global, not per-channel (see gotcha)
        int        getNumChannelsUsed() const noexcept;        // 1 (mono) or 2 (stereo)
        static constexpr auto maxNumChannels = 8;
    };
};
```
- `DbTimePair { uint32_t time; float dB = -100.0f; }` — `time` is
  `juce::Time::getApproximateMillisecondCounter()` at capture; `dB` is the field
  we want.
- **Units:** `processBuffer` in `peakMode` (the default) does
  `gain = buffer.getMagnitude(chan,...)` then `dB = gainToDb(gain)`. So the value
  is **peak dBFS**: 0 dB = full scale, floor `-100.0f`. Confirmed
  `gainToDb` (`utilities/tracktion_AudioUtilities.cpp:131`):
  `return (gain > 0.0f) ? 20*log10(gain) : -100.0f;`. Overload flag is set when
  `gain > 0.999f`.
- `getAndClearAudioLevel(chan)` **resets that channel's stored dB to -100 after
  reading** (`tracktion_LevelMeasurer.cpp:98-105`). This is a peak-since-last-read
  meter, which is exactly right for a 30 Hz poll: each frame reports the peak of
  all audio blocks processed since the previous frame. No extra decay logic
  needed in C++ (do ballistics/decay in the UI).
- `updateAudioLevel` only raises (`if (newDB >= stored) stored = newDB;`), so
  between reads the client holds the max — good.
- `Client` is **stack/member-safe to hold** but is `addClient`'d by pointer into
  a `juce::Array<Client*>`. The Client must outlive the measurer's client list →
  always `removeClient` in the owner's destructor/teardown.

### LevelMeterPlugin — `plugins/internal/tracktion_LevelMeter.h`
```cpp
class LevelMeterPlugin : public Plugin {
    static const char* xmlTypeName;            // == "level"
    LevelMeasurer measurer;                    // public — register our Client here
    int getNumOutputChannelsGivenInputs (int n) override { return jmin (n, 2); } // max stereo
    bool canBeDisabled() override { return false; }   // cannot be bypassed — fine, it's a tap
};
```
- Created exactly like every other built-in (the project's proven idiom):
  `eng.edit().getPluginCache().createNewPlugin (te::LevelMeterPlugin::xmlTypeName, {})`
  then `track->pluginList.insertPlugin (plugin, index, nullptr)`. Insert at the
  **end** of `pluginList` (post-fader, since `VolumeAndPanPlugin` sits earlier in
  the list) so the meter reads the actual track output.
- `measurer` defaults to `peakMode`. Leave it (peak dBFS). RMS optional later via
  `measurer.setMode(LevelMeasurer::RMSMode)`.
- The plugin's own `juce::Timer`/control-surface code is harmless; we ignore it
  and read `measurer` ourselves.

### Master — `playback/tracktion_EditPlaybackContext.h:53`
```cpp
class EditPlaybackContext { LevelMeasurer masterLevels; /* public */ };
// Edit.h:278  EditPlaybackContext* getCurrentPlaybackContext() const;  // null when not playing/headless
```
- `getCurrentPlaybackContext()` is **null** with no audio device or when not
  playing → every master read MUST null-check it. (In `--selftest`
  `eng.hasAudio()==false`, so this is always null — see §5.)
- Register a Client against `ctx->masterLevels` when the context appears.
  **Gotcha:** the context is recreated on play/stop, so the client registration
  is transient — re-register each time we see a fresh non-null context. Track
  the context pointer; if it changed, `addClient` to the new one (the old one is
  already gone, no `removeClient` needed/possible).

### gain<->dB — `utilities/tracktion_AudioUtilities.h`
```cpp
float dbToGain (float db) noexcept;   // 10^(db/20)
float gainToDb (float gain) noexcept; // 20*log10(gain), floor -100
```

---

## 2. MoshOps commands (validate → transaction → mutate → log → snapshot → result)

Decision: **explicit, idempotent, auto-on-first-need.** Add commands so the UI
can toggle metering, but also auto-insert the tap the first time a track is
metered so the common case "just works." Track meters are real plugin-list
mutations (undoable, persisted); master needs no command (always available from
the context).

### `enable_track_meter` — args `{ trackId }`
Behaviour: idempotent. If the track already has a `LevelMeterPlugin` at the end
of `pluginList`, no-op ok. Else:
- `findTrack(trackId)`; err `"no track"` if missing.
- `undoManager().beginNewTransaction("enable_track_meter")`.
- `auto p = eng.edit().getPluginCache().createNewPlugin (te::LevelMeterPlugin::xmlTypeName, {});`
- `track->pluginList.insertPlugin (p, track->pluginList.getPlugins().size(), nullptr);`
  (append = post-everything).
- Register our Client: store `{ trackId -> { LevelMeterPlugin*, Client } }` in a
  `std::map` member on MoshOps; `meterPlugin->measurer.addClient(client)`.
- `logLine("enable_track_meter", args, true, {}, true);`
- `emitSnapshotInvalidated();` (track now reports `meterEnabled:true`).
- `okResult`.

### `disable_track_meter` — args `{ trackId }`
- `meterPlugin->measurer.removeClient(client)`; erase the map entry.
- find the `LevelMeterPlugin` in `pluginList` and
  `track->pluginList.removePlugin(p)` inside a transaction.
- log + `emitSnapshotInvalidated()` + ok.

### `enable_all_meters` — args `{}` (convenience for the mixer view)
- Loop `te::getAudioTracks(edit)`, call the same insert+register logic per track
  (skip tracks that already have one). One transaction. Single
  `emitSnapshotInvalidated()` at the end.

**Auto-on:** in `cmdCreateTrack` (and on session reload, see §6 persistence), call
the same internal `ensureTrackMeter(track)` helper so new tracks are metered by
default. Keep the explicit disable command for users who don't want it. (If we
prefer zero default footprint, gate auto-on behind a UI toggle that just calls
`enable_all_meters` — recommend auto-on for a DAW.)

**Helper to add (mirrors `ensureVolumePlugin`):**
```cpp
te::LevelMeterPlugin* ensureTrackMeter (te::AudioTrack&);  // creates+inserts+registers client, idempotent
void registerMeterClient (const juce::String& trackId, te::LevelMeterPlugin&);
void unregisterAllMeterClients();  // called from ~MoshOps before plugins die
```

### `timerCallback()` — the 30 Hz carrier (already exists, extend it)
Current body emits `"transport"` only while playing. Extend to also emit
`"levels"` whenever **playing OR any client exists** (so meters fall to -inf and
the UI sees the decay). Build the payload:
```cpp
// pseudo, inside timerCallback after the transport emit
DynamicObject* tracksObj = new DynamicObject();
for (auto& [trackId, mc] : meterClients) {
    auto l = mc.client.getAndClearAudioLevel(0).dB;
    auto r = mc.plugin->measurer... // chan 1; if mono, reuse l
    int chans = mc.client.getNumChannelsUsed();
    float rr = (chans >= 2) ? mc.client.getAndClearAudioLevel(1).dB : l;
    auto* o = new DynamicObject(); o->setProperty("l", l); o->setProperty("r", rr);
    tracksObj->setProperty (trackId, var(o));
}
// master
if (auto* ctx = eng.edit().getTransport().getCurrentPlaybackContext()) {
    if (ctx != lastSeenContext) { ctx->masterLevels.addClient(masterClient); lastSeenContext = ctx; }
    auto ml = masterClient.getAndClearAudioLevel(0).dB;
    auto mr = masterClient.getAndClearAudioLevel(1).dB;
    masterObj->setProperty("l", ml); masterObj->setProperty("r", mr);
} else { lastSeenContext = nullptr; /* master {l:-100,r:-100} */ }
emit("levels", payloadWith(tracksObj, masterObj));
```
**Order both reads of a channel carefully:** call `getAndClearAudioLevel(0)` and
`(1)` exactly once each per frame (each call resets that channel). Do not call
twice.

**Rate note:** 30 Hz is the established decimation. `LevelMeterPlugin`'s own
timer runs at 50 Hz internally but we don't use it. Our read is independent.

---

## 3. Snapshot additions

Two distinct surfaces — keep them separate:

**(A) Static "is metering on" flag → `trackToVar(te::AudioTrack&, int)`**
Add `o->setProperty("meterEnabled", hasTrackMeter(t));` where `hasTrackMeter`
checks our `meterClients` map (or scans `pluginList` for a `LevelMeterPlugin`).
Type: `boolean`. This drives the UI's enable/disable toggle and lets the UI know
whether to render a meter at all. Goes in the snapshot (low-frequency, structural).

**(B) Live dB values → NOT in the snapshot.** They flow only through the
`"levels"` event (30 Hz), exactly like `transport.position`. Putting them in the
snapshot would force a full refetch+rerender 30×/s. The store holds them in a
separate `levels` map (see §4), never inside `snapshot`.

**Hide the meter plugin from the rack** — `trackToVar` plugin loop
(`MoshOps.cpp:1659-1664`) currently serializes **every** plugin in `pluginList`,
including our tap. Add a skip so `LevelMeterPlugin` (and the already-hidden-by-
convention `VolumeAndPanPlugin`) don't appear in `plugins[]`:
```cpp
for (int i = 0; i < pl.size(); ++i)
    if (pl[i] != nullptr
        && dynamic_cast<te::LevelMeterPlugin*>(pl[i]) == nullptr
        && dynamic_cast<te::VolumeAndPanPlugin*>(pl[i]) == nullptr)   // optional: also hide vol
        plugins.add (pluginToVar (*pl[i], i));
```
NB: the index passed to `pluginToVar` must stay the real `pluginList` index `i`
(commands address plugins by list index), so keep `i` as the loop counter and
just skip the push — do not renumber. (Today VolumeAndPan IS shown; if you don't
want to change that behaviour, only filter the LevelMeterPlugin.)

Event payload shape (`"levels"`):
```ts
{ type: "levels", payload: {
    tracks: { [trackId: string]: { l: number; r: number } },   // peak dBFS, -100 floor
    master: { l: number; r: number }
}}
```

---

## 4. UI plan (keep current visual style)

### types.ts
- `Track`: add `meterEnabled?: boolean;`
- New: `export type Level = { l: number; r: number };`
- New: `export type LevelsEvent = { tracks: Record<string, Level>; master: Level };`

### store.ts
- Add state `levels: { tracks: Record<string, Level>; master: Level }` init
  `{ tracks: {}, master: { l: -100, r: -100 } }`.
- In `init()`'s `onEvent` switch, add:
  ```ts
  else if (ev.type === "levels") {
    set({ levels: ev.payload as LevelsState });
  }
  ```
  This mirrors the existing `"transport"` branch — a targeted `set` that does NOT
  call `refresh()`, so no snapshot refetch. Meter components subscribe to
  `s.levels` only.
- Add `exec` helpers are not needed; meter toggle just calls
  `exec("enable_track_meter" | "disable_track_meter", { trackId })`.

### New component `components/Meter.tsx`
A small presentational bar meter (reused by Mixer + Arrangement):
```tsx
export function Meter({ level, vertical }: { level: Level; vertical?: boolean }) { ... }
```
- Map dBFS → 0..1 with a fixed scale (e.g. -60 dB → 0, 0 dB → 1): existing
  `time.ts` already has a `meterFrom` helper imported in store — check whether it
  is a dB-meter mapper or the musical-meter (time-signature) helper before reuse.
  (It is the **musical meter** `meterFrom(session)`; do NOT reuse it for levels —
  add a local `dbToFrac(db) = clamp((db + 60) / 60, 0, 1)`.)
- Smooth with CSS transition + a UI-side peak-hold/decay (the C++ already gives
  peak-since-frame; add `transition: height 60ms linear` and an optional held
  peak tick). Colour ramp green→amber→red near 0 dB using existing CSS tokens
  (`styles.css` palette vars) so it matches both themes.
- Subscribe narrowly: `const lvl = useStore(s => s.levels.tracks[trackId])` so
  only the meter re-renders at 30 Hz, not the whole strip.

### Mixer.tsx
- In `ChannelStrip`, add a vertical `<Meter level={levels.tracks[track.id]} />`
  beside the fader (the `.fader-wrap` already exists — place the meter as a
  sibling so it sits next to the fader, classic channel-strip layout).
- In the master strip, add `<Meter level={levels.master} vertical />` beside the
  master fader.
- Add a tiny meter on/off toggle to the strip (optional) wired to
  `enable_track_meter`/`disable_track_meter`; or rely on auto-on and skip the
  toggle for v1.

### Arrangement.tsx (track headers)
- Add a thin horizontal `<Meter level={levels.tracks[t.id]} />` in each track
  header (next to the M·S·volume controls). Keep it compact to preserve the
  current header layout.

### styles.css
- Add `.meter`, `.meter-bar`, `.meter--v`, colour-ramp classes using the existing
  theme token vars (so dark/light both work). No new layout system — just a
  flexbox bar inside existing containers.

No changes to `App.tsx` routing/views are needed; meters live inside the existing
Mixer and Arrangement components.

---

## 5. Self-test / verification (honest about headless limits)

`--selftest` runs with **`eng.hasAudio()==false`** → no audio device, no playback
context (`getCurrentPlaybackContext()` is null), and `processBuffer` is never
called, so **all live dB values stay at the -100 floor.** What that means:

**Verifiable headless (add to `src/app/SelfTest.cpp`):**
- `enable_track_meter` on a track returns ok; the track's snapshot
  `meterEnabled == true`.
- After enable, the track's `plugins[]` in the snapshot does **NOT** contain a
  `"level"` plugin (proves the hide-from-rack filter) — and `pluginList` length
  grew by 1 internally (assert a `LevelMeterPlugin` exists via a back-door check
  or via the index the command returns).
- `disable_track_meter` returns ok; `meterEnabled == false`; plugin removed.
- Idempotency: calling `enable_track_meter` twice → still exactly one meter
  plugin; second call ok/no-op.
- Undo after enable removes the meter; redo restores it (it's a normal undoable
  pluginList mutation).
- `enable_all_meters` enables every track.
- A `"levels"` event fires from `timerCallback` and has the right **shape**
  (`tracks` object keyed by trackId, `master` object with `l`/`r`) even though
  every value is -100. (Can assert shape by capturing one event via the EventSink
  in the harness.)
- Persistence: after `save` + `reload`, a metered track still reports
  `meterEnabled == true` **iff** we persist the plugin (see §6). If we choose
  NOT to persist (recommended), assert `meterEnabled == false` after reload and
  that re-enabling works.
- New-track auto-on (if implemented): `create_track` → snapshot `meterEnabled`
  true (and still no `"level"` in `plugins[]`).

**NOT verifiable headless — needs live audio/hardware (state explicitly):**
- Non-trivial meter values (anything above -100) require a real CoreAudio device
  + playing audio through the graph so `processBuffer`/`LevelMeasuringNode` run.
- Master meter producing values at all (the playback context only exists with
  audio attached and transport active).
- Stereo vs mono channel reporting (`getNumChannelsUsed`) needs real buffers.
- Meter ballistics / visual smoothness — UI-only, eyeball in the running app
  (`Mosh --demo`-style screenshot of the mixer with audio playing).

Recommend a `Mosh --demoMeter` (or extend an existing demo) that, with audio
attached, plays a test-tone clip and screenshots the mixer to show non-zero
meters — that is the real proof, gated on hardware as noted.

---

## 6. Risks / gotchas

- **`getLevelCache()` is a trap** (see §0) — using it ships dead meters that
  always read -100. Use a registered `Client` + `getAndClearAudioLevel`.
- **Client lifetime / dangling pointer.** `addClient` stores a `Client*` in the
  measurer. If the `LevelMeterPlugin` (and its `measurer`) is destroyed while our
  `Client` is still registered, or vice-versa, you get UAF. Rules: (a) keep the
  `Client` as a member owned by MoshOps in the `meterClients` map; (b)
  `removeClient` before removing the plugin in `disable_track_meter`; (c)
  `unregisterAllMeterClients()` in `~MoshOps` BEFORE the engine/edit tears down;
  (d) on session **reload** the old `Edit`/plugins are gone — clear the whole
  `meterClients` map and re-`ensureTrackMeter` from the fresh edit (the stored
  `LevelMeterPlugin*`/`Client` from the previous edit are stale).
- **Master context is transient.** `getCurrentPlaybackContext()` returns a *new*
  object across play/stop. Detect pointer change and re-`addClient` to the new
  `masterLevels`; never cache the old context. Don't `removeClient` a dead
  context (it's already freed) — just drop the pointer.
- **`itemID`/`insertPlugin` assert.** The project already documented: plugins must
  be created via `edit().getPluginCache().createNewPlugin(...)` (NOT
  `PluginManager::createNewPlugin`) or `indexOf` fails and it asserts. Use the
  cache (same as `ensureVolumePlugin`/`load_builtin`). Append at the real list
  size for index.
- **RT-safety:** we never touch the audio thread. `processBuffer` (RT) writes the
  Client under a `juce::SpinLock`; our `getAndClearAudioLevel` (message thread,
  30 Hz) takes the same SpinLock briefly. That's the engine's intended cross-
  thread handoff — no allocation on the audio thread, lock is uncontended-fast.
  Do **not** allocate the `DynamicObject` payload on the audio thread (we don't —
  it's in `timerCallback` on the message thread). Fine.
- **Plugin-list hiding & index stability.** When filtering `LevelMeterPlugin` out
  of `plugins[]`, keep passing the true `pluginList` index to `pluginToVar` so
  plugin-addressed commands (`set_plugin_param`, `remove_plugin`, `reorder`)
  still resolve. Only skip the array push; never renumber. (The meter is appended
  last, so visible plugin indices are unaffected anyway.)
- **Persistence decision.** `LevelMeterPlugin` is serialisable and WILL be saved
  into the edit if left in `pluginList`. Two options:
  (1) **Don't persist** (recommended): strip meter plugins before `save`
  (in `cmdSave`, temporarily `removeClient`+`removePlugin`, save, re-add) OR
  simpler — accept they persist but re-register clients on reload. Persisting is
  harmless (it's just a tap) as long as reload re-registers clients and the
  hide-from-rack filter keeps them invisible. **Recommend: let it persist, and on
  reload clear+rebuild `meterClients` by scanning each track's `pluginList` for a
  `LevelMeterPlugin` and registering a client.** Simpler than surgical save.
  Document whichever you pick in the self-test persistence assertion.
- **Mono tracks.** `getNumOutputChannelsGivenInputs` caps at 2 but a mono track
  yields 1 active channel → `getNumChannelsUsed()==1`; mirror chan 0 to R in the
  payload so the UI shows a single bar correctly.
- **Overload flag is global, not per-channel** on the read side
  (`getAndClearOverload()` returns one bool for the client, not per-channel).
  If a clip/over indicator is wanted, expose it as one `clip:boolean` per track;
  don't try to read per-channel overload from the Client (only the internal
  `overload[]` array is per-channel and has no public getter).

---

## 7. Recommended implementation order (smallest verifiable slice first)

1. **Engine read primitive (headless-provable structure).** Add the
   `meterClients` map + `ensureTrackMeter` helper + `enable_track_meter` /
   `disable_track_meter` commands. Hide `LevelMeterPlugin` in `trackToVar`. Add
   `meterEnabled` to the snapshot. Self-test: enable/disable/idempotent/undo/
   hidden-from-rack. (No live values yet — pure command + snapshot plumbing,
   fully headless-verifiable.)
2. **`"levels"` event shape.** Extend `timerCallback` to read all clients +
   master and emit `"levels"`. Self-test: capture one event, assert shape
   (values will be -100 headless — assert keys/structure only).
3. **Store + types.** Add `levels` state, the `"levels"` event branch (no
   refresh), `Level` types, `meterEnabled` on `Track`. Build the UI bundle
   (verifies the swappable-seam: backend unchanged).
4. **`Meter.tsx` + Mixer strips.** Vertical meters next to faders + master.
   `dbToFrac` mapping, CSS in `styles.css` using theme tokens.
5. **Arrangement track-header meters.** Thin horizontal meter per header.
6. **Auto-on + `enable_all_meters`** + reload re-registration. Self-test the
   create-track-auto-on and reload paths.
7. **Live proof (hardware-gated).** With audio attached, play a test tone and
   screenshot the mixer showing moving meters + master. Note in the gate report
   that non-trivial values are hardware-gated (CoreAudio), matching the project's
   prior honesty about audio-off headless runs.
