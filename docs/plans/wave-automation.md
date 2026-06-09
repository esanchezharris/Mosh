# Wave 7 — Parameter Automation (curves + lanes + draw)

Automate `AutomatableParameter` values over time for **track volume**, **track pan**, and **plugin params**.
Every mutation is a MoshOps command (validate → `beginNewTransaction` → mutate via `te::` → `logLine` → `emitSnapshotInvalidated` → `okResult`/`errResult`). The curve UI is an automation lane under each track, reusing the canonical `time.ts` mapping. Pure tool/selection state stays UI-local.

This plan is grounded in the pinned clone at
`.cpm-cache/_fc/tracktion_engine-src/modules/tracktion_engine`. All signatures below are quoted from those headers.

---

## 0. Key engine facts established by reading the clone

**Parameter addressing.** Every automatable thing is an `AutomatableEditItem` (base of `Plugin`). From
`model/automation/tracktion_AutomatableEditItem.h`:

```cpp
juce::Array<AutomatableParameter*> getAutomatableParameters() const;
int                                getNumAutomatableParameters() const;
AutomatableParameter::Ptr          getAutomatableParameter (int index) const;     // returns automatableParams[index]
AutomatableParameter::Ptr          getAutomatableParameterByID (const juce::String& paramID) const;
```

- **Track volume / pan** live on the track's `VolumeAndPanPlugin`. From
  `plugins/internal/tracktion_VolumeAndPan.h`: `AutomatableParameter::Ptr volParam, panParam;` (public).
  We reach the plugin with the existing helper `ensureVolumePlugin(track)` (volume) and likewise its `panParam`.
  In the plugin's `pluginList`, `volParam` is `getAutomatableParameter(0)` and `panParam` is `(1)` — but **do not assume the index**; address by the public `volParam`/`panParam` members for track vol/pan, and by index for generic plugin params (matching today's `set_plugin_param` which uses `getAutomatableParameter(pi)`).
- **Master vol/pan**: `edit.getMasterVolumePlugin()` returns a `VolumeAndPanPlugin::Ptr` → same `volParam`/`panParam`.
- **Generic plugin param i**: `plugin->getAutomatableParameter(i)` (already used in `cmdSetPluginParam`, MoshOps.cpp:837).

**The curve.** From `tracktion_AutomatableParameter.h`:
```cpp
AutomationCurve& getCurve() const noexcept;
bool             isAutomationActive() const;       // true if automation OR a modifier is active
bool             hasAutomationPoints() const noexcept;   // getCurve().getNumPoints() > 0
const juce::NormalisableRange<float> valueRange;   // real-units range of the param
juce::Range<float> getValueRange() const;          // valueRange.getRange()
float getCurrentValue() const noexcept;
float getCurrentNormalisedValue() const noexcept;  // valueRange.convertTo0to1(currentValue)
```
There is **no `setAutomationActive(bool)`** in this clone. `isAutomationActive()` is read-only and derived from point count + modifiers. So "enable automation" is implicit: a curve becomes active once it has points. We will **not** add an `enable_automation` command (it has no setter to call); instead a curve is "armed" by having ≥1 point, and "cleared"/disarmed by `clear_automation`. (A `bypass` flag exists on the curve — see below — if we later want a non-destructive disable.)

**AutomationCurve API** (`model/automation/tracktion_AutomationCurve.h`). Prefer the generic `EditPosition` overloads:
```cpp
int   getNumPoints() const noexcept;
AutomationPoint getPoint (int index) const noexcept;           // { EditPosition time; float value; float curve; }
EditPosition    getPointPosition (int index) const noexcept;
float getPointValue (int index) const noexcept;
float getPointCurve (int index) const noexcept;                // -1..+1 bezier tension, 0 = linear

int   addPoint   (EditPosition, float value, float curve, juce::UndoManager*);   // returns index of new point
void  removePoint(int index, juce::UndoManager*);
void  setPointValue (int index, float newValue, juce::UndoManager*);
void  setCurveValue (int index, float newCurve, juce::UndoManager*);
void  setPointPosition (int index, EditPosition, juce::UndoManager*);            // @internal but public
int   movePoint (int index, EditPosition, float newValue, std::optional<juce::Range<float>> valueLimits,
                 bool removeInterveningPoints, juce::UndoManager*);              // returns possibly-new index
void  clear (juce::UndoManager*);

float getValueAt (EditPosition, float defaultValue) const;
const TimeBase timeBase;   // enum { time, beats }
```
Free helpers (same header): `float getValueAt (AutomatableParameter&, TimePosition);` and `EditTimeRange getFullRange (const AutomationCurve&);`.

**Units / ranges — VERIFIED, this is the load-bearing gotcha:**
- Point **time** is an `EditPosition`. A bare `TimePosition` converts implicitly (`EditTime.h:73`). **All parameter curves are created with `TimeBase::time`** — confirmed in `tracktion_AutomatableParameter.cpp:192` (`AutomationCurveSource` ctor: `AutomationCurve::TimeBase::time`). So points are stored in **seconds**, and `createPosition` (AutomationCurve.cpp:332) interprets the raw `t` as seconds. ⇒ We pass `TimePosition::fromSeconds(x)`; the seconds-based command surface (the swappable seam) maps 1:1. Beats are a view-side derivation in `time.ts`, exactly like clips.
- Point **value** is in the parameter's **real units**, NOT 0–1, and NOT dB for vol/pan. `addPoint`/`setPointValue` take the raw value; `getValueAt`/`getPointValue` return raw value. The normalised 0–1 mapping is `param->valueRange.convertFrom0to1(n)` / `convertTo0to1(v)` (the existing `set_plugin_param` path does this).
  - **VolumeAndPanPlugin `volParam` is in *slider position* units** (≈ 0..~1.06), NOT dB — confirmed by `tracktion_VolumeAndPan.cpp` (`volumeFaderPositionToDB` / `decibelsToVolumeFaderPosition`) and the header comment `// NB the units used here are slider position`. `panParam` is roughly -1..+1.
  - **Decision:** the command surface speaks **normalised 0–1** for *every* automation point value (uniform across vol/pan/plugin params; no dB/slider-pos leaking across the seam). The handler converts with `param->valueRange.convertFrom0to1(value01)` before `addPoint`, and the snapshot emits `convertTo0to1(rawValue)` back. This keeps the UI dimensionless (lane Y = 0..1) and matches the swappable-seam rule. The UI can label vol/pan lanes with a derived dB/percent readout for humans, computed view-side.
- `AutomationPoint` ctor asserts `curve ∈ [-1,1]` and `time ≥ 0` — clamp both before calling.

**Persistence.** The curve is a child `ValueTree` (`IDs::AUTOMATIONCURVE`) under the parameter/plugin state; `addPoint` with the Edit's `UndoManager` writes into the Edit tree, so it saves/reloads via the existing `EditFileOperations` path. `checkParenthoodStatus` (AutomationCurve.cpp:373) auto-attaches the curve tree when the first point is added and detaches it when the last is removed — so empty curves cost nothing in the saved file.

---

## 1. Parameter target addressing (one resolver helper)

Add a private helper that resolves a target descriptor → `te::AutomatableParameter::Ptr`, used by every automation command. Target is identified by the args:

| target kind | args | resolution |
|---|---|---|
| track volume | `{ trackId, target:"volume" }` | `ensureVolumePlugin(*track)->volParam` |
| track pan | `{ trackId, target:"pan" }` | `ensureVolumePlugin(*track)->panParam` |
| plugin param | `{ trackId, index, paramIndex }` | `findPlugin(trackId,index)->getAutomatableParameter(paramIndex)` |
| master volume | `{ target:"master_volume" }` | `edit.getMasterVolumePlugin()->volParam` |
| master pan | `{ target:"master_pan" }` | `edit.getMasterVolumePlugin()->panParam` |

```cpp
// MoshOps.h (private)
te::AutomatableParameter::Ptr resolveParam (const juce::var& args, juce::String& errOut);
```
Behaviour: returns nullptr + sets `errOut` on any miss (no track / bad index / null master). For plugin params it reuses `findPlugin` and validates `paramIndex` against `getNumAutomatableParameters()` exactly like `cmdSetPluginParam`. This single resolver is the only place that knows the vol/pan-vs-plugin distinction, so all five automation commands stay tiny.

A symmetric **string key** is emitted in the snapshot so the UI can echo the same descriptor back without ambiguity: `paramKey = "vol" | "pan" | "p{index}.{paramIndex}"`. The UI never parses it; it just carries the `{trackId,target}` / `{trackId,index,paramIndex}` object it already has.

---

## 2. MoshOps commands to add

Five commands. Each: `resolveParam` → `beginNewTransaction` → mutate `param->getCurve()` with `&undoManager()` → `logLine` → `emitSnapshotInvalidated` → result. Mirror the existing `cmdSetPluginParam` style (MoshOps.cpp:828).

### 2.1 `add_automation_point`
Args: `{ <target...>, time: <seconds>, value: <0..1>, curve?: <-1..1, default 0> }`
```cpp
juce::var MoshOps::cmdAddAutomationPoint (const juce::var& args)
{
    juce::String err;
    auto p = resolveParam (args, err);
    if (p == nullptr) return errResult ("add_automation_point", err);

    const double  t   = juce::jmax (0.0, (double) args.getProperty ("time", 0.0));
    const float   v01 = juce::jlimit (0.0f, 1.0f, (float)(double) args.getProperty ("value", 0.0));
    const float   c   = juce::jlimit (-1.0f, 1.0f, (float)(double) args.getProperty ("curve", 0.0));
    const float   real = p->valueRange.convertFrom0to1 (v01);

    undoManager().beginNewTransaction ("add_automation_point");
    const int idx = p->getCurve().addPoint (te::TimePosition::fromSeconds (t), real, c, &undoManager());
    logLine ("add_automation_point", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* d = new juce::DynamicObject(); d->setProperty ("index", idx);
    return okResult ("add_automation_point", juce::var (d));
}
```

### 2.2 `set_automation_point`
Args: `{ <target...>, index, time?: <seconds>, value?: <0..1>, curve?: <-1..1> }` — edit an existing point in place (used by drag-to-move a node).
- If `value` present: `setPointValue(index, convertFrom0to1(value01), &um)`.
- If `curve` present: `setCurveValue(index, clamp(curve,-1,1), &um)`.
- If `time` present: prefer `movePoint(index, TimePosition::fromSeconds(t), <keep value or new value>, valueRange, /*removeIntervening*/false, &um)` so the array stays sorted; return the (possibly changed) new index in `data`. If only `value`/`curve` change (no time), use the cheaper `setPointValue`/`setCurveValue` (no re-sort).
- Validate `index ∈ [0, getNumPoints())` → else `errResult`.

### 2.3 `remove_automation_point`
Args: `{ <target...>, index }` → validate range → `getCurve().removePoint(index, &um)`.

### 2.4 `clear_automation`
Args: `{ <target...> }` → `getCurve().clear(&um)` (removes all points; `checkParenthoodStatus` detaches the curve tree). Returns ok even if already empty.

### 2.5 (optional, deferred) `simplify_automation`
Args: `{ <target...>, strength?:1, t0?, t1? }` → free fn `int simplify(AutomationCurve&, int strength, EditTimeRange, juce::Range<float>, UndoManager*)`. Nice for "thin out" after freehand draw but not required for the gate; list it as a follow-up so freehand draw can be reduced server-side.

### Dispatch (MoshOps.cpp `execute`, alongside the others ~line 166)
```cpp
if (name == "add_automation_point")    return cmdAddAutomationPoint (args);
if (name == "set_automation_point")    return cmdSetAutomationPoint (args);
if (name == "remove_automation_point") return cmdRemoveAutomationPoint (args);
if (name == "clear_automation")        return cmdClearAutomation (args);
```
Declarations go in `MoshOps.h` next to the Stage 6 block.

**Batch note (freehand draw):** the pencil tool produces many points. Two options:
1. Keep one command per point (simplest; each is its own undo step) — but that floods the undo stack and re-snapshots N times.
2. **Recommended:** add a `set_automation_points` (plural) command: `{ <target...>, points:[{time,value,curve?}...], replaceRange?:{t0,t1} }` that, inside **one** transaction, optionally `removePoints(EditTimeRange{t0,t1}, &um)` then loops `addPoint(...)`, logs once, snapshots once. This gives a single undo step per pencil stroke and one snapshot refresh — much better UX and far fewer bridge round-trips. (`removePoints(EditTimeRange, UndoManager*)` exists in the header.) Implement this as part of the draw slice.

---

## 3. Snapshot additions

Automation is per-parameter, so attach it inside `trackToVar` (for vol/pan) and `pluginToVar` (for plugin params), both in MoshOps.cpp. Keep payloads small — serialize **only params that have points** (`hasAutomationPoints()`), so empty sessions are unchanged byte-for-byte.

### 3.1 New shared serializer
```cpp
// returns null var if the curve is empty; else { points:[{t,v,c}], active:bool }
juce::var MoshOps::automationToVar (te::AutomatableParameter& p)
{
    auto& curve = p.getCurve();
    const int n = curve.getNumPoints();
    if (n == 0) return {};                       // omit empty curves entirely
    juce::Array<juce::var> pts;
    auto& ts = eng.edit().tempoSequence;
    for (int i = 0; i < n; ++i)
    {
        auto* po = new juce::DynamicObject();
        po->setProperty ("t", te::toTime (curve.getPointPosition (i), ts).inSeconds()); // seconds
        po->setProperty ("v", p.valueRange.convertTo0to1 (curve.getPointValue (i)));    // 0..1
        po->setProperty ("c", curve.getPointCurve (i));                                 // -1..1
        pts.add (juce::var (po));
    }
    auto* o = new juce::DynamicObject();
    o->setProperty ("points", pts);
    o->setProperty ("active", p.isAutomationActive());
    return juce::var (o);
}
```
> Use `toTime(getPointPosition(i), tempoSequence).inSeconds()` rather than the deprecated `getPointTime(i)` so it is correct regardless of `timeBase` (defensive; today it is always `time`).

### 3.2 Where it lands
- **`trackToVar`** (MoshOps.cpp:1644): after the existing `volumeDb`/`pan` block, when the track has a volume plugin, add:
  ```cpp
  if (auto* vp = t.getVolumePlugin())
  {
      auto va = automationToVar (*vp->volParam);
      auto pa = automationToVar (*vp->panParam);
      if (! va.isVoid() || ! pa.isVoid())
      {
          auto* autoObj = new juce::DynamicObject();
          if (! va.isVoid()) autoObj->setProperty ("volume", va);
          if (! pa.isVoid()) autoObj->setProperty ("pan", pa);
          o->setProperty ("automation", juce::var (autoObj));   // track-level automation map
      }
  }
  ```
- **`pluginToVar`** (MoshOps.cpp:1564): in the per-param loop (line 1589), add an `automation` field on the param object when non-empty:
  ```cpp
  auto a = automationToVar (*param);
  if (! a.isVoid()) po->setProperty ("automation", a);
  ```
- **master** block in `snapshot()` (MoshOps.cpp:1634): optionally add `master.automation = { volume?, pan? }` the same way. (Lower priority; the gate can ship with track + plugin first.)

### 3.3 TypeScript types (`ui/src/types.ts`)
```ts
export type AutoPoint = { t: number; v: number; c: number };          // t=seconds, v=0..1, c=-1..1
export type AutoCurve = { points: AutoPoint[]; active: boolean };
export type TrackAutomation = { volume?: AutoCurve; pan?: AutoCurve };
// Track:   automation?: TrackAutomation;
// PluginParam: automation?: AutoCurve;
```
Add `automation?` to `Track` and to `PluginParam`. No schemaVersion bump strictly required (additive, optional fields), but bump `schemaVersion` to `2` for honesty and gate it in the harness.

---

## 4. UI plan (keep the current visual style)

All new UI is **view-local** (tool selection, which lanes are expanded) and routes mutations through `exec(...)`. Reuse `time.ts` (`pxPerSec`, `snapTime`, `meterFrom`) — identical mapping to clips, so points line up with the grid and ruler.

### 4.1 Store additions (`ui/src/store.ts`)
- `autoTool: "off" | "draw"` (+ `setAutoTool`) — pencil mode toggle. Default `"off"`.
- `expandedLanes: Set<string>` keyed by `paramKey` (`"<trackId>:vol"`, `"<trackId>:pan"`, `"<trackId>:p<idx>.<paramIdx>"`) (+ `toggleLane`). Pure view state; never crosses the bridge (swappable-seam rule).
- `selectedAutoTarget` (optional) for the rack "show automation" affordance.

### 4.2 New component `ui/src/components/AutomationLane.tsx`
A `<canvas>` (or absolutely-positioned SVG/divs) sized `rulerWidth × laneSubHeight` rendered **under** a track's clip lane inside `Arrangement.tsx`'s `.lanes` block. Props: `{ trackId, target: {kind, index?, paramIndex?}, curve: AutoCurve | undefined, width, height }`.
- **Render:** map each point `(t,v)` → `(t*pxPerSec, (1-v)*height)`. Draw segments between consecutive points; honour `c` (bezier tension) by sampling `getValueAt`-equivalent client-side, or v0: straight segments + a small node handle per point (curve tension is an enhancement). Draw node dots; the baseline at `v=0`.
- **Interactions (all → `exec`):**
  - Click empty lane → `add_automation_point` `{ ...target, time: snapTime(x/pxPerSec), value: 1-(y/height) }`.
  - Drag a node → throttled `set_automation_point` `{ ...target, index, time, value }` (optimistic local preview like clip drag; reconcile on `snapshot_invalidated`).
  - Right-click / alt-click a node → `remove_automation_point` `{ ...target, index }`.
  - With `autoTool==="draw"`: pointer-drag paints a path; on pointer-up emit **one** `set_automation_points` (the batch command from §2) with the sampled points and `replaceRange` covering the dragged X-span. One undo step, one snapshot.
- **Style:** reuse existing CSS tokens; add `.auto-lane`, `.auto-node`, `.auto-seg`, `.auto-lane-label` in `styles.css` matching the muted line/accent palette already used for `.playhead`, `.gl`, `.loopregion`. The lane sits visually as a thin strip beneath the clips with the same left-origin and gridlines.

### 4.3 Wiring into `Arrangement.tsx`
- In the per-track `.lane` block (line ~169), when `expandedLanes` has the track's vol/pan key, render `<AutomationLane>` strips and grow that track's lane height by `expandedCount * subLaneHeight` (the lane already uses `top: row*LANE_H`; switch to a running offset accumulator so expanded lanes push later tracks down — small refactor of the absolute `top` to a cumulative layout, or render lanes in a flex column).
- **Toolbar:** add an "Auto" pencil toggle next to Move/Split (`setAutoTool`), styled like the existing tool buttons.
- **TrackHeader:** add a small "A" button (like the `M`/`S` mix buttons) that calls `toggleLane(trackId,"vol")` / a tiny menu for vol vs pan; show a filled state when that param has points (`track.automation?.volume`).

### 4.4 Plugin-param automation (Rack)
In `ui/src/components/Rack.tsx`, next to each plugin param, add a small "automate" toggle that calls `toggleLane("<trackId>:p<idx>.<paramIdx>")`; the corresponding `<AutomationLane>` renders under that track in the arrange view (or inline in the rack as a mini-curve). v0 gate can cover **track vol/pan**; plugin-param lanes reuse the identical component with a different `target`, so they are a thin follow-up, not new infrastructure.

> Mixer view: optionally show an "automated" dot on faders whose param has points (`track.automation`). Read-only indicator; editing stays in the arrange lane. Not gate-critical.

---

## 5. Self-test plan (`src/app/SelfTest.cpp`) — headless vs hardware

**`--selftest` runs with `eng.hasAudio()==false`.** Automation **point data and curve evaluation are pure model state** in the Edit `ValueTree`, independent of any audio device. So the *entire command + snapshot + persistence surface is verifiable headless* — only the *audible application* of automation during playback needs live audio.

Add a Wave-7 block after the existing waves (mirror the `cmd(ops, ...)`/`check(...)` style, MoshOps.cpp lines 230–340 region). Headless checks:
1. Create track + a wave clip (reuse existing setup).
2. `add_automation_point {trackId, target:"volume", time:0.0, value:1.0}` → `ok`; `data.index == 0`.
3. `add_automation_point {..., time:2.0, value:0.0}` → `ok`.
4. Snapshot: `tracks[0].automation.volume.points.length == 2`; points sorted by `t`; `points[0].v≈1`, `points[1].v≈0` (assert within 1e-3 after the 0–1 round-trip through `convertFrom0to1`→`convertTo0to1`; vol slider-pos range is monotonic so endpoints survive).
5. `set_automation_point {..., index:1, value:0.5}` → snapshot `points[1].v≈0.5`.
6. `set_automation_point {..., index:0, time:1.0}` (move) → snapshot point still present, `t≈1.0`, still 2 points, still sorted.
7. `remove_automation_point {..., index:1}` → snapshot `points.length == 1`.
8. **Curve evaluation (no audio needed):** read the curve directly is not exposed via snapshot mid-time, but we *can* verify via a second param. Simpler: assert `clear_automation` empties it → `tracks[0].automation` omits `volume` (curve detached). 
9. **Plugin-param path:** load a builtin (e.g. `eq` via `load_builtin`), `add_automation_point {trackId, index:<pluginIdx>, paramIndex:0, time:0, value:0.25}`, snapshot `plugins[i].params[0].automation.points[0].v≈0.25`.
10. **Pan + master:** `target:"pan"` and `target:"master_volume"` each add a point and appear in the snapshot (`tracks[0].automation.pan`, `master.automation.volume`).
11. **Undo/redo:** after `add_automation_point` then `undo` → snapshot has no `automation.volume`; `redo` → it returns. (Confirms the curve mutation joined the transaction.)
12. **Persistence:** `save` then `reload` → automation points survive (proves the curve tree is in the Edit tree and saved by `EditFileOperations`).
13. **Validation/negatives:** bad `paramIndex`, missing `trackId`, `index` out of range → `errResult` (`ok==false`).
14. **Schema:** `schemaVersion == 2` (if bumped).

Bump the headline count (e.g. `89/89` → `~104/104`) once the block lands.

**Needs live audio / hardware (NOT verifiable headless — state explicitly):**
- That automation **audibly modulates** the signal during playback (volume sweep heard, pan moves) — requires a real `AudioIODevice`; CoreAudio HAL has been flaky this session. The render graph reads the curve via `AutomationIterator`/`updateParameterStreams` only when a playback context is allocated.
- **Automation *recording*** (writing points by moving a fader while playing, `isCurrentlyRecording`/`startRecordingStatus`) — needs the transport running with audio. Not in scope for this wave; the draw/pencil path is the headless-friendly authoring method. Note it as a future hardware-gated wave.
- A `--demo7` visual screenshot of the lane (manual, like prior demos) — not part of headless CI.

---

## 6. Risks / gotchas

1. **Value units (the big one):** curve points are in **real param units** — slider-position for vol (≈0..1.06), ≈-1..1 for pan, plugin-native for params — **never dB, never pre-normalised**. Always go through `param->valueRange.convertFrom0to1 / convertTo0to1`. Mismatch here silently puts points at the wrong height. The command surface is normalised 0–1 to keep the seam clean.
2. **No `setAutomationActive` setter in this clone.** Don't add `enable_automation` expecting a toggle — `isAutomationActive()` is read-only. Activation is implicit (≥1 point). If a non-destructive disable is wanted later, the curve has `juce::CachedValue<AtomicWrapper<bool>> bypass;` (public on `AutomationCurve`) — could back a `bypass_automation` command. Out of scope now.
3. **`AutomationPoint` asserts:** ctor `jassert(c ∈ [-1,1])` and `jassert(time ≥ 0)`. Clamp `curve` and `time` in the handler **before** calling `addPoint`, or a debug build asserts.
4. **TimeBase assumption:** verified all param curves are `TimeBase::time` (AutomatableParameter.cpp:192), so seconds in/out is correct. Still serialize via `toTime(getPointPosition(i), tempoSequence)` (not deprecated `getPointTime`) to stay correct if a future curve is beats-based. Mixing time bases asserts in `operator<` / `movePoint`.
5. **`movePoint` may reindex.** It returns the new index after re-sorting; the UI must use the returned index (in `data`) for the next drag delta, or read it back from the next snapshot. Don't cache the old index across a time move.
6. **Snapshot size / churn:** a freehand stroke can add hundreds of points → big snapshots and refresh storms if each point is its own command. Use the **batch `set_automation_points`** (one transaction, one snapshot) for draw; cap points-per-stroke and offer `simplify_automation`. Only serialize non-empty curves (`hasAutomationPoints()`), and cap plugin params already capped at 16 in `pluginToVar` (line 1588) — keep that cap so we don't serialize 100s of automated synth params.
7. **`getMasterVolumePlugin()` may be null** in odd states — guard like the existing master block.
8. **`ensureVolumePlugin` side-effect:** it *creates* the vol/pan plugin if absent (and inserts into `pluginList`). For `target:"pan"` that's fine (same plugin holds both). For a read-only snapshot path we use `getVolumePlugin()` (no creation). Only the *command* path uses `ensureVolumePlugin`.
9. **Undo granularity:** each command opens its own `beginNewTransaction`, so per-point edits are individually undoable; the batch draw is one transaction. This matches the existing one-transaction-per-command convention — don't nest.
10. **Plugin-list hiding:** the volume plugin is part of `pluginList` and already serialized by `pluginToVar`. Be careful **not** to double-serialize vol/pan automation in *both* `pluginToVar` (as plugin param i) *and* `trackToVar` (as track.automation). Decision: surface track vol/pan automation **only** under `track.automation` (semantic, index-free) and skip it in the plugin-param loop for the `VolumeAndPanPlugin` to avoid duplication and an index-coupling the UI shouldn't depend on. (Either suppress automation on the vol/pan plugin in `pluginToVar`, or simply let the UI prefer `track.automation`.)
11. **EditItemID / `itemID` asserts:** addressing is by `trackId`/plugin index/paramIndex only — no new `EditItemID` minting, so the classic `indexOf`/`createNewPlugin` assert (noted in CLAUDE.md Stage 3) does not apply here; we never add a plugin in these commands (except `ensureVolumePlugin`, which already uses `getPluginCache().createNewPlugin`).

---

## 7. Recommended implementation order (smallest verifiable slice first)

1. **Engine resolver + one command, headless-proven.** Add `resolveParam` + `cmdAddAutomationPoint` + `cmdClearAutomation` + dispatch + declarations. Add `automationToVar` and wire it into `trackToVar` (vol/pan only). Add selftest checks 1–4, 8, 11, 12 (add point, snapshot reflects it, clear empties, undo/redo, save/reload). **Gate:** points round-trip + persist headless. *(No UI yet.)*
2. **Full point CRUD.** Add `set_automation_point`, `remove_automation_point`; selftest checks 5–7, 13. Add `pluginToVar` automation field + plugin-param check 9; pan + master checks 10.
3. **Minimal UI lane (read + click-add + node-drag + node-delete).** `AutomationLane.tsx`, store `expandedLanes`/`toggleLane`, TrackHeader "A" button, render under the track lane in `Arrangement.tsx`, CSS tokens. Single-point commands. Verify visually (`--demo7` screenshot, manual).
4. **Freehand draw + batch.** Add `set_automation_points` (batched, range-replace, one transaction), toolbar pencil toggle, stroke→batch on pointer-up. Optional `simplify_automation`. Selftest the batch command headless.
5. **Plugin-param lanes + mixer indicators.** Reuse `AutomationLane` with a plugin target from `Rack.tsx`; add the "automated" dot on faders. Bump schemaVersion to 2 and the selftest headline.

Each step is independently committable and (1,2,4,5 partly) headless-verifiable; only the audible modulation and automation-*recording* are hardware-gated, which is honest about the `eng.hasAudio()==false` constraint.
