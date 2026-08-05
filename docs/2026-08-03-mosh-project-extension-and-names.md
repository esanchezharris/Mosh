# PRJ-NAME — projects are `.mosh`, and a new one is called "untitled - bearcat"

*2026-08-03. Branch `claude/custom-msh-project-naming-441f10`.*

Three related changes to what a saved project **is** on disk:

1. **Extension** — `.tracktionedit` → **`.mosh`**. The raw Tracktion Engine format name was
   leaking through a product seam it had no business being in.
2. **Finder identity** — `.mosh` is now a Mosh-owned exported document type: the Moshi face
   as the file icon, and double-click opens the project.
3. **Names** — `untitled-1722693847234` → **`untitled - bearcat`**. Still obviously unnamed,
   but memorable and speakable, so two unsaved sessions are distinguishable at a glance.

Nothing on disk is migrated. Pre-rename projects keep opening, keep their extension, and
keep saving in place.

---

## Why it was cheap

The Tracktion save/load path is **extension-agnostic**. `editFileSuffix` appears only in the
legacy `Project`/`ProjectItem` system (which Mosh does not use) and in the *no-arg*
`EditFileOperations::saveAs()` chooser. Mosh calls `saveAs (file, true)` and
`te::loadEditFromFile (engine, file)` — both take the path verbatim. The extension lived in
three live sites, and the snapshot already carried `session.projectExtension`
([MoshOps.cpp:2246](../src/moshops/MoshOps.cpp)), which `ui/src/bridge.mock.ts` was already
faking as `.mosh`. The seam had anticipated this.

No new MoshOps command, so the four-registration rule did not apply.

## Shape

- **[`src/state/ProjectName.h`](../src/state/ProjectName.h)** — new, header-only and
  engine-free (juce_core only), so it unit-tests in `MoshTests` with no engine. Holds the
  extension constants, the word list, `generateName(seed)` (pure, deterministic — the caller
  supplies the randomness, which is what makes it RED-provable), `resolveSessionEditFile`,
  and `projectPathFromOpenArgs`.
- **`cmdNewProject`** re-rolls on collision (bounded, then numeric suffixing). The word space
  is finite; silently reusing a path would destroy an unsaved project.
- **UI** — `ui/src/projectFile.ts` is the one place the label regex and the picker filters
  live. `TopBar` and `SessionPicker` each carried their own copy of the same regex; both now
  call the shared helper.
- **Doc type** — `cmake/BuildDocumentIcon.cmake` derives `Resources/MoshDoc.icns` from the
  same PNG as the app icon; the plist keys go in `cmake/MoshRemoteInfo.plist` **and**
  `cmake/InjectInfoPlistKeys.cmake`.

---

## Traps worth remembering

### The document icon does not apply when the bundle sits in a hidden directory

This cost the most time, and it is a **worktree-only** artifact — worth knowing before you
conclude the feature is broken.

A build inside `.claude/worktrees/...` registers fine (`lsregister -dump` shows the UTI as
`exported trusted` with the right `iconFiles` path), but the extension still resolves to a
*dynamic* UTI (`dyn.ah62…`) and files render as a blank page. `ditto` the same bundle to a
non-hidden path and re-register, and the type binds immediately (`kMDItemContentType =
studio.mosh.project`) and the icon appears. The shipped app lives in `/Applications`, so this
never affects a real install.

### Verify the icon by asking macOS, not by trusting the plist

Every automated guard passed while the icon was still a blank page. The plist can be perfect,
the `.icns` present and valid, the UTI registered — and the file still generic. What settles
it is `NSWorkspace.icon(forFile:)` on a real file, compared against a known-generic file's
hash. Sanity-check the instrument too: a probe that returns "generic" for *everything* proves
nothing, so assert that `Mosh.app` and some system app come back distinct first.

`NSWorkspace.icon(for: UTType)` is the useful second probe — it isolates "is the type→icon
mapping live" from "is this file's icon cached", which is exactly where the confusion sits.

### `PLIST_TO_MERGE` is dropped under Ninja

Already documented for the privacy keys; it bit again here. The document-type keys ship only
because `InjectInfoPlistKeys.cmake` writes them with `plutil`. That script now also
fail-closes on a missing `CFBundleDocumentTypes`, a missing `UTExportedTypeDeclarations`, and
a missing `Resources/MoshDoc.icns` — all three degrade **silently and identically** (generic
icon, dead double-click), which is precisely the bug this work existed to fix.

### A guard that cannot fail — caught in the act

`projectPathFromOpenArgs` originally skipped tokens starting with `-`. Deleting that guard
broke **no test**: flags like `--selftest` are already rejected by the extension and
existence checks, so the assertions "covering" it passed either way. The guard's real
precondition is *absolute path* (`juce::File`'s ctor jassert-fails on a relative one), and
that **is** falsifiable — proven with a real, existing `.mosh` in the cwd that must still be
refused when named relatively. The lesson is the usual one: sabotage each guard individually
and confirm it fails *something*.

### The legacy session file would have been stranded

Renaming the default `session.tracktionedit` → `session.mosh` naively means an existing
session cold-starts **blank right next to the user's work** — data loss as far as anyone can
tell. `resolveSessionEditFile` falls back to the legacy file when only it exists. That branch
is unreachable from a `MoshEngine` test (its session dir always has a live `session.mosh`),
which is why the resolution is a pure function over a directory.

---

## Verification

- `MoshTests` — **4427 assertions / 302 cases** green, including 10 new `[projectname]` cases.
  Every guard RED-proven individually (duplicate word, spaced word, capital, dropped prefix,
  illegal char, dropped exists/extension/quote/legacy/absolute-path checks), each failing only
  its intended assertion, with the restore verified byte-identical by sha256.
- `Mosh --selftest` — **2316/2316 ×3**, deterministic. New checks cover the previously
  **untested** unnamed `new_project` path (the one a producer actually gets from ⌘N), the
  no-clobber re-roll, and a legacy `.tracktionedit` round-trip via `save_as` → `open_project`
  → `save`.
- `vitest` 2333 passed / 1 skipped · `tsc` clean.
- Build-time guards RED-proven by removing `MoshDoc.icns` and by stripping each plist key —
  each aborts the build with its own message.
- **Finder icon confirmed visually**: a `.mosh` file's icon hash matches the UTI icon exactly
  and differs from both the generic blank page and a `.txt`.
- e2e: 255 passed, 8 failed — **pre-existing**, confirmed by A/B against a stashed tree
  (`agent-loop`, `templates`, `walkthrough` fail identically without these changes).

`.tracktionedit` is deliberately **not** claimed as a document type — only opened by path.
Claiming it would take the extension from Tracktion/Waveform.

## Not covered by an automated gate

Double-click-to-open is wired (`anotherInstanceStarted` → `open_project` through MoshOps) and
its argument parsing is unit-tested, but the live Finder double-click was not exercised — that
needs a GUI session.
