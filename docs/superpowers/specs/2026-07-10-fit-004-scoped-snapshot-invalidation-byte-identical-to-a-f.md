# FIT-004: Scoped snapshot invalidation (byte-identical to a full rebuild)

_Execution-ready spec authored by the sprint bug-hunt/spec workflow (2026-07-10). feasible=True._

# FIT-004 — Scoped snapshot invalidation (execution-ready spec)

**Status:** feasible. **Size:** M (the mechanism already exists in embryo; this is *harden + prove byte-identity + expand coverage + measure the delta*, not a from-scratch build). **Auto-mergeable:** needs-human for the first landing (it touches the hot `snapshot()` path and the correctness bar is exact), but the design does **not** actually cross the hard-excluded seams the backlog feared — see §6. Once the byte-identity harness lands and is wired into `gate.sh`, subsequent coverage expansions become auto-loop-gateable.

Reframe up front: the backlog entry (`docs/auto-loop/backlog.jsonl:50`) lists `src/engine/MoshEngine.cpp` + `src/state/` as the files and tags it "needs-human (prime-directive seams)". **That file list is over-scoped.** The real change lives entirely in the sanctioned mutation surface (`src/moshops/`) plus the frontend seam-client (`ui/src/`) plus harnesses (`src/app/SelfTest.cpp`, `scripts/bench/`). No engine-lifecycle change and no `src/state/**` schema change is required. That materially de-risks the lane (§6).

---

## 1. Problem & current behavior (with code anchors)

`MoshOps::snapshot()` (`src/moshops/MoshOps.cpp:8083`) rebuilds the **entire** project tree — session block, every track via `trackToVar` (`:8351`), every clip + every MIDI note via `clipToVar` (`:8575`, note loop `:8628`), transport, controller, buses, sections, annotations, master — into a fresh `juce::var`. The WebView re-pulls this whole tree on every `snapshot_invalidated` event (`ui/src/store.ts:299-306`).

D1 measured this at **330 ms / 3.7 MiB per edit at 100 tracks × 200 notes** (`__bench_snapshot` hook `src/app/SelfTest.cpp:5943-5964`; harness `scripts/bench/snapshot_bench.py`). The size is dominated by MIDI notes (200 notes × 100 tracks serialized in `clipToVar`).

A **partial** scoped path already exists:

- `MoshOps::emitTrackPatch(te::AudioTrack&)` (`src/moshops/MoshOps.cpp:9015-9024`) emits `snapshot_invalidated` carrying `{ scope:"track", trackId, track: trackToVar(...) }`.
- It is wired into exactly **4** command handlers: `set_track_volume` (`:3891`), `set_track_pan` (`:3908`), `set_track_mute` (`:3919`), `set_plugin_param` (`:4814`). All other **~140** call sites use the payload-less full `emitSnapshotInvalidated()` (`:9010`).
- The UI consumes it in `ui/src/snapshotPatch.ts` (`isTrackPatch`/`applyTrackPatch`) and `ui/src/store.ts:301-305`: on a track patch it splices the one track and returns; otherwise it falls back to a full `refresh()`.
- Existing `--selftest` coverage: `src/app/SelfTest.cpp:3878-3901` ("Scoped invalidation: track-local mutations emit a scoped patch") asserts a scope payload appears for `set_track_volume` and is absent for `create_track`.

### Two latent byte-identity defects in the *existing* scoped path (the crux of this lane)

The acceptance bar is "snapshot content **byte-identical** vs a full rebuild." The current `emitTrackPatch` **violates it in two reachable ways**, and there is no test that would catch either:

1. **`index` divergence when a hidden track exists.** `snapshot()` assigns each track's `index` from a counter that **skips** `ids::moshHidden` tracks (`:8279-8282`). But `emitTrackPatch` computes `const int idx = te::getAudioTracks(edit).indexOf(&track)` (`:9018`) — the **raw** index, which counts hidden tracks. The re-imagine-beneath-MIDI feature (P2) creates exactly such a hidden render track (`findOrCreateHiddenRenderTrack`), so once a hidden track precedes the patched track in engine order, the patch's `track.index` differs from a full rebuild. **Not byte-identical.**

2. **`session.dirty` staleness.** `beginTxn()` (`:496`) calls `eng.markDirty()`, and `snapshot()` writes `session.dirty = eng.isDirty()` (`:8188`). A track-local patch merges only `tracks` — it never touches `session` — so the **first** track-local mutation on a freshly-loaded/saved (clean) edit flips the backend dirty flag to `true`, but the UI's cached `session.dirty` stays `false`. A full rebuild would show `true`. **Not byte-identical** (reachable: open a project, move a fader).

A third, design-level caveat is already self-documented at `:4811-4813`: a `set_plugin_param` that changes a plugin's **latency** alters `session.totalLatencySamples`/`totalLatencyMs` (`:8247-8256`), which a track patch does not carry — the comment calls it "briefly stale." Under a strict byte-identity contract this is a fourth divergence that must be either carried in the patch or the command demoted to full invalidation.

The existing bench only measures the *full* `snapshot()` cost; it does **not** measure the scoped-patch cost, so "drops materially … via scoped invalidation" is unmeasured today.

---

## 2. Proposed design

**Governing invariant (the whole lane in one sentence):** *applying the emitted patch to the UI's prior snapshot must yield a state byte-identical to calling `snapshot()` fresh at that instant.* A scoped patch is only ever an **optimization** of a full rebuild; any command that cannot guarantee the invariant emits a full invalidation (fail-open to correctness).

Four moves:

### A. Single-source the visible-track enumeration (fixes defect 1)
Add a private helper so `snapshot()` and `emitTrackPatch` compute a track's `index` identically:

```cpp
// visible audio tracks in snapshot order (skips ids::moshHidden), single source of truth
juce::Array<te::AudioTrack*> MoshOps::visibleAudioTracks() const;
int  MoshOps::visibleIndexOf (te::AudioTrack& t) const;   // -1 if hidden/absent
```

`snapshot()`'s track loop (`:8279-8282`) and `emitTrackPatch` both use it. If `visibleIndexOf(track) < 0` (the track is itself hidden), `emitTrackPatch` **must not** patch — it emits a full invalidation instead (a hidden track has no snapshot slot to patch).

### B. Carry an enumerated `session` delta in the patch (fixes defects 2 & the PDC caveat)
Generalize the patch payload from `{scope, trackId, track}` to `{scope, trackId, track, session?}`, where `session` is an object containing **only** the session scalar fields a track-local mutation can change. For the current four commands that is `dirty` (always) and, for `set_plugin_param`, the PDC readout. `emitTrackPatch` always attaches `session:{ dirty: eng.isDirty() }`; the plugin-param path additionally refreshes `totalLatencySamples`/`totalLatencyMs`/`latencyContextReady` (recomputed exactly as `snapshot()` does at `:8247-8257`) so byte-identity holds even on a latency-changing param. The UI merges `session` shallowly.

Keep the enumeration **explicit and small** — it is the contract. If a future command touches a session field not in the enumeration, byte-identity breaks and the harness (§5) fails, forcing the author to either add the field or demote the command to full invalidation.

### C. A hard purity gate + measured coverage expansion
Document (in one place, next to `emitTrackPatch`) the exact predicate for "a command may emit a track patch": *it mutates only fields inside that track's `trackToVar` output and the enumerated session delta, and nothing that appears elsewhere in the snapshot.* Worked examples of why common commands are **excluded**:
- `set_track_solo` — soloing **dims other tracks'** effective state → full (already correct at `:3930`).
- `rename_track` — a renamed track can be another track's `output.name` (route-to-track destination, `:8409-8411`) → full.
- anything structural (create/remove/move/trim/split/clip ops, sections, buses, master, groups) → full.

Then expand coverage **only** to commands the harness proves pure, one at a time. High-value rapid-fire candidates to evaluate (each gated by §5's byte-identity assertion before promotion): drum-lane pad mute/solo (`ids::drumMute`/`drumSolo`, track-local, `:8377-8378`), aux **send** gain/mute (owned by the source track, `:8496-8506`), track input/monitor/arm state (`:8458-8489`). Do **not** promote speculatively — the harness is the arbiter.

### D. Measure the delta (turns the acceptance number into evidence)
Extend the `__bench_snapshot` hook with a `scope:"track"` mode that times building + marshalling **one** track's patch var (`trackToVar` + `JSON::toString`) and reports the ratio against the full `snapshot()`. At 100×200 the scoped per-edit cost should be ≈1/100 of the full (one track's notes vs 100 tracks' notes) — the "materially lower" acceptance made concrete.

---

## 3. Exact files to add/modify + the shape of each change

**`src/moshops/MoshOps.h`**
- Add private decls near `:484`:
  ```cpp
  juce::Array<te::AudioTrack*> visibleAudioTracks() const;   // snapshot-order, skips moshHidden
  int  visibleIndexOf (te::AudioTrack&) const;               // -1 if hidden/absent
  juce::var sessionPatchScalars (bool includePdc);           // { dirty, [totalLatency*] }
  ```
  Keep `emitTrackPatch(te::AudioTrack&)`'s signature; optionally add `emitTrackPatch(te::AudioTrack&, bool includePdc = false)` so `set_plugin_param` opts into the PDC fields.

**`src/moshops/MoshOps.cpp`**
- Add `visibleAudioTracks()`/`visibleIndexOf()` (mirror the filter at `:8281`).
- Refactor `snapshot()`'s track loop (`:8279-8282`) to iterate `visibleAudioTracks()` so it and `emitTrackPatch` share the enumeration (behaviour-identical — pure refactor, byte-output unchanged).
- Rewrite `emitTrackPatch` (`:9015-9024`):
  ```cpp
  void MoshOps::emitTrackPatch (te::AudioTrack& track, bool includePdc)
  {
      if (eventSink == nullptr) return;
      const int idx = visibleIndexOf (track);
      if (idx < 0) { emitSnapshotInvalidated(); return; }   // hidden ⇒ no slot; fail-open
      auto* p = new DynamicObject();
      p->setProperty ("scope", "track");
      p->setProperty ("trackId", track.itemID.toString());
      p->setProperty ("track", trackToVar (track, idx));     // same idx snapshot() would assign
      p->setProperty ("session", sessionPatchScalars (includePdc));
      emit ("snapshot_invalidated", var (p));
  }
  ```
- `sessionPatchScalars(includePdc)`: `{ dirty: eng.isDirty() }`, plus when `includePdc` the three PDC fields computed exactly as `:8247-8257`.
- `set_plugin_param` (`:4814`): `emitTrackPatch (*track, /*includePdc*/ true);`. The three fader/mute sites (`:3891/:3908/:3919`) call the default `includePdc=false` overload.

**`ui/src/snapshotPatch.ts`**
- Extend the type + merge:
  ```ts
  export type TrackPatch = { scope: "track"; trackId: string; track: Track; session?: Partial<Snapshot["session"]> };
  // in applyTrackPatch, after building `tracks`, when found:
  const session = patch.session ? { ...snapshot.session, ...patch.session } : snapshot.session;
  return found ? { ...snapshot, tracks, session } : null;
  ```
  `isTrackPatch` unchanged (session is optional). Missing-id still returns `null` → full refresh (fail-open, keep `:17-24`).

**`src/app/SelfTest.cpp`**
- New section "Scoped invalidation: byte-identity vs full rebuild" (see §5) — a backend-only merge-and-diff.
- Extend `__bench_snapshot` (`:5943`) to honour `args.scope == "track"` and report `{ trackAvgMs, trackJsonBytes, fullAvgMs, fullJsonBytes, ratio }`.

**`scripts/bench/snapshot_bench.py`**
- After the existing full `__bench_snapshot`, append a `{"command":"__bench_snapshot","args":{"scope":"track","trackId":"${T}","iterations":...}}` step (capture a `${T}` from the last `create_track`) and print the scoped-vs-full ratio + a verdict line.

**`ui/src/snapshotPatch.test.ts`** (extend or add): assert the `session` delta merges, order is preserved, and a missing id returns `null`.

No changes to `src/engine/MoshEngine.*` or `src/state/**` are required (see §6).

---

## 4. Commands / contracts affected (additive?)

- **Additive, backward-compatible.** No command names, args, results, or undo semantics change. `execute()` is untouched — this lane only changes the **event payload** of `snapshot_invalidated` (adds an optional `session` object) and the internal `index` derivation.
- The `mosh_event` / `snapshot_invalidated` wire contract stays a superset: old-shape `{scope,trackId,track}` still valid; `session` is optional. `kSnapshotSchemaVersion` does **not** change (the `snapshot()` output shape is unchanged; only *how a patch is applied* changes).
- One-mutation-path directive: **unaffected** — `emitTrackPatch` is an event emission, not a mutation; no new command surface.
- Multiplayer/replay: `emit()` already suppresses per-command events during recovery replay (`:9002`), so scoped patches never fire mid-replay; a single full invalidate follows. No special handling needed.

---

## 5. Test plan (concrete assertions)

**Where byte-identity is tested: `--selftest` (SelfTest.cpp), not Catch2.** The Catch2 `MoshTests` target links a *curated* source list (`tests/CMakeLists.txt:9-31`) that does **not** include `MoshOps`/`MoshEngine`/tracktion, so it cannot build a real `snapshot()`. `--selftest` runs inside the full app target with a live engine and already has the event-capture rig (`lastEvent`, `src/app/SelfTest.cpp:488-492`). Put the byte-identity checks there.

**New `--selftest` section — "Scoped invalidation: byte-identity vs full rebuild".** Helper: `mergePatch(prior, payload)` in the harness (mirror `applyTrackPatch`: splice `tracks` by id + shallow-merge `session`). For each case: capture `prior = ops.snapshot()`, run the command (which fires the scoped event into `lastEvent`), then assert
`JSON::toString(ops.snapshot(), false) == JSON::toString(mergePatch(prior, lastEvent["payload"]), false)`.

Concrete cases (each a `check(...)`):
1. **`set_track_volume` / `set_track_pan` / `set_track_mute`** on a plain track → byte-identical.
2. **`set_plugin_param` that changes latency** — load a builtin with a latency param, tweak it → byte-identical (proves the PDC delta is carried; this case RED-fails without move B).
3. **First mutation on a CLEAN edit** — `save`, then `set_track_volume` as the very next op → byte-identical (proves the `session.dirty` delta; RED-fails today, defect 2).
4. **Hidden-track present** — create a track, mark a synthesized track `ids::moshHidden` so it precedes the target in engine order (or drive the reimagine-beneath path), then `set_track_volume` → the patch's `track.index` equals the full rebuild's (proves defect 1's fix; RED-fails today).
5. **Negative / purity** — `set_track_solo` and `rename_track` still emit a **full** invalidation (no `scope` on `lastEvent.payload`), asserting they were *not* wrongly promoted.
6. Keep the existing `:3878-3901` assertions (scope present on volume, absent on create_track).

Run `--selftest ×3` and confirm deterministic (the byte-string compare is deterministic in headless: `session.totalLatency*` = 0 with no device, `dirty` set before emit in `beginTxn`).

**vitest** (`ui/src/snapshotPatch.test.ts`): (a) `applyTrackPatch` merges `session` delta and leaves other session fields intact; (b) preserves track order; (c) returns `null` on unknown id. Run full `cd ui && npm run test` + `tsc`.

**e2e** (`ui/e2e`): the existing mixer/fader specs already exercise the scoped path; re-run to confirm no regression (a fader move still updates one track and no longer shows a stale unsaved-state indicator, if any spec asserts dirty).

**Bench** (`scripts/bench/snapshot_bench.py`): print `full=… ms`, `scoped(track)=… ms`, `ratio`. Informational/CI-tracked; assert `ratio < 0.2` at 100×200 in the script's verdict line (expected ≈0.01).

**Gate**: wire the new byte-identity `--selftest` section into `scripts/auto-loop/gate.sh` (it already runs `--selftest`); optionally add the bench-ratio assertion. No `verify.py` audio change needed (this lane produces no audio).

---

## 6. Risks & seam concerns

- **Hard-excluded seams — the backlog list is avoidable.** `docs/auto-loop/backlog.jsonl:50` names `src/engine/MoshEngine.cpp` + `src/state/`. **This design touches neither.** The visible-track helper is a private `MoshOps` method (not an `src/state` schema change); the fix lives in `src/moshops/` (already *the* sanctioned mutation surface) + the frontend seam-client + harnesses. Explicitly confirm in the PR that no `src/state/**` file and no `MoshEngine` lifecycle code changed. This is why the lane is closer to auto-mergeable than "needs-human" implies.
- **Prime directives stay intact:** (1) one mutation path — `emitTrackPatch` is event emission, not a Tracktion mutation, and adds no command; (2) one undo system — untouched; (3) swappable seam — the payload is pure view-transport over the existing `mosh_event` channel, no Tracktion concepts cross (the UI already couples only via `execute` + snapshot/events); (4) no shadow model / second state store is introduced — the patch is *derived from* `snapshot()`'s own `trackToVar`, so there is exactly one source of truth.
- **Hot-path risk:** `snapshot()` and `trackToVar` are performance- and correctness-sensitive. The `snapshot()` track-loop refactor (share `visibleAudioTracks()`) must be a pure refactor — guard it by keeping cases 1-6 above green and confirming `__bench_snapshot` full-mode numbers don't regress.
- **Byte-identity is a strict contract that will surface future regressions** — that is the point. Any later change to `trackToVar` or the session block that a promoted command touches will trip the harness. Document that promoting a command to scoped requires adding a byte-identity case.
- **Plugins/hosting seam:** `set_plugin_param` reads plugin latency for the PDC delta; that is read-only introspection already done in `snapshot()` (`:8247`). No new plugin-host coupling.
- **Deploy/CI:** no bundle or deploy change; CI change is limited to gate wiring. Mac-canonical; nothing platform-specific (the payload is platform-agnostic).
- **Non-goal (scope discipline):** this lane does **not** reduce the cost of a *single full* `snapshot()` (e.g. per-track var memoization) — that is a separate, riskier optimization. It reduces how often the UI pays the full cost for common rapid-fire edits, plus fixes the correctness of the path that already does so.

---

## 7. Acceptance criteria

1. For **every** command that emits a track patch, `merge(prior, patch)` is byte-identical (`JSON::toString` equal) to a fresh `snapshot()` — proven by the new `--selftest` section across cases 1-4 (plain, latency-param, clean-edit-dirty, hidden-track-index).
2. `track.index` parity holds with ≥1 `moshHidden` track present (defect 1 closed).
3. `session.dirty` parity holds when the patched command is the first mutation on a clean edit (defect 2 closed).
4. `set_plugin_param` that changes plugin latency stays byte-identical (PDC delta carried) — or, if the conservative fallback is chosen, `set_plugin_param` is demoted to full invalidation and that is asserted.
5. Non-pure commands (`set_track_solo`, `rename_track`, all structural) still emit **full** invalidation (asserted).
6. `snapshot_bench.py` `scope:"track"` mode reports the scoped per-edit marshal cost ≤ 1/5 (expected ≈1/100) of the full at 100×200, printed as a measured ratio.
7. Full gate green and deterministic: `--selftest ×3`, Catch2 unchanged, vitest + `tsc`, e2e; PR confirms zero `src/engine`/`src/state` diff.

---

## 8. Rough size & mergeability

- **Size: M.** ~150-250 lines net across `MoshOps.{h,cpp}` (helpers + payload), `snapshotPatch.ts` (a few lines), `SelfTest.cpp` (the byte-identity section + bench mode), `snapshot_bench.py`, and vitest. The infra and UI consumer already exist; the work is correctness + harness + a couple of coverage promotions.
- **Auto-mergeable vs needs-human:** **needs-human for the first landing** — it modifies the hot `snapshot()`/`trackToVar` path and the correctness bar is exact byte-identity, warranting a human eye on the refactor. It is **not** the seam-crossing lift the backlog feared (§6), so after the byte-identity harness is wired into `gate.sh`, later coverage expansions (promoting one more pure command at a time, each with its own byte-identity case) are safely **auto-loop-gateable**.
