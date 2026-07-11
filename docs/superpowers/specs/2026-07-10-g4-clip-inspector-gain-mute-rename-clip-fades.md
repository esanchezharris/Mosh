# G4: Clip inspector gain/mute/rename + clip fades

_Execution-ready spec authored by the sprint bug-hunt/spec workflow (2026-07-10). feasible=True._

# G4 — Clip inspector gain/mute/rename + clip fades

**Status:** feasible, execution-ready. **Size:** M (S-native, M-with-UI-and-tests). **Auto-mergeable:** yes (fully within the established one-mutation-path pattern; no hard-excluded seam).

> **Headline correction to the item framing.** The item warns "May touch src/state serialization for fades → call out the seam risk." **It does not.** Clip fades are natively supported by Tracktion on `AudioClipBase` and are persisted as `juce::CachedValue`s bound to the **clip's own ValueTree** (`te::IDs::fadeIn/fadeOut/fadeInType/fadeOutType`) with the **edit's UndoManager**. Mosh already saves/loads that tree as part of the edit, and already routes clip-gain through the identical CachedValue mechanism. So fades get **free persistence** and **free undo** — no `src/state` schema change, no `Migrations.h` bump, no `MoshEngine` change. This substantially de-risks the lane. Details with anchors below.

---

## 1. Problem & current behavior (with code anchors)

Three clip-level mutations already exist as MoshOps commands but are **agent-only** (no UI surface), and there is **no clip-fade command at all**.

**Existing agent-only clip commands** — `src/moshops/MoshOps.cpp`:
- Dispatch registrations at `MoshOps.cpp:849–851`:
  ```cpp
  if (name == "rename_clip")       return cmdRenameClip (args);
  if (name == "set_clip_mute")     return cmdSetClipMute (args);
  if (name == "set_clip_gain")     return cmdSetClipGain (args);
  ```
- Handlers `cmdRenameClip` (`3515–3524`), `cmdSetClipMute` (`3526–3535`), `cmdSetClipGain` (`3537–3546`). `set_clip_gain` is **audio-clip-only** (`dynamic_cast<te::AudioClipBase*>`, returns `"not an audio clip"` otherwise) and clamps `jlimit(-48.0f, 24.0f, gainDb)`. All three `beginTxn(...)` + `emitSnapshotInvalidated()` + `logLine(..., undoable:true)`.
- Catalog entries `ui/src/agent/commands.ts:41–43` (agent surface only) + narration `167–169`.
- Mock handlers `ui/src/bridge.mock.ts:929–931`.

**Inspector is track-only for mix** — `ui/src/v2/inspector/Inspector.tsx`:
- Tabs are `mix · fx · gen · lyrics` (+ `midi` for MIDI clips, +`takes` when `numTakes > 1`) — `Inspector.tsx:32–40`.
- `MixTab` (`63–85`) drives **`set_track_volume` / `set_track_pan` / `set_track_mute` / `set_track_solo`** — all **track**-scoped. There is **no clip tab**: when a clip is selected (`selectedClipId`, `Inspector.tsx:26–28`) the only clip surfaces are `MidiTab` (piano-roll / quantize) and `TakesTab`. A producer cannot set clip gain/mute/rename or any fade from the UI.

**No fade command / no fade in the snapshot.** `grep -n fade src/moshops/MoshOps.cpp` finds only the track-fader G14 machinery (`SetFaderValueAction`, `88–111`) and render-layer crossfade tiling (`6498 xfade_ms`) — **nothing clip-edge-fade**. `clipToVar` (`MoshOps.cpp:8575–8654`) serializes `name/start/length/offset/mute` and, in the wave branch (`8590–8624`), `gainDb/autoTempo/...` — **no `fadeIn`/`fadeOut`**.

**Conformance scoreboard** already tracks this exact gap: `scripts/daw-conformance/scoreboard.py:36–37` (row **G4**, "must", "native") cites reality-pack invariants **27** ("A muted clip is silent even if its track is unmuted"), **29** ("Clip gain affects that clip without moving the track fader"), **30** ("Clip fades affect edges without moving clip boundaries") — `docs/reality-pack/mosh_daw_reality_model.md:83,85,86`.

> **Do not conflate with DAW-007.** The eval row "Create fade out over last 4 bars" (`mosh_daw_eval_suite.csv:8`) is handled by **volume automation** (`conformance.py:502 → fam_automation_create`), a different mechanism. **Clip-edge fades (inv 30) are a distinct feature** and are what this lane delivers.

**Engine support already exists** (pinned clone `2877b621`, `.cpm-cache/_fc/tracktion_engine-src/modules/tracktion_engine/model/clips/`):
- `tracktion_AudioClipBase.h:170–190` — `bool setFadeIn(TimeDuration)`, `TimeDuration getFadeIn()`, `bool setFadeOut(TimeDuration)`, `TimeDuration getFadeOut()`, `void setFadeInType(AudioFadeCurve::Type)`, `getFadeInType()`, `void setFadeOutType(...)`, `getFadeOutType()`.
- `tracktion_AudioClipBase.cpp:216–224` — the CachedValue bindings, **the key persistence/undo fact**:
  ```cpp
  auto um = getUndoManager();
  fadeIn.referTo (state, IDs::fadeIn, um);
  fadeOut.referTo (state, IDs::fadeOut, um);
  fadeInType.referTo (state, IDs::fadeInType, um, AudioFadeCurve::linear);
  fadeOutType.referTo (state, IDs::fadeOutType, um, AudioFadeCurve::linear);
  autoCrossfade.referTo (state, IDs::autoCrossfade, um);
  ```
  `um` is the edit's UndoManager — **the same one `beginTxn()` opens a transaction on** — so writing a fade inside a MoshOps txn is undoable exactly like `cmdSetClipGain` writing `level->dbGain` (bound the same way at `AudioClipBase.cpp:208`).
- `setFadeIn`/`setFadeOut` (`AudioClipBase.cpp:511–550`) clamp to `[0, clipLength]` and rescale if `fadeIn+fadeOut > len` (no boundary move — satisfies inv 30). **Caveat:** `getFadeIn()`/`getFadeOut()` (`552–580`) return an auto-crossfade-adjusted value **when `autoCrossfade` is on AND a neighbor overlaps**; Mosh defaults `autoCrossfade` off, so the getter returns the raw stored fade in the common case.
- `AudioFadeCurve::Type` enum (`utilities/tracktion_AudioFadeCurve.h:46–52`): `linear=1, convex=2, concave=3, sCurve=4`.

---

## 2. Proposed design

Two additive slices, both within the established seam:

**(A) New native command `set_clip_fade`** — one command sets fade-in and/or fade-out (and optionally the curve types). Audio-clip-only (mirrors `set_clip_gain`). Partial application via `hasProperty` (mirrors `cmdSetClipWarp`, `MoshOps.cpp:3575–3618`): apply only the dimensions present in `args`. Undoable + logged + snapshot-invalidating like every other clip command. Extend `clipToVar` to emit `fadeInSec`/`fadeOutSec` (+ curve types) additively in the wave branch, next to `gainDb`.

**(B) A "Clip" Inspector tab** that appears when a clip is selected, surfacing the **already-existing** `rename_clip` / `set_clip_mute` / `set_clip_gain` (gain shown for wave clips only) **plus** the new fade-in/out sliders. This is a pure client of the command seam (no new engine coupling), exactly like `MixTab`.

**Command shape (additive, seconds — consistent with the rest of the clip API):**
```
set_clip_fade { clipId: string,
                fadeInSec?: number,     // >=0, clamped to clip length by the engine
                fadeOutSec?: number,    // >=0
                curveIn?:  "linear"|"convex"|"concave"|"sCurve",
                curveOut?: "linear"|"convex"|"concave"|"sCurve" }
```
Return an echo `data` object (mirrors `cmdSetClipWarp`'s return) with the applied `fadeInSec/fadeOutSec` read back from `getFadeIn()/getFadeOut()` so the caller/agent sees the clamped truth.

---

## 3. Exact files to add/modify + shape of each change

**Native (all additive):**

1. `src/moshops/MoshOps.h` — add decl next to `cmdSetClipWarp` (`~166`):
   ```cpp
   juce::var cmdSetClipFade (const juce::var& args);
   ```

2. `src/moshops/MoshOps.cpp`
   - **Dispatch** after `set_clip_warp` (`~853`): `if (name == "set_clip_fade") return cmdSetClipFade (args);`
   - **Handler** (place near `cmdSetClipGain`, ~`3546`). Shape:
     ```cpp
     juce::var MoshOps::cmdSetClipFade (const juce::var& args)
     {
         auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
         if (ac == nullptr) return errResult ("set_clip_fade", "not an audio clip");
         beginTxn ("set_clip_fade");
         if (args.hasProperty ("fadeInSec"))
             ac->setFadeIn  (te::TimeDuration::fromSeconds (juce::jmax (0.0, (double) args.getProperty ("fadeInSec",  0.0))));
         if (args.hasProperty ("fadeOutSec"))
             ac->setFadeOut (te::TimeDuration::fromSeconds (juce::jmax (0.0, (double) args.getProperty ("fadeOutSec", 0.0))));
         if (args.hasProperty ("curveIn"))
             ac->setFadeInType  (fadeCurveFromName (args.getProperty ("curveIn",  "linear").toString()));
         if (args.hasProperty ("curveOut"))
             ac->setFadeOutType (fadeCurveFromName (args.getProperty ("curveOut", "linear").toString()));
         logLine ("set_clip_fade", args, true, {}, true);
         emitSnapshotInvalidated();
         auto* data = new DynamicObject();
         data->setProperty ("clipId", ac->itemID.toString());
         data->setProperty ("fadeInSec",  ac->getFadeIn().inSeconds());
         data->setProperty ("fadeOutSec", ac->getFadeOut().inSeconds());
         return okResult ("set_clip_fade", var (data));
     }
     ```
     Add a small local `fadeCurveFromName` helper (string→`AudioFadeCurve::Type`, default `linear`). **Contract-test rule:** every catalog-declared arg name (`clipId`, `fadeInSec`, `fadeOutSec`, `curveIn`, `curveOut`) MUST appear as an `args.getProperty(...)`/`args.hasProperty(...)` literal in this handler body (see §5) — the shape above satisfies that.
   - **`clipToVar`** wave branch (after `gainDb`, `~8596`), additive:
     ```cpp
     o->setProperty ("fadeInSec",  w->getFadeIn().inSeconds());
     o->setProperty ("fadeOutSec", w->getFadeOut().inSeconds());
     o->setProperty ("fadeInType",  (int) w->getFadeInType());   // 1..4 (optional; UI only needs durations for v1)
     o->setProperty ("fadeOutType", (int) w->getFadeOutType());
     ```
   - **`isReplayableCommand`** allowlist (`9087–9096`): add `"set_clip_fade"` (it's a deterministic, replayable arrangement mutation).

3. `src/multiplayer/LockManager.cpp` — add `"set_clip_fade"` to the `clip` set (`66–76`). Without it, it fails **closed** to `SessionGlobal` (safe but over-coarse); it carries a `clipId`, so Clip scope is correct.

**Frontend (all additive):**

4. `ui/src/types.ts` — extend `Clip` (`143–171`), next to `gainDb`:
   ```ts
   fadeInSec?: number;
   fadeOutSec?: number;
   fadeInType?: number;   // 1=linear 2=convex 3=concave 4=sCurve (optional)
   fadeOutType?: number;
   ```

5. `ui/src/agent/commands.ts` — catalog entry after `set_clip_gain` (`43`):
   ```ts
   { command: "set_clip_fade", desc: "Set a clip's fade-in / fade-out (seconds)",
     args: [S("clipId"), N("fadeInSec", false, "seconds"), N("fadeOutSec", false, "seconds"),
            S("curveIn", false, "linear|convex|concave|sCurve"), S("curveOut", false, "linear|convex|concave|sCurve")] },
   ```
   + narration in the `describe` switch (`~169`): `case "set_clip_fade": return \`Set clip fades (in ${a.fadeInSec ?? "–"}s, out ${a.fadeOutSec ?? "–"}s)\`;`

6. `ui/src/bridge.mock.ts` — mock handler after `set_clip_gain` (`931`), mirroring the real clamp behavior enough for e2e/vitest:
   ```ts
   case "set_clip_fade": {
     const f = findClip(str(args.clipId)); if (!f) return err(command, "clip not found"); pushUndo();
     if (args.fadeInSec  !== undefined) f.clip.fadeInSec  = Math.max(0, Math.min(num(args.fadeInSec),  f.clip.length));
     if (args.fadeOutSec !== undefined) f.clip.fadeOutSec = Math.max(0, Math.min(num(args.fadeOutSec), f.clip.length));
     invalidate(); return ok(command); }
   ```
   (Wave clips seeded by `waveClip(...)` should default `fadeInSec:0, fadeOutSec:0` so the tab renders deterministically.)

7. `ui/src/v2/shellState.ts` — extend the tab union (`9`): `export type InspectorTab = "mix" | "fx" | "gen" | "lyrics" | "midi" | "takes" | "clip";`

8. `ui/src/v2/inspector/Inspector.tsx` — register the tab (conditional on a clip being selected) and add `ClipTab`:
   - In `tabs` (`32–39`), insert `...(clip ? [{ id: "clip" as const, label: "Clip" }] : [])` (place first among clip tabs).
   - In the body switch (`51–58`): `{active === "clip" && clip && <ClipTab clip={clip} />}`
   - New component (mirrors `MixTab`, wave-gates the gain row):
     ```tsx
     function ClipTab({ clip }: { clip: Clip }) {
       const exec = useStore((s) => s.exec);
       const isWave = clip.type === "wave";
       const clamp = (v: number) => Math.max(0, Math.min(v, clip.length));
       return (
         <div className="v2-mix" data-testid="v2-clip-tab">
           <label className="v2-field"><span>Name</span>
             <input type="text" defaultValue={clip.name} key={clip.name}
               data-testid="v2-clip-name"
               onBlur={(e) => { if (e.target.value !== clip.name) void exec("rename_clip", { clipId: clip.id, name: e.target.value }); }} /></label>
           {isWave && (
             <label className="v2-field"><span>Gain</span>
               <input type="range" min={-48} max={24} step={0.5} value={clip.gainDb ?? 0}
                 data-testid="v2-clip-gain"
                 onChange={(e) => void exec("set_clip_gain", { clipId: clip.id, gainDb: Number(e.target.value) })} />
               <span className="v2-val">{(clip.gainDb ?? 0).toFixed(1)}</span></label>)}
           {isWave && (<>
             <label className="v2-field"><span>Fade in</span>
               <input type="range" min={0} max={clip.length} step={0.01} value={clamp(clip.fadeInSec ?? 0)}
                 data-testid="v2-clip-fadein"
                 onChange={(e) => void exec("set_clip_fade", { clipId: clip.id, fadeInSec: Number(e.target.value) })} />
               <span className="v2-val">{(clip.fadeInSec ?? 0).toFixed(2)}s</span></label>
             <label className="v2-field"><span>Fade out</span>
               <input type="range" min={0} max={clip.length} step={0.01} value={clamp(clip.fadeOutSec ?? 0)}
                 data-testid="v2-clip-fadeout"
                 onChange={(e) => void exec("set_clip_fade", { clipId: clip.id, fadeOutSec: Number(e.target.value) })} />
               <span className="v2-val">{(clip.fadeOutSec ?? 0).toFixed(2)}s</span></label></>)}
           <div className="v2-mix-btns">
             <button className={clip.mute ? "on" : ""} aria-pressed={!!clip.mute} data-testid="v2-clip-mute"
               onClick={() => void exec("set_clip_mute", { clipId: clip.id, mute: !clip.mute })}>Mute clip</button>
           </div>
         </div>
       );
     }
     ```

**Optional completeness follow-up (label as a stretch, or a sibling backlog item):** `cmdDuplicateClip` (`MoshOps.cpp:3633–3656`) and `cmdPasteClip` (`~3836/3860`) copy `gainDb`+`mute` but **not** fades — so a duplicated/pasted clip loses its fades. If in scope, copy `w->getFadeIn()/getFadeOut()/…Type` in the wave branch of duplicate, and read `fadeInSec/fadeOutSec` from the clip descriptor in paste (which requires `clipToVar` to already emit them — it will, per §3.2). Small, but a genuine correctness gap; call it out in the PR.

---

## 4. Commands/contracts affected (additive?)

**Fully additive.** One new command `set_clip_fade`. No existing command changes shape or semantics. Snapshot gains optional `fadeInSec/fadeOutSec/fadeInType/fadeOutType` on wave clips — additive, so **no `kSnapshotSchemaVersion` bump** (same posture as `gainDb`/`autoTempo`, which were added without a bump). No project-format change (`moshFormatVersion` untouched) — fades ride Tracktion's own ValueTree, which older Mosh builds simply ignore, and newer builds read. Registration touchpoints: dispatch, `MoshOps.h` decl, `isReplayableCommand`, `LockManager` clip set, `commands.ts`, `bridge.mock.ts`. The agent catalog ⇄ backend arg contract is auto-guarded (see §5).

---

## 5. Test plan (concrete assertions)

**Catch2 / `Mosh --selftest`** — extend the existing clip-editing section in `src/app/SelfTest.cpp` (immediately after the gain block, `1066–1075`; reuse the `clipById(cid)` helper defined at `1044–1049`). Add, on the wave/tone clip `cid`:
- `set_clip_fade {fadeInSec:0.5, fadeOutSec:0.25}` → `ok`; `clipById(cid).getProperty("fadeInSec")` ≈ 0.5 and `fadeOutSec` ≈ 0.25 (tolerance 0.02) — **proves the snapshot reflects fades**.
- **Clamp/no-boundary-move (inv 30):** on a 1.0 s clip, `set_clip_fade {fadeInSec:5.0}` → `ok`; assert `fadeInSec ≤ clip.length` and clip `start`/`length` **unchanged** vs before.
- **Undo/redo:** after setting fades, `undo` → both fades restored to prior; `redo` → re-applied (mirrors the `set_clip_mute` undo/redo asserts at `1061–1064`).
- **Save/reload persistence:** `save` then `reload`, assert `fadeInSec` still ≈ 0.5 — **proves the free-persistence claim** (no src/state code, rides Tracktion's tree).
- **Type rejection:** `set_clip_fade` on a MIDI clip → **not** `ok`, error `"not an audio clip"` (mirror the `set_clip_gain {gain:0.5}` rejection asserted at `4741`).
- **Log undoable:** grep the JSONL for `"command": "set_clip_fade"` with `"undoable": true` (mirror the warp assert at `4469–4470`).

The existing selftest is currently ≈1199 checks; this adds ~8–10. Run `--selftest` **×3** for determinism.

**verify.py (hardware / real-audio "ears" proof)** — add `check_clip_fade(ctx)` to `scripts/verify-hardware/verify.py` (mirror `check_makes_sound`, `246–259`). Render a 2 s test-tone with `set_clip_fade {fadeInSec:1.0}` before `export_audio`, then window the WAV (extend `stats()`/add a windowed-RMS helper):
- assert `rms(first 100 ms) < 0.3 × rms(500–1500 ms body)` → the fade-in **actually shapes the audio** (closes the "passes plumbing but no ears" gap the same way the neural-A/B and transform checks did).
- Optionally register in the golden manifest (PCM-checksum, not whole-file — the WAV header bext chunk is non-deterministic, per the B1 note) so the fade render is regression-pinned. Gate via `scripts/auto-loop/gate.sh` (already runs `verify.py --gate`).

**vitest**
- `commands.contract.test.ts` (`ui/src/agent/commands.contract.test.ts:77–92`) **auto-covers** `set_clip_fade` the moment it's in `AGENT_COMMANDS` — it asserts every declared arg (`clipId/fadeInSec/fadeOutSec/curveIn/curveOut`) is read by `cmdSetClipFade` in `MoshOps.cpp` via a `getProperty|hasProperty` literal. **This is the hard gate to satisfy in §3.2** — keep the arg names byte-identical between catalog and handler.
- New mock-bridge unit test: `set_clip_fade` on a wave clip updates `fadeInSec/fadeOutSec`, clamps to `[0, length]`, and `undo` restores (mirror existing clip-command mock tests).
- New Inspector render test: with a wave clip selected, the `Clip` tab renders `v2-clip-name/gain/fadein/fadeout/mute`; with a MIDI clip selected, gain+fade rows are absent.

**e2e (Playwright)** — extend `ui/e2e/v2-shell.spec.ts` (the tab-click pattern is at `210–212`): select a clip in a lane (`ClipView` `selectClip`, `ClipView.tsx:73`), click `v2-insp-tab-clip`, drag `v2-clip-fadein`, assert the mock snapshot's clip `fadeInSec` reflects the value (or that `exec("set_clip_fade", …)` fired). Guard that the `Clip` tab is **absent** when no clip is selected.

**DAW conformance scoreboard** — update the G4 row in `scripts/daw-conformance/scoreboard.py:36–37` from the current gap note to closed (gain/mute/rename surfaced + `set_clip_fade` shipped), and regenerate `docs/FEATURE_AUDIT.md` (`gate.sh` runs `conformance.py`+`scoreboard.py`; keep it green/deterministic ×3).

---

## 6. Risks & seam concerns

- **`src/state` serialization — NOT touched (the item's flagged risk does not materialize).** Fades persist via Tracktion's own `CachedValue`→ValueTree (`AudioClipBase.cpp:216–224`), which is inside the edit tree Mosh already round-trips. No `state/Migrations.h`, no `state/Ids.h`, no `MOSH_*` schema. Verified: `src/state/Ids.h` declares no fade ids (only render-layer ids like `coverage` at `:190`); the fade ids live in `te::IDs`.
- **`MoshEngine` — not touched.** No load-site, resolver, or device change. Confined to `MoshOps` (command + `clipToVar`), `LockManager`, and UI.
- **Plugins/hosting, deploy, CI — not touched.** No plugin, no bundle whitelist, no CMake/preset, no `run-mosh.sh`/`gate.sh` structural change beyond adding one `verify.py` check that already runs under the existing gate.
- **Undo correctness.** Uses the plain `CachedValue.referTo(state, id, um)` path (edit UndoManager) — **not** the G14 track-fader path (`SetFaderValueAction`, `MoshOps.cpp:88–111`), which only exists because `VolumeAndPanPlugin::setVolumeDb` writes with `nullptr`. Clip gain already proves this plain path is undoable; fades are identical. No G14-style workaround needed. (Sanity-verify in the selftest undo/redo asserts above.)
- **`getFadeIn()` auto-crossfade caveat.** The getter adjusts for overlaps when `autoCrossfade` is on; Mosh leaves it off, so the snapshot reflects raw fades. If a future auto-crossfade feature lands, the snapshot getter may need to read the raw CachedValue — note it, don't pre-solve it.
- **Contract-test coupling (the one real gotcha).** `commands.contract.test.ts` will **fail red** if any catalog arg name isn't literally read in `cmdSetClipFade`. Keep `clipId/fadeInSec/fadeOutSec/curveIn/curveOut` identical on both sides. (If you defer curves, drop `curveIn/curveOut` from the catalog too.)
- **MIDI clips have no fades.** `set_clip_fade` and the gain/fade UI rows are wave-only (MIDI clips aren't `AudioClipBase`), matching `set_clip_gain`. The mute row + rename apply to all clip types.

---

## 7. Acceptance criteria

1. `set_clip_fade` exists as a MoshOps command: audio-clip-only, undoable, JSONL-logged `undoable:true`, snapshot-invalidating; rejects MIDI clips with `"not an audio clip"`.
2. Setting a fade **shapes the audio** (verify.py windowed-RMS: fade-in region RMS ≪ body RMS) and **does not move clip boundaries** (start/length unchanged — inv 30).
3. Fades **round-trip through save/reload** and **undo/redo** correctly (selftest).
4. The v2 Inspector shows a **Clip** tab when a clip is selected, surfacing rename + mute for all clips and gain + fade-in + fade-out for wave clips, each driving the correct command (inv 27 mute, inv 29 gain, inv 30 fades — all reachable from the UI).
5. `commands.contract.test.ts` green (catalog⇄handler arg contract holds).
6. Full gate green ×3-deterministic: `--selftest` (+~8–10 checks), Catch2, `verify.py --gate` (+`check_clip_fade`), vitest (+mock/Inspector/contract), e2e (+clip-tab spec), `tsc`; DAW-conformance regenerated with G4 flipped to closed.

---

## 8. Rough size & mergeability

**Size: M.** Native slice alone is **S** (one handler + 4 registration lines + 2 snapshot lines, all copy-shaped from `set_clip_gain`/`set_clip_warp`). The UI tab + mock + four test surfaces push it to **M**. Every piece is low-risk and follows a proven template; there is no engine/state-schema/hosting risk.

**Auto-mergeable: yes.** Fully within the one-mutation-path + snapshot/events seam, additive-only, no hard-excluded seam touched. Auto-merge on the standard fail-closed gate (`--selftest` ×3 + Catch2 + `verify.py --gate` with the new fade "ears" check + vitest + e2e + `tsc` + adversarial review). The by-ear pleasantness of fade curves is a nice-to-have owner check, **not** a merge blocker — the windowed-RMS verify.py assertion gives objective proof the fade is audible and boundary-preserving. Recommend one human glance only if the optional duplicate/paste fade-carry follow-up is folded in (it changes two more handlers).
