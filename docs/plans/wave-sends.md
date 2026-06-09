# Wave: Sends / Returns / Aux Buses + Routing

Concrete, ready-to-implement plan. All APIs below were verified against the pinned
tracktion clone at
`/Users/emiliosanchez-harris/Documents/ClaudeMosh/.cpm-cache/_fc/tracktion_engine-src/modules/tracktion_engine`.

## 0. Design decision — return track model (MIX-008)

Tracktion routes aux audio purely by **bus number**, matched at graph-build time
(`tracktion_EditNodeBuilder.cpp:1289–1301`):

```cpp
else if (auto sendPlugin = dynamic_cast<AuxSendPlugin*> (p))
{
    if (sendPlugin->isEnabled())
        node = makeNode<AuxSendNode> (std::move (node), sendPlugin->busNumber, ...);
}
else if (auto returnPlugin = dynamic_cast<AuxReturnPlugin*> (p))
{
    if (returnPlugin->isEnabled())
        node = makeNode<ReturnNode> (std::move (node), returnPlugin->busNumber);
}
```

There is **no central bus registry** and **no maximum-bus enforcement** in the engine
(`AuxSendPlugin::getBusNames(Edit&, maxNumBusses)` only iterates a caller-chosen count).
A send with busNumber N feeds whichever AuxReturn(s) carry busNumber N. The aux output
of a send is injected *downstream* of the return in the graph; the send is post-fader on
the source track because it sits in `pluginList` after the source's volume plugin.

**Chosen model: a dedicated normal `AudioTrack` as the "return track."** Reasons:
- `AuxReturnPlugin` has `producesAudioWhenNoAudioInput() == true` (header line confirms),
  so a track with only an AuxReturn + VolumeAndPan still renders into the mix.
- The existing snapshot, `trackToVar`, mixer strips, plugin rack, and `set_track_volume/pan/mute/solo`
  all already work on AudioTracks — a return track is "just a track" plus one flag. Near-zero new plumbing.
- FolderTrack/submix (`tracktion_FolderTrack.h`: `isSubmixFolder()`, `getOutput()`, `getInputTracks()`)
  is a *parenting* concept (children route into the folder) — a different feature (track grouping)
  that needs hierarchical snapshot/UI work. **Do NOT use FolderTrack for v0 sends.** Note it in the
  parking lot as the future "group/submix bus" rung.

**Bus identity = the integer busNumber.** Mosh assigns busNumber by allocating the lowest
unused non-negative int across all AuxReturn plugins in the Edit. The human-readable bus
name lives in the Edit via `Edit::setAuxBusName(int, String)` (used by `AuxSendPlugin::getName()`
→ `"S:<name>"` and `AuxReturnPlugin::getName()` → `"R:<name>"`).

---

## 1. Exact engine APIs

### AuxSendPlugin — `plugins/internal/tracktion_AuxSend.h` / `.cpp`
```cpp
static const char* xmlTypeName;                 // == "auxsend"
juce::CachedValue<int>   busNumber;             // ValueTree prop IDs::busNum; referTo default => 0
juce::CachedValue<float> gainLevel;             // IDs::auxSendSliderPos (fader position, NOT dB/gain)
AutomatableParameter::Ptr gain;                 // param "send level", range {0.0f, 1.0f} (fader pos)

void  setGainDb (float newDb);                  // dB in -> converts via decibelsToVolumeFaderPosition
float getGainDb() const;                        // volumeFaderPositionToDB(gain->getCurrentValue())
void  setMute (bool);                           // mute = setGainDb(-100); stores lastVolumeBeforeMute
bool  isMute();                                 // getGainDb() <= -90.0f
int   getBusNumber() const;                     // returns busNumber
juce::String getBusName();                      // edit aux name, else "Bus #<N+1>"
bool  canBeAddedToClip()  override { return false; }   // track-only
bool  canBeAddedToRack()  override { return false; }
```
- **Setting the bus:** `sendPlugin->busNumber = N;` (CachedValue assignment writes `IDs::busNum`,
  using the plugin's undo manager). Do this *before/at* insertion, inside the transaction.
- **Level units:** the UI control should be **dB**. Use `setGainDb(db)` / `getGainDb()`.
  Range: `volumeFaderPositionToDB` returns `[-100, +6]` dB (`tracktion_AudioUtilities.cpp:140–145`:
  `db>-100 ? ... : silence`, max ≈ `+6 dB`). Default fader pos = `decibelsToVolumeFaderPosition(0)` → **0 dB**.
  Clamp the command input to `[-60, +6]` for sanity; treat `<= -90` as muted (matches `isMute()`).

### AuxReturnPlugin — `plugins/internal/tracktion_AuxReturn.h` / `.cpp`
```cpp
static const char* xmlTypeName;                 // == "auxreturn"
juce::CachedValue<int> busNumber;               // IDs::busNum; default 0 (no default arg in referTo)
bool producesAudioWhenNoAudioInput() override { return true; }   // <-- makes return track audible
bool takesAudioInput()  override { return true; }
bool takesMidiInput()   override { return true; }
```
- **Setting the bus:** `returnPlugin->busNumber = N;`
- AuxReturn has **no level/gain of its own** — the return track's own VolumeAndPanPlugin is the
  return strip fader (already exposed as `volumeDb`/`pan` in `trackToVar`).

### Edit — `model/edit/tracktion_Edit.h:552,555` / `.cpp:1755–1791`
```cpp
juce::String getAuxBusName (int bus) const;        // "" if unnamed
void         setAuxBusName (int bus, const juce::String& name);  // truncates to 20 chars; "" removes
```
- Stored in an `AUXBUSNAMES` child of the edit state via `getOrCreateChildWithName(..., &getUndoManager())`
  → **persists with the edit and is undoable.** Empty name removes the entry.

### AudioTrack — `model/tracks/tracktion_AudioTrack.h:62` / `.cpp:263`
```cpp
AuxSendPlugin* getAuxSendPlugin (int bus = -1,
                                 AuxPosition ap = AuxPosition::byBus) const; // -1 == any send
```
- `AuxPosition` enum is in `utilities/tracktion_MiscUtilities.h:125` (`byBus` / `byPosition`).
- Use `track->getAuxSendPlugin(N)` to find an existing send to bus N (avoid duplicate sends to the
  same bus, and to locate the send for `set_send_level` / `remove_send`).

### Insertion (canonical pattern, from `tracktion_EditNodeBuilder.test.cpp:145,151`)
```cpp
auto plugin = edit.getPluginCache().createNewPlugin (AuxSendPlugin::xmlTypeName,   {}); // or AuxReturn
track->pluginList.insertPlugin (plugin, index, nullptr);
```
**MUST** use `edit.getPluginCache().createNewPlugin(xmlTypeName, {})` (the established Mosh rule —
`cmdLoadBuiltin`, MoshOps.cpp:749) so `indexOf` works and no assert fires.

---

## 2. MoshOps commands to add

Header decls go in `MoshOps.h` (next to the plugin block ~line 80); dispatch `if (name == ...)`
lines go in `execute()` (MoshOps.cpp ~line 144); definitions follow the
**validate → beginNewTransaction → mutate → logLine → emitSnapshotInvalidated → okResult/errResult**
shape. Add a small private helpers section.

### Helpers (private, in MoshOps.cpp)
```cpp
int  MoshOps::allocateBusNumber();                 // lowest unused busNumber across all AuxReturn plugins
te::AuxReturnPlugin*  MoshOps::findReturnForBus (int bus);   // scan all tracks' pluginLists
te::AudioTrack*       MoshOps::findReturnTrackForBus (int bus); // track owning that AuxReturn
```
`allocateBusNumber`: collect every `AuxReturnPlugin::busNumber` in the edit (iterate
`te::getAudioTracks(edit)` → `t->pluginList.getPlugins()` → `dynamic_cast<AuxReturnPlugin*>`),
return the smallest `n >= 0` not in the set.

### 2.1 `create_bus`
- **args:** `name` (string, optional → default `"Bus N"`).
- **behaviour:** allocate busNumber via `allocateBusNumber()`; `createAudioTrack(name)`;
  on that track create an `auxreturn` plugin via the cache, set `returnPlugin->busNumber = bus`,
  insert at index 0; `ensureVolumePlugin(track)`; `edit.setAuxBusName(bus, name)`; mark the track as a
  return track (see §3 — set ValueTree property `IDs::mosh_isReturn` or a Mosh-namespaced flag on the
  track state so the snapshot/UI can distinguish it and `allocateBusNumber` stays robust).
- **result data:** `{ busNumber, trackId, name }`.
- Transaction name `"create_bus"`; log + invalidate.

### 2.2 `add_send`
- **args:** `trackId` (source track), `bus` (int) OR `busTrackId`; `db` (optional, default 0).
- **behaviour:** `findTrack(trackId)`; resolve bus (reject if no AuxReturn carries it →
  `errResult("add_send","no such bus")`); if `track->getAuxSendPlugin(bus) != nullptr` →
  `errResult` "send already exists" (or no-op update its level — pick reject for clarity).
  Create `auxsend` via cache, `send->busNumber = bus`, **append** to pluginList
  (`index = pluginList.getPlugins().size()` so the send is post-everything / post-fader),
  `send->setGainDb(jlimit(-60, 6, db))`.
- **result data:** `{ trackId, bus, index, db }`.

### 2.3 `set_send_level`
- **args:** `trackId`, `bus`, `db`.
- **behaviour:** `auto* s = track->getAuxSendPlugin(bus)`; if null → err; `s->setGainDb(jlimit(...))`.
- Mirrors `cmdSetTrackVolume` exactly.

### 2.4 `remove_send`
- **args:** `trackId`, `bus`.
- **behaviour:** `auto* s = track->getAuxSendPlugin(bus)`; if null → err; `s->deleteFromParent();`
  (the established Mosh remove call — `cmdRemovePlugin`, MoshOps.cpp:808 uses `plugin->deleteFromParent()`,
  NOT `pluginList.removePlugin`).

### 2.5 `remove_bus`
- **args:** `bus`.
- **behaviour:** find the return track for the bus; **first** scan all tracks and
  `deleteFromParent()` every AuxSend with that busNumber (orphan-send cleanup); `edit.setAuxBusName(bus, "")`
  (removes the name entry); `edit.deleteTrack(returnTrack)` (clean — see `cmdRemoveTrack`,
  MoshOps.cpp:216 uses `eng.edit().deleteTrack(track)`). Guard: refuse if `bus < 0`.

### 2.6 `rename_bus` (optional, cheap)
- **args:** `bus`, `name`. **behaviour:** `edit.setAuxBusName(bus, name)` and `track->setName(name)`.

All six follow the same envelope. `create_bus`, `add_send`, `set_send_level`, `remove_send`,
`remove_bus`, `rename_bus` are **all undoable** (they mutate edit/plugin state) → keep the
`beginNewTransaction` + `emitSnapshotInvalidated()`.

---

## 3. Snapshot additions

Two builders touch this: **`trackToVar`** (per-track send list + isReturn flag) and **`snapshot`**
(top-level `buses[]` array). No change to `clipToVar`/`transportToVar`.

### 3.1 In `trackToVar(te::AudioTrack& t, int index)` (MoshOps.cpp:1644)
Add after the mixer block:
```cpp
// Sends owned by this track (post-fader aux sends).
juce::Array<var> sends;
for (auto* p : t.pluginList.getPlugins())
    if (auto* s = dynamic_cast<te::AuxSendPlugin*> (p))
    {
        auto* so = new DynamicObject();
        so->setProperty ("bus", s->getBusNumber());
        so->setProperty ("db",  s->getGainDb());          // dB, [-100..+6]
        so->setProperty ("mute", s->isMute());
        sends.add (var (so));
    }
o->setProperty ("sends", sends);

// Is this an aux-return track? (flag set in create_bus on the track state)
const bool isReturn = t.state.hasProperty (ids::mosh_isReturn);  // or detect an AuxReturn plugin
o->setProperty ("isReturn", isReturn);
if (isReturn)
    if (auto* r = firstAuxReturnOn (t))                   // dynamic_cast scan helper
        o->setProperty ("returnBus", r->busNumber.get());
```
**Robust alternative to a flag:** detect `isReturn` by scanning the track's pluginList for an
`AuxReturnPlugin` (no new persisted property needed). Prefer this — it needs no migration and
survives save/reload automatically. Use the explicit `mosh_isReturn` flag only if you want a
return track with no AuxReturn yet to still read as a return (not needed for v0).

### 3.2 In `snapshot()` (MoshOps.cpp:1605)
Add a top-level `buses[]` so the UI can render return strips and the send-target menu without
re-deriving from tracks:
```cpp
Array<var> buses;
for (auto* t : te::getAudioTracks (edit))
    if (auto* r = firstAuxReturnOn (*t))
    {
        auto* bo = new DynamicObject();
        const int bus = r->busNumber.get();
        bo->setProperty ("bus", bus);
        bo->setProperty ("name", edit.getAuxBusName (bus).isNotEmpty()
                                     ? edit.getAuxBusName (bus) : ("Bus " + String (bus + 1)));
        bo->setProperty ("trackId", t->itemID.toString());
        buses.add (var (bo));
    }
root->setProperty ("buses", buses);
```

### 3.3 Field summary (types for `ui/src/types.ts`)
- `Track.sends?: { bus: number; db: number; mute: boolean }[]`
- `Track.isReturn?: boolean`
- `Track.returnBus?: number`
- `Snapshot.buses?: { bus: number; name: string; trackId: string }[]`

---

## 4. UI plan (keep current visual style)

Files: `ui/src/components/Mixer.tsx` (primary), `ui/src/types.ts`, `ui/src/store.ts` (nothing
new needed — `exec()` already carries everything), `ui/src/styles.css` (reuse `.strip`, `.pan`,
`.mixbtn`, `.strip-db` tokens — no new visual language).

### 4.1 Mixer view (the natural home)
- **Top bar of the mixer:** an `+ Bus` button → `exec("create_bus", { name: "Reverb" })`.
- **Return strips:** in `Mixer.tsx` the strip list currently does
  `snapshot.tracks.map(t => <ChannelStrip ...>)`. Render **regular tracks first**, then a thin
  divider, then tracks where `t.isReturn` as **ReturnStrip** components (visually identical
  `.strip` but with a small `R` badge in `.strip-name` and a different accent border). A return
  strip reuses `set_track_volume/pan/mute/solo` (it *is* a track) plus a `× Bus` button →
  `exec("remove_bus", { bus: t.returnBus })`.
- **Send controls on each source `ChannelStrip`:** under the existing fader/M/S row, add a compact
  **"sends" sub-section**: for every bus in `snapshot.buses` not already in `track.sends`, an inline
  `+` chip to add (`exec("add_send", { trackId, bus, db: 0 })`); for every entry in `track.sends`,
  a small horizontal **send knob/slider** (reuse `.pan` slider styling) labelled with the bus name,
  bound to `set_send_level` (`onChange → exec("set_send_level",{trackId,bus,db})`), with a tiny mute
  dot (`set_send_level` to `-100`, or a dedicated toggle) and an `×` to `remove_send`. Show the dB
  in a `.strip-db`-style caption. Do **not** show sends-to-self on a return strip (skip buses whose
  `trackId === t.id`) to avoid trivial feedback loops in the UI.
- A source track must not send to a bus that doesn't exist → the `+` chips are derived from
  `snapshot.buses`, so the menu is always valid.

### 4.2 Arrangement view (light touch)
- Optional: in the track header (Arrangement.tsx) show a tiny "→N" badge when `track.sends.length>0`,
  read-only, linking attention to the mixer. No new commands. Keep arrange uncluttered; sends are a
  mixer concept. This is optional polish, not required for the gate.

### 4.3 Style
- No new colors beyond the existing CSS tokens; the return strip's accent reuses the
  master-strip accent or the solo accent at low opacity. Keep the mono/condensed label style.

---

## 5. Self-test plan (`src/app/SelfTest.cpp`)

`--selftest` runs with **`eng.hasAudio() == false`** (confirmed: SelfTest.cpp:162–165 guards the
playback-context check). The **routing/state layer is fully verifiable headless**; only the
**audible mix of the wet return** needs live audio.

### Verifiable headless (add a new section; each `check(...)` increments the count):
1. `create_bus {name:"Reverb"}` → ok; `data.busNumber == 0`; `data.trackId` valid;
   `snapshot.buses.length == 1`; the bus's track has `isReturn == true`, `returnBus == 0`.
2. The return track carries an `auxreturn` plugin: scan
   `firstTrack-with-isReturn.plugins[]` for `type == "auxreturn"`.
3. Second `create_bus {name:"Delay"}` → `busNumber == 1` (allocator increments).
4. `create_track {name:"Gtr"}` then `add_send {trackId:gtr, bus:0, db:-6}` → ok;
   that track's snapshot `sends` has one entry `{bus:0, db≈-6}`.
5. `add_send` to the same bus again → err ("send already exists") OR idempotent — assert chosen behaviour.
6. `add_send {bus:99}` (no such return) → err.
7. `set_send_level {trackId, bus:0, db:-3}` → snapshot send `db ≈ -3` (within 0.2 dB; fader-curve roundtrip).
8. Mute via `set_send_level db:-100` → snapshot `sends[0].mute == true`.
9. `remove_send {trackId, bus:0}` → snapshot `sends.length == 0`.
10. **Bus-name persistence + undo:** after `create_bus`, `save` then `reload` → `snapshot.buses[0].name == "Reverb"`,
    the AuxReturn survives, and the source track's send (re-add before save) survives reload.
11. **Undo/redo:** `add_send` then `undo` → send gone; `redo` → send back.
    `create_bus` then `undo` → `buses.length` back to prior, return track removed.
12. `remove_bus {bus:0}` → return track gone from `snapshot.tracks`, `buses` shrinks, and any
    orphan sends to bus 0 on other tracks are also gone (assert `sends.length == 0` on the source).
13. JSONL records `create_bus`, `add_send`, `set_send_level`, `remove_send`, `remove_bus`
    (reuse the `logsCommand(...)` helper pattern at SelfTest.cpp:204).

### Needs live audio / hardware (cannot assert non-trivially headless — document, don't fake):
- **The actual wet signal arriving at the return** (the AuxSend→ReturnNode graph edge only
  carries audio when a playback graph is built with a real device; headless there is no buffer to inspect).
- **Post-fader behaviour / send level audibly affecting wet amount.**
- **Mute-source-track-still-feeds-send** semantics (engine's `shouldProcessAuxSendWhenTrackIsMuted`).
- These mirror the existing honest gaps (e.g., neural A/B, live meters). Verify them with the GUI
  + a reverb on the return + ears, noted in PROGRESS.md as a manual check. A future automated path:
  the offline-render graph test the engine itself uses (`runAuxSend` / `runTrackDestinationRendering`
  in `tracktion_EditNodeBuilder.test.cpp`) could be adapted as a Catch2 render test that bounces a
  send→return chain to a file and asserts non-silence — that IS headless-capable via
  `Renderer::renderToFile` (the same path `export_audio` uses) and is the recommended way to close
  the audible gap without hardware. Strongly consider adding one bounce-based Catch2 test.

---

## 6. Risks / gotchas

1. **`createNewPlugin` cache rule (asserts):** always
   `edit.getPluginCache().createNewPlugin(xmlTypeName, {})` then `insertPlugin` — never
   `PluginManager::createNewPlugin`. Same trap documented for Stage 3 (`indexOf` fails → assert).
2. **busNumber must be set inside the transaction, with an undo manager.** `CachedValue<int>
   busNumber` writes via the plugin's `getUndoManager()`. Assign `plugin->busNumber = N;` after
   creation but the change must land inside `beginNewTransaction` so undo reverts it atomically.
3. **No engine-side bus limit / registry.** Mosh owns uniqueness. `allocateBusNumber()` must scan
   live AuxReturn plugins (not just `buses[]` cache) so reload/undo never collide. Two AuxReturns
   on the same busNumber both receive the bus (engine allows it) — `create_bus` must prevent it.
4. **Feedback loops.** A send on a return track targeting its own bus (or a cycle A→B→A) will feed
   back. The engine does not guard this. Mosh should: (a) UI hides self-sends; (b) `add_send` could
   reject a send whose source track is itself a return for the *same* bus. For v0, the UI guard
   (skip `bus.trackId === track.id`) is sufficient; note cross-bus cycles as a known sharp edge.
5. **`canBeAddedToClip()/canBeAddedToRack()` are false** for both aux plugins — they live only in a
   track's `pluginList`. Don't attempt clip/rack insertion.
6. **Send level units.** The send's `gain` param range is `{0,1}` **fader position**, NOT dB and NOT
   linear gain. UI/commands must go through `setGainDb`/`getGainDb`. Snapshot stores dB. `isMute()`
   threshold is `-90 dB`; `setMute` drives to `-100 dB` and remembers `lastVolumeBeforeMute`.
7. **Aux bus name truncation.** `setAuxBusName` truncates to 20 chars (`Edit.cpp:1765`). UI should cap
   the input length so the round-trip is stable.
8. **Return track detection on reload.** Prefer detecting `isReturn` by the presence of an
   `auxreturn` plugin (survives save/reload with zero migration) over a custom persisted flag.
9. **`remove_bus` orphan sends.** Deleting the return track does NOT remove sends pointing at its
   bus; those sends become silent orphans (their bus has no return). `remove_bus` must explicitly
   sweep and remove orphan AuxSends, else the snapshot shows dangling sends.
10. **Plugin-list ordering / position.** Append sends to the END of `pluginList` so they are
    post-fader (after the VolumeAndPanPlugin). If inserted before volume, the send becomes pre-fader
    — a valid feature later (`pre`/`post` arg) but not v0 default.
11. **RT-safety:** none of these commands touch the audio thread directly; graph rebuild on
    snapshot change is the engine's job. AuxSend/AuxReturn `applyToBuffer` are no-ops (the routing
    is in the graph nodes), so no allocation concerns from our side.
12. **Headless honesty:** do not assert wet audio in `--selftest`; assert state only. Use a Catch2
    bounce test (§5) for the audio claim.

---

## 7. Recommended implementation order (smallest verifiable slice first)

1. **Helpers + snapshot read-only:** add `firstAuxReturnOn`, `allocateBusNumber`,
   `findReturnForBus`; extend `trackToVar` (`sends[]`, `isReturn`) and `snapshot` (`buses[]`).
   No commands yet — but a manually-XML-injected AuxReturn would already show in the snapshot.
2. **`create_bus`** + self-test checks 1–3, 10 (persistence) — proves bus allocation, naming,
   return-track creation, save/reload.
3. **`add_send` + `set_send_level`** + checks 4–8 — proves send insertion, level dB round-trip, mute.
4. **`remove_send` + `remove_bus`** + checks 9, 11, 12 (undo/redo, orphan sweep) — proves teardown.
5. **`rename_bus`** (trivial) — optional.
6. **UI:** `types.ts` fields → Mixer `+ Bus` + return strips → per-strip send knobs/chips. Rebuild
   the React bundle (swappability: C++ binary must stay byte-identical — Stage 2 rule).
7. **(Recommended) Catch2 bounce test** rendering a send→return chain to a WAV and asserting
   non-silence, closing the audible gap without hardware. Manual GUI + ears + reverb-on-return as
   the final live confirmation, logged in PROGRESS.md.

After each slice: `Mosh --selftest` green, JSONL shows the new commands, commit.
