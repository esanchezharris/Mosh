# 2026-07-10 — iCloud content eviction broke the shared CPM dep cache (`juce_add_modules`)

**Symptom.** Configuring any fresh worktree with the seeded cache config from
`~/.mosh-auto-loop/auto-loop.env` failed under CMake 4.3.2:

```
CMake Error at .../.cpm-cache/_fc/tracktion_engine-src/modules/juce/modules/CMakeLists.txt:33 (juce_add_modules):
  Unknown CMake command "juce_add_modules".
```

Reproduced 2026-07-10 on a scratch build dir (worktree `elegant-curie-5c6f86`) with the
then-current env values `AL_CPM_CACHE=~/Documents/ClaudeMosh/.cpm-cache`,
`AL_TRACTION_SRC=~/Documents/ClaudeMosh/.cpm-cache/_fc/tracktion_engine-src`.

## Root cause: iCloud evicted file *content* under the main checkout

`~/Documents` is iCloud-synced. The `.cpm-cache/_fc/tracktion_engine-src` clone that
lived there was hollowed out by eviction — **4,476 working-tree files carried the
macOS `dataless` flag** (plus 39 under its `.git`), and its git object store is corrupt
(`pack-7543ad02… is far too short to be a packfile`). This is the same incident class as
the 2026-07-09 "iCloud ate the `.git` object store" corruption (its write-up,
`CONSOLIDATION_2026-07-09.md`, was pruned in the public-cleanup pass; the surviving
lesson is the worktree-builds gotcha in [`CLAUDE.md`](../CLAUDE.md)).

The specific kill chain for the CMake error:

1. `modules/juce/extras/Build/CMake/JUCEModuleSupport.cmake` is dataless: `stat` reports
   **29,272 bytes**, but every read returns **0 bytes** (MD5 of the read = the
   empty-input hash `d41d8cd9…`). Re-reads do not materialize it — the cloud copy is
   apparently gone (orphaned eviction), so the content is permanently unreadable.
2. JUCE's top-level `CMakeLists.txt:50` does `include(extras/Build/CMake/JUCEModuleSupport.cmake)`.
   Including a file that reads as empty **succeeds silently** — so `juce_add_modules`
   (defined at line 681 of that file) never comes into existence.
3. `add_subdirectory(modules)` then hits `juce_add_modules` at
   `modules/juce/modules/CMakeLists.txt:33` → *Unknown CMake command*.

So: not a CMake 4.3.2 incompatibility, not a bad pin (both clones are `2877b621`), and
not the missing-patches gotcha — plain content eviction. Eviction behavior is also
**nondeterministic per file**: `tracktion_AutomatableParameter.cpp` (also flagged
dataless) *did* materialize on read, while `JUCEModuleSupport.cmake` never does. A cache
under iCloud can therefore rot silently and partially at any time.

**Second, independent disqualifier:** the `_fc` clone predates engine patches 0002/0003
(populated Jul 9 08:11, before the consolidation landed them). Its `tracktion_Edit.cpp`
matches the patched clone (patch 0001 was applied by FetchContent at populate time), but
`tracktion_AutomatableParameter.{cpp,h}` (patch 0003) genuinely differ. Even a healed
copy would silently rebuild the pre-#260 engine (VST3HostContextHeadless leaks +
nested-undo asserts back).

## Fix

1. **`~/.mosh-auto-loop/auto-loop.env` rewritten (2026-07-10)** to the proven non-iCloud
   values — the same ones the 2026-07-09 consolidation gate builds used
   (`~/Library/Mosh/work/gate2/build-gate/CMakeCache.txt`):

   ```
   AL_CPM_CACHE="$HOME/Library/Mosh/work/cpm-cache"
   AL_TRACTION_SRC="$HOME/Library/Mosh/work/deps/tracktion_engine-src"
   ```

   The `deps` clone carries patches 0001–0003 **in its working tree** — required because
   `FETCHCONTENT_SOURCE_DIR_*` bypasses `PATCH_COMMAND`. Verify with
   `git -C ~/Library/Mosh/work/deps/tracktion_engine-src status --short` (expect the
   modified AutomatableParameter/Edit files + a modified `modules/juce` submodule).

2. **`scripts/auto-loop/seed-cache.sh` reworked** so a future re-seed cannot regress:
   - The cache root is now `${MOSH_WORK_DIR:-$HOME/Library/Mosh/work}/cpm-cache`, never
     the main checkout's `.cpm-cache` (which sits under iCloud).
   - It prefers the blessed patched clone at `…/work/deps/tracktion_engine-src` when
     present (warning if its working tree is clean, i.e. patches missing), falling back
     to a cache-populated `_fc` clone (which gets the patches via `PATCH_COMMAND` at
     populate time).
   - The "already seeded" validity check now **rejects iCloud paths** and runs a
     **content-eviction probe** (`JUCEModuleSupport.cmake` must read back exactly the
     size `stat` reports), so a rotten config self-heals on the next run instead of
     poisoning every worktree build.

## Rule of thumb

Nothing a build reads may live under `~/Documents` (or any `Mobile Documents` path):
not the git object store (learned 2026-07-09), not dep caches or fetched sources
(learned here), not venvs (learned 2026-07-03). Machine-local build state belongs under
`~/Library/Mosh/`.

## Residual risk (flagged, not fixed here)

The *default* cache location is still in-source: `CMakeLists.txt:24-25` sets
`CPM_SOURCE_CACHE`/`FETCHCONTENT_BASE_DIR` to `${CMAKE_SOURCE_DIR}/.cpm-cache[/_fc]`,
and `run-mosh.sh:296` (anira build) hardcodes `-DCPM_SOURCE_CACHE="$ROOT/.cpm-cache"`.
Any configure that doesn't override these — in the main checkout *or* in a
`.claude/worktrees/*` worktree, all of which live under `~/Documents` — re-creates an
iCloud-exposed cache (that is how the rotten one was born). The auto-loop/gate path is
safe now (always overrides via `auto-loop.env`), but the bare-`cmake --preset` and
`run-mosh.sh` anira paths can regress. Fixing the default needs platform care (Linux CI
uses the in-tree path legitimately), so it is left as a labeled follow-up.

## Leftover

`~/Documents/ClaudeMosh/.cpm-cache/` is now unreferenced and unusable (evicted +
corrupt pack). It can be deleted whenever convenient; it is not trusted by anything
after this fix.
