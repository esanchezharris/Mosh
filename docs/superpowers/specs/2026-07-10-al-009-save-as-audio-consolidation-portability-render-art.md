# AL-009: Save-As audio consolidation / portability (render artifacts)

_Execution-ready spec authored by the sprint bug-hunt/spec workflow (2026-07-10). feasible=False._

# AL-009 — Save-As audio consolidation / portability

> **feasible = false — but not because it can't be done: it is ALREADY DONE.**
> This lane was fully implemented, merged, and test-covered by **PR #125 (`5577c28f auto(AL-009): Save-As audio consolidation / portability`)**. The `docs/auto-loop/backlog.jsonl` entry (line 10) is **stale** — it still reads `"status":"ready"`, which is why the item was handed to a fresh session. The only remaining work is a one-line backlog cleanup. Everything below documents the shipped design with code anchors so a future session can confirm the state in ~5 minutes and NOT re-implement it.

---

## 0. Verdict summary

| Question | Answer | Anchor |
|---|---|---|
| Is Save-As render-artifact consolidation implemented? | **Yes** | `src/engine/RenderArtifacts.h` → `consolidateRenderArtifacts` |
| Is it wired into the Save-As command? | **Yes** | `src/moshops/MoshOps.cpp:7970` (`cmdSaveAs`) |
| Are the read sites (accept / freeze / bounce / snapshot) move-aware? | **Yes** | `resolveCacheArtifact` at MoshOps `6435/6441`, `7049`, `7143`, `7182`, `8667` |
| Is the MoshEngine.cpp seam respected (logic isolated in a helper)? | **Yes** | helper header `RenderArtifacts.h`, invoked from MoshOps, not MoshEngine |
| Is there a portability check mirroring `check_relative_ref_export`? | **Yes** | `scripts/verify-hardware/verify.py:522` `check_render_artifact_portability` |
| Is there a `--selftest` section? | **Yes** | `src/app/SelfTest.cpp:3147–3243` |
| Backlog reflects done? | **No (stale)** | `docs/auto-loop/backlog.jsonl:10` still `"status":"ready"` |

**Recommended action:** flip the backlog entry to done. **Do not** open an implementation PR.

---

## 1. Problem & current behavior (the gap this lane closed)

A Tier-B render layer (`MOSH_RENDERLAYER`, a child of the clip it re-imagines) stores its rendered audio path in `cacheArtifact` (`src/state/Ids.h:185`). `finalizeRender` writes that as an **absolute** path into the shared session pool — `~/Library/Mosh/<session>/renders/<id>/output.wav` — NOT inside the project directory:

- `src/moshops/MoshOps.cpp:6672` — `node.setProperty (ids::cacheArtifact, outputWav.getFullPathName(), nullptr);`

`freeze_layer`, re-`accept_render`, `bounce_layer_to_clip`, and the snapshot's `hasArtifact` flag all depend on that path resolving to a real file.

Before AL-009, `MoshEngine::saveProjectAs` (`src/engine/MoshEngine.cpp:595`) consolidated only **wave-clip sources** and **SamplerPlugin sounds** into the project's `audio/` dir via `MoshEngine::consolidateAudioInto` (`src/engine/MoshEngine.cpp:472`) — it never touched `cacheArtifact`. Consequence: after a Save-As + moving the project folder to another machine (or after the session pool was cleaned), the render artifact path still pointed at the vanished pool → `freeze_layer` / re-`accept_render` failed with *"nothing rendered to freeze/accept"*, and the saved project was not portable.

This is the render-artifact analogue of the **2026-06-22 relative-ref export-hang** fix in `MoshEngine::wireEditResolvers` (`src/engine/MoshEngine.cpp:436–465`): that fix made the wave-clip *read* path move-aware; AL-009 does the same for render artifacts, on both the *write/consolidate* side (Save-As) and the *read/resolve* side (accept/freeze/bounce/snapshot).

---

## 2. Shipped design

Two free functions in a **new helper header** `src/engine/RenderArtifacts.h`, deliberately kept **out of `MoshEngine.{cpp,h}`** (a prime-directive seam — see the backlog note "likely edits MoshEngine.cpp (hard-excluded) → prefer isolating the consolidation in a helper"). They are invoked from `MoshOps`, which already owns the command surface.

1. **`resolveCacheArtifact(stored, editParentDir)`** (`RenderArtifacts.h:36–58`) — mirrors `wireEditResolvers`' `filePathResolver`: an absolute path resolves as-is (legacy/external); a project-relative ref resolves against the edit file's **parent** dir; empty → invalid `File` (the existing "nothing rendered" signal). A `ValueTree` overload reads `child[ids::cacheArtifact]`.
2. **`consolidateRenderArtifacts(editState, editParentDir)`** (`RenderArtifacts.h:70–114`) — depth-first walk of the edit tree for `MOSH_RENDERLAYER` nodes; for each, consolidates **both** `cacheArtifact` **and** `originalSourceRef` (the wave-clip "Reset to original" ref, `Ids.h:188`) into `audio/renders/<layerId>[-original].wav`, de-duping by name+size, then rewrites the property to a **portable relative** ref (`getRelativePathFrom(editParentDir).replaceCharacter('\\','/')`). Idempotent (a second call sees the already-local ref and no-ops), and written **without** an UndoManager (Save-As persistence is not an undoable edit — matches `cmdSaveAs`/`consolidateAudioInto`).

**Control flow on Save-As** (`MoshOps::cmdSaveAs`, `MoshOps.cpp:7950–7977`):
1. `eng.saveProjectAs(file)` — Tracktion `saveAs` + `adoptEditFile` (re-points `editPath` + resolvers) + `consolidateAudioInto` (wave sources + sampler sounds) + `save()`.
2. `mosh::consolidateRenderArtifacts(eng.edit().state, eng.editFile().getParentDirectory())` — the AL-009 pass (`MoshOps.cpp:7970`).
3. `eng.save()` — persist the rewritten relative refs; `emitSnapshotInvalidated()`.

**Read sites made move-aware** (all resolve `cacheArtifact` relative-or-absolute via `resolveCacheArtifact` against `eng.editFile().getParentDirectory()`):
- `accept_render` cache-HIT + apply: `MoshOps.cpp:6435`, `6441`
- `freeze_layer`: `MoshOps.cpp:7049`
- `bounce_layer_to_clip`: `MoshOps.cpp:7143`, `7182`
- snapshot `hasArtifact`: `MoshOps.cpp:8667`

---

## 3. Files (already added/modified — for confirmation, not action)

| File | State | What |
|---|---|---|
| `src/engine/RenderArtifacts.h` | **added** (PR #125) | the two helper functions; header-only, no MoshEngine edit |
| `src/moshops/MoshOps.cpp` | **modified** | `#include "engine/RenderArtifacts.h"` (line 3); `consolidateRenderArtifacts` call in `cmdSaveAs` (7970); `resolveCacheArtifact` at all read sites |
| `src/state/Ids.h` | pre-existing | `cacheArtifact` (185), `originalSourceRef` (188) |
| `src/app/SelfTest.cpp` | **modified** | AL-009 section (3147–3243) |
| `scripts/verify-hardware/verify.py` | **modified** | `check_render_artifact_portability` (522–595); registered in the check list at 799 |
| `docs/auto-loop/backlog.jsonl` | **stale** | line 10 still `"status":"ready"` → the only follow-up |

`MoshEngine.cpp` / `MoshEngine.h` were **not** edited for the consolidation logic (the seam concern was honored). The pre-existing `wireEditResolvers`/`consolidateAudioInto`/`saveProjectAs` in MoshEngine are the wave-clip machinery this pass extends, not part of the AL-009 change.

---

## 4. Commands / contracts affected

**Zero new commands; zero contract change; fully additive/internal.** `save_as`, `freeze_layer`, `accept_render`, `bounce_layer_to_clip` keep their exact arg/result shapes. The only observable behavioral delta is *positive*: after a Save-As + move, artifact-gated ops now succeed where they previously failed, and the on-disk `.tracktionedit` carries a co-located relative ref instead of an absolute pool path. No `ui/` change is required (the snapshot `hasArtifact` bool is unchanged in shape).

---

## 5. Test plan (already implemented — these are the existing guards)

**`--selftest` section "AL-009: Save-As render-artifact consolidation + portability"** (`SelfTest.cpp:3147–3243`) asserts:
- render a fake-adapter layer → `hasArtifact` true (artifact in the pool);
- `save_as` to a dir outside the pool creates `audio/renders/` and consolidates ≥1 wav; artifact still resolves;
- the saved `.tracktionedit` contains **no** absolute pool path and references `audio/renders/` **without** a `../` prefix;
- copy the project elsewhere, **delete the original pool render**, `open_project` the copy → artifact resolves to the co-located copy;
- `freeze_layer` and `accept_render` succeed on the moved project; wave-accept creates no lane; teardown restores the session edit.

**`verify.py --gate` → `check_render_artifact_portability`** (`verify.py:522–595`, mirrors `check_relative_ref_export`): renders a fake layer offline (`MOSH_ENABLE_TRANSFORM=0`), `save_as`, asserts consolidation + relative ref + no pool path, then moves the project, deletes the pool render, reopens, runs `freeze_layer`/`accept_render`/`export_audio`, and asserts the export is **non-silent** (`rms > 0.001`) — proving the moved render is not just resolvable but audibly correct.

**Re-verification recipe for a future session (to confirm nothing regressed):**
```
# from a built app/test binary (see docs/PROGRESS.md / run-mosh.sh for build)
Mosh --selftest            # expect the AL-009 section green (grep "AL-009")
python3 scripts/verify-hardware/verify.py --gate   # expect "Render-artifact portability (AL-009)" pass
```
No new Catch2 unit, vitest, or py-golden is warranted — the header is pure path arithmetic exercised end-to-end by the two integration guards above, which is the correct altitude for a filesystem-portability feature.

---

## 6. Risks & seam concerns

- **`MoshEngine` (hard-excluded seam): respected.** All AL-009 logic lives in `RenderArtifacts.h` + `MoshOps::cmdSaveAs`; MoshEngine was not touched for the new behavior. This is exactly the mitigation the backlog note requested, and it is why the item did **not** end up human-gated.
- **`src/state` (schema): untouched.** `cacheArtifact` / `originalSourceRef` already existed; no format bump, no `Migrations.h` change — the values change from absolute to relative strings, which the resolver reads either way. Legacy projects with absolute refs still open (absolute branch of `resolveCacheArtifact`).
- **Plugins/hosting, deploy, CI: untouched.**
- **Interaction with the 2026-06-22 export-hang fix:** `resolveCacheArtifact` intentionally duplicates the absolute-vs-relative discipline of `wireEditResolvers`' `filePathResolver`; the relative refs written here use the parent-relative form (`getRelativePathFrom(editParentDir)`), which is the form that resolver's first branch resolves, so there is no re-introduction of the `../`-too-high hang. The selftest/verify guards both prove offline render/export completes (no hang) after a move.
- **Residual (out of scope, none blocking):** none identified. MIDI-"beneath" hidden renders are covered transitively — the hidden wave clip's source is consolidated by MoshEngine's `consolidateAudioInto` wave-clip pass, and its render layer (under the source MIDI clip) is caught by the recursive `consolidateRenderArtifacts` walk.

---

## 7. Acceptance criteria (all currently met)

1. `save_as` consolidates every render layer's `cacheArtifact` (and `originalSourceRef`) into `audio/renders/` and re-points them with a portable relative ref. ✅ (`MoshOps.cpp:7970` + `RenderArtifacts.h:70`)
2. `freeze_layer` and re-`accept_render` succeed after the project is moved and the original session pool is gone. ✅ (selftest 3232–3238; verify 579–592)
3. A portability check mirroring `check_relative_ref_export` proves it. ✅ (`verify.py:522`)
4. Native gate green; no MoshEngine.cpp edit for the new logic. ✅
5. **Remaining:** `docs/auto-loop/backlog.jsonl` AL-009 flipped from `"status":"ready"` → done/landed. ⛔ (stale — see §8)

---

## 8. Size & merge posture

- **Implementation lane: 0 (already merged, PR #125).**
- **Only follow-up — backlog hygiene (S, auto-mergeable):** edit `docs/auto-loop/backlog.jsonl` line 10 to set AL-009 `"status"` to `"done"` (or the loop's landed marker) and note "landed in #125; verified by SelfTest AL-009 section + verify.py check_render_artifact_portability." Docs-only, no code, no gate risk → safe to auto-merge. Optionally add `"pr":125` for traceability.

If a future session was dispatched to *build* this, it should **stop and reconcile the backlog** rather than produce a duplicate implementation — the presence of `RenderArtifacts.h`, the `cmdSaveAs` wiring, and the two named test guards are the unambiguous signal that the work is complete.
