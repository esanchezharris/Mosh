# Project File-Management Data-Safety Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development per task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the three confirmed file-management data-safety gaps (verified 2026-06-17, memory `project-file-management-state.md`): (1) no auto-save/save-on-quit, (2) relaunch never reopens last project, (3) projects non-portable (shared absolute-path audio pool). Each lands with a `SelfTest.cpp` check; verified via `Mosh --selftest`.

**Architecture:** All three are engine/MoshOps changes behind the existing one-mutation-path + snapshot/events seam. No new undo system, no new mutation path. Gap-1 close behavior = **silent auto-save** (user decision 2026-06-17): save-on-quit + periodic ~30 s auto-save + a dirty flag; **no** modal prompt. Gap-2 persists `last-project.json`; the ctor resolves the startup edit from it. Gap-3 sets `filePathResolver` + consolidates referenced audio into a project-local `audio/` dir on Save-As, making the saved project self-contained, plus a `relink_clip` command and a `sourceMissing` snapshot flag.

**Tech Stack:** C++ (JUCE 8 / Tracktion Engine, pinned `2877b621`), React/TS UI (`ui/src/ui`), headless `SelfTest.cpp` harness. Build: Ninja/Debug, `cmake --build build --target Mosh`; verify `build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest`.

---

## Files touched

- `src/engine/MoshEngine.h` / `.cpp` — dirty flag + `markDirty/isDirty/saveIfDirty`; `last-project.json` persistence (`rememberProject`, `startupEditFile`, `recentProjects`); ctor startup-file resolution; `wireEditResolvers()` (sets `editFileRetriever` + `filePathResolver` everywhere); `consolidateAudioInto()` for Save-As; post-adopt `save()` in `openProject`.
- `src/moshops/MoshOps.h` / `.cpp` — `markDirty()` hook in `beginTxn` + `cmdSetProjectSettings`/`cmdSetKey`; snapshot `session.dirty`, `session.recentProjects`; per-clip `sourceMissing` in `clipToVar`; `cmdRelinkClip` + dispatch; Save-As consolidation call.
- `src/app/Main.cpp` — periodic auto-save timer (GUI only) + save-on-quit in `shutdown()`.
- `src/app/SelfTest.cpp` — new checks for all three gaps (incl. the previously-uncovered app-restart path via `startupEditFile`).
- `ui/src/ui/TopbarTools.tsx`, `ui/src/types.ts`, `ui/src/bridge.mock.ts` — Recent Projects list; `relink_clip`; `sourceMissing`/`recentProjects`/`dirty` types.

## Design decisions (locked)

- **Dirty signal:** `beginTxn()` marks the engine dirty (covers every undoable mutation); the two non-undoable edit-state mutators (`set_project_settings`, `set_key`) call `markDirty()` explicitly. Over-marking is harmless (an extra idempotent save); under-marking risks data loss, so we err toward marking. `save()`/`saveIfDirty()` clear it; `new/open/reload/saveAs` leave the edit **clean** (just persisted/loaded from disk).
- **Auto-save timer lives in `MoshApplication`** (a GUI-only concern), not MoshOps' 30 Hz telemetry timer. Headless `--selftest` never starts it, so the mechanism is tested directly via `eng.saveIfDirty()`.
- **Startup resolution is a testable method** `MoshEngine::startupEditFile()` — the ctor calls it; the SelfTest calls it after seeding `last-project.json` (this is the app-restart path that went undetected). Falls back to `session/session.tracktionedit` when last-project is absent/missing.
- **`filePathResolver`**: absolute stored paths resolve as-is (legacy); relative paths resolve against the `.tracktionedit`'s directory. Mirrors Tracktion's own default but is set explicitly and consistently wherever the Edit is (re)wired.
- **Consolidation on Save-As**: copy each referenced wave-clip source into `<projectDir>/audio/`, then re-point the clip's `SourceFileReference` with `useRelativePath=true` so the on-disk `source` becomes `audio/<file>` — portable. Files already under `<projectDir>` are skipped. Order: copy → `saveAs` → adopt(newFile) → re-point relative → `save()`.
- **Relink**: `clipToVar` adds `sourceMissing:true` when the source file is absent; `relink_clip {clipId,file}` re-points the source (undoable). UI shows a Relink affordance on missing clips.

## VERIFY at implementation time (pinned clone)

- `te::WaveAudioClip::getSourceFileReference()` → `SourceFileReference::setToDirectFileReference(const juce::File&, bool useRelativePath)` (confirmed in `tracktion_SourceFileReference.cpp`).
- `te::EditFileOperations(edit).saveAs(file, bool)` (already used in `saveProjectAs`).
- Iterating wave clips: `te::getAudioTracks(edit)` → `track->getClips()` → `dynamic_cast<te::WaveAudioClip*>`.

---

## Task 1 — Gap 1: dirty flag + saveIfDirty (engine)

**Files:** `src/engine/MoshEngine.h`, `src/engine/MoshEngine.cpp`

- [ ] Add `bool dirty=false;` member; public `markDirty()`, `isDirty() const`, `bool saveIfDirty()`.
- [ ] `save()` sets `dirty=false` on success. `reloadFromFile/newProject/openProject/saveProjectAs` set `dirty=false` after their load/persist.
- [ ] `saveIfDirty()` → `if (!dirty) return false; const bool ok = save(); return ok;` (save() already clears dirty).
- [ ] MoshOps: `beginTxn` calls `eng.markDirty()`; `cmdSetProjectSettings` + `cmdSetKey` call `eng.markDirty()` before ok return.
- [ ] Snapshot `session.dirty = eng.isDirty()`.

## Task 2 — Gap 1: auto-save timer + save-on-quit (app)

**Files:** `src/app/Main.cpp`

- [ ] `MoshApplication` holds an auto-save `juce::Timer` (nested struct) started only in GUI mode (after `mainWindow` is created), 30 000 ms, callback → `if (engine) engine->saveIfDirty();`.
- [ ] `shutdown()`: at the top, `if (engine && mainWindow) engine->saveIfDirty();` **before** any reset (save-on-quit; GUI-only via the `mainWindow` gate so headless harnesses are untouched).

## Task 3 — Gap 2: last-project persistence + startup resolution

**Files:** `src/engine/MoshEngine.h/.cpp`, `src/moshops/MoshOps.cpp`

- [ ] `rememberProject(const juce::File&)` — write `session/last-project.json` = `{ "last": <abs>, "recent": [<abs>...≤10, newest-first, deduped, existing-only] }`.
- [ ] `juce::File startupEditFile() const` — last-project.json `last` if it exists-as-file, else `session/session.tracktionedit`.
- [ ] `juce::var recentProjects() const` — parse `recent`, filter to existing, `[{path,name}]`.
- [ ] Ctor: set `editPath = freshSession ? session/session.tracktionedit : startupEditFile()` (fresh harness keeps the fixed file; the dir was just wiped so last-project.json never exists there).
- [ ] `newProject/openProject/saveProjectAs` call `rememberProject(file)`. `openProject` also gains the post-adopt `save()` that `newProject` has.
- [ ] Snapshot `session.recentProjects = eng.recentProjects()`.

## Task 4 — Gap 3: filePathResolver + consolidate-on-save-as + relink

**Files:** `src/engine/MoshEngine.h/.cpp`, `src/moshops/MoshOps.cpp`

- [ ] `wireEditResolvers()` — sets `editFileRetriever` + `filePathResolver` (absolute→as-is, relative→`editPath.getParentDirectory().getChildFile`). Call it everywhere the Edit is created/loaded (ctor, reloadFromFile, newProject, openProject, adoptEditFile).
- [ ] `consolidateAudioInto(const juce::File& projectDir)` — for each wave clip whose source is **not** already under `projectDir`, copy into `projectDir/audio/<name>` (dedup name collisions) and `setToDirectFileReference(copied, true)`.
- [ ] `saveProjectAs`: `saveAs → adopt → consolidateAudioInto(parent) → save()`.
- [ ] `clipToVar`: add `sourceMissing` when `!getCurrentSourceFile().existsAsFile()`.
- [ ] `cmdRelinkClip {clipId,file}` (undoable: `setToDirectFileReference(File, useRelativePath=under-project)`), dispatch entry `relink_clip`.

## Task 5 — SelfTest coverage

**File:** `src/app/SelfTest.cpp` (new section near the existing project-lifecycle block ~1748)

- [ ] **Gap 1:** clean→`create_track`→`isDirty()` true→`saveIfDirty()` true + clean→`saveIfDirty()` false; `save` clears dirty; snapshot `session.dirty` tracks.
- [ ] **Gap 2 (restart):** `rememberProject(tmpProj)` ⇒ `startupEditFile()==tmpProj`; remove json / point to missing ⇒ fallback to `session.tracktionedit`; after `new_project`, `last-project.json` exists + `startupEditFile()` is the new project; `snapshot.session.recentProjects` lists newest-first.
- [ ] **Gap 3 (portability):** add_test_tone_clip → `save_as` to a temp dir → `<dir>/audio/*.wav` exists; on-disk `.tracktionedit` `source` is relative (no shared-session-pool abspath); copy `<dir>`→`<dir2>`, rename the *original* session audio so only the co-located copy can resolve, `open_project <dir2>/x.tracktionedit` → clip resolves, `sourceMissing` false. Relink: clip → delete source → `sourceMissing` true → `relink_clip` → false. Restore session edit at teardown.

## Task 6 — UI

**Files:** `ui/src/ui/TopbarTools.tsx`, `ui/src/types.ts`, `ui/src/bridge.mock.ts`

- [ ] Types: `session.dirty?`, `session.recentProjects?: {path,name}[]`, clip `sourceMissing?`.
- [ ] Project popover: render Recent list → `open_project {file:path}`; show a Relink affordance for clips with `sourceMissing` (file picker → `relink_clip`).
- [ ] Mock: handle `relink_clip` (ok), and surface `recentProjects`/`dirty` defaults so the web mock + vitest stay green.

## Verification

- [ ] `cmake --build build --target Mosh` clean.
- [ ] `Mosh --selftest` **×3**, identical pass counts, **0** assertions (per `mosh-verification-conventions`; kill stray procs / free port 8770 between runs).
- [ ] `cd ui && npm test` green (UI types/mock).

## Self-review notes

- Spec coverage: gaps 1/2/3 each map to Tasks 1-2 / 3 / 4, all with SelfTest checks (Task 5). The app-restart path (undetected cause of gap 2) is covered by `startupEditFile()`.
- No placeholders: APIs cited from the pinned clone; the 3 VERIFY items confirmed before relying.
- Type consistency: `markDirty/isDirty/saveIfDirty`, `rememberProject/startupEditFile/recentProjects`, `wireEditResolvers/consolidateAudioInto`, `relink_clip`/`sourceMissing` used consistently across engine ↔ MoshOps ↔ UI.
