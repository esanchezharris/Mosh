# G7: Stem export (per-track, common zero point)

_Execution-ready spec authored by the sprint bug-hunt/spec workflow (2026-07-10). feasible=True._

# G7 — Stem export (per-track, common zero point)

**Status:** feasible, native, additive. Size **M**, **auto-mergeable** (confined to MoshOps + LockManager + additive UI + tests + docs; no hard-excluded seam touched).

Satisfies reality-pack **invariant 84** — *"Stem export names and aligns each stem from the same zero point"* (`docs/reality-pack/mosh_daw_reality_model.md:146`) — and flips backlog row **G7** in `scripts/daw-conformance/scoreboard.py:34`.

---

## 1. Problem & current behavior

`export_audio` renders the **whole edit to one file**. The render window and track set are hardcoded:

- `src/moshops/MoshOps.cpp:7393-7394` —
  ```cpp
  params.time      = { tracktion::TimePosition(), edit.getLength() };
  params.tracksToDo = te::toBitSet (te::getAllTracks (edit));   // ALL tracks → one mix
  ```
- `params.useMasterPlugins = true` (`:7396`) — the master chain is baked into the single output.
- Handler: `MoshOps::cmdExportAudio` (`src/moshops/MoshOps.cpp:7236-7473`); dispatch at `:930`; declared in `src/moshops/MoshOps.h:269`.

There is **no per-track stem path**. The one existing single-track render is `MoshOps::bounceClipToWav` (`src/moshops/MoshOps.cpp:6189-6260`), which already proves the primitive we need:

```cpp
juce::Array<te::Track*> just; just.add (track);
params.tracksToDo   = te::toBitSet (just);     // ONLY this track
params.allowedClips.add (&clip);               // (clip-scoped — we DON'T want this for stems)
params.usePlugins       = true;                // instrument + insert FX = the track's sound
params.useMasterPlugins = false;               // NOT the master mix
params.time = { start, end };                  // clip window (stems need {0, editLength} instead)
```

So the mechanism to render one track exists; what's missing is: (a) a loop over tracks, (b) a **common** `{0, editLength}` window for every stem (the "same zero point" — so re-imported stems line up sample-for-sample), (c) per-stem file naming, (d) a result envelope listing the stems.

Frontend export entry points (for the optional UI rung): `ui/src/ui/ExportControls.tsx:23`, `ui/src/menuActions.ts:101-106`, menu wiring `src/app/MenuController.cpp:150,177`.

---

## 2. Proposed design

Add a new MoshOps command **`export_stems`** that mirrors `cmdExportAudio` but renders **each non-hidden audio track to its own file** over the **shared window `{TimePosition(), edit.getLength()}`**.

Design decisions (each defensible, documented in code comments):

- **Common zero point.** Every stem uses `params.time = { TimePosition(), edit.getLength() }` — identical to the mix window. A track whose clips start at bar 8 yields a stem with 8 bars of leading silence, so all stems are the same length and re-align on import. This is the literal reading of inv 84.
- **Pre-master.** `params.useMasterPlugins = false`; `params.usePlugins = true`. Stems are each track's own post-fader/post-insert signal; summing them (+ master chain) reproduces the mix. Mirrors `bounceClipToWav:6219-6220`.
- **NO `allowedClips`.** Unlike `bounceClipToWav`, we render the whole track (all its clips), so we do **not** populate `params.allowedClips`.
- **Track set.** Iterate `te::getAudioTracks(edit)`, **skip** `moshHidden` tracks (mirrors the snapshot filter at `src/moshops/MoshOps.cpp:8281` — the Phase-2 beneath-render track must never leak into a stem set). Optionally skip clip-less tracks (default) so we don't emit silent files; `includeEmpty:true` overrides. Folder/group tracks are excluded (we iterate `getAudioTracks`, not `getAllTracks`).
- **Mute/solo semantics.** Because each render's `tracksToDo` is a single track, other tracks' **solo** is irrelevant by construction. A track's own **mute** is honored (a muted track yields a silent stem) — the correct, least-surprising behavior; documented.
- **Render mode.** Compute once, edit-wide, exactly like `cmdExportAudio:7332-7352` via `findSerumRealtimeRenderReason(edit)` — if any realtime-only synth is present, all stems render realtime (a safe superset).
- **Naming.** Per-export directory; each stem `NN-<sanitizedTrackName>.<ext>` (`NN` = zero-padded snapshot index, guaranteeing uniqueness even for duplicate names). Sanitize via `juce::File::createLegalFileName`.
- **Envelope.** Return `{ dir, format, bitDepth, sampleRate, seconds, count, stems:[{ trackId, logicalId, name, index, file, bytes }] }`.
- **Non-undoable, unguarded, not agent-callable** — identical posture to `export_audio` (no `beginNewTransaction`; added to LockManager's `unguarded` set; kept out of `AGENT_COMMANDS`).

**Shared-helper refactor (recommended).** The format / bit-depth / sample-rate resolution block in `cmdExportAudio` (`:7246-7383`) is ~130 lines and would drift if duplicated. Extract a private helper:

```cpp
struct ExportSettings { juce::AudioFormat* format; juce::String formatName; juce::String extension;
                        int bitDepth; double sampleRate; juce::String error; };
ExportSettings MoshOps::resolveExportSettings (const juce::var& args);   // returns .error non-empty on reject
```

Both `cmdExportAudio` and `cmdExportStems` call it. If reviewers prefer a smaller diff, duplicating the block into `cmdExportStems` is acceptable (the golden gate catches divergence), but extraction is preferred.

---

## 3. Exact files to add/modify

### `src/moshops/MoshOps.h` (modify)
- Declare the handler beside `cmdExportAudio` (`:269`): `juce::var cmdExportStems (const juce::var& args);`
- (If refactoring) declare `ExportSettings resolveExportSettings (const juce::var& args);` and the `ExportSettings` struct in the private section.

### `src/moshops/MoshOps.cpp` (modify)
- **Dispatch**: after `:930` add `if (name == "export_stems") return cmdExportStems (args);`
- **(Refactor)** Extract `resolveExportSettings` from the body of `cmdExportAudio:7246-7383`; have `cmdExportAudio` call it (behavior byte-identical — the golden gate proves this).
- **New `cmdExportStems`** (place after `cmdExportAudio`). Shape:
  ```cpp
  juce::var MoshOps::cmdExportStems (const juce::var& args)
  {
      auto& edit = eng.edit();
      const auto s = resolveExportSettings (args);          // format/depth/rate + validation
      if (s.error.isNotEmpty()) return errResult ("export_stems", s.error);

      // Destination directory: explicit `dir` arg, else sessionDir/exports/stems-<ms>.
      juce::File dir = args.getProperty ("dir", var()).toString().isNotEmpty()
          ? juce::File (args.getProperty ("dir", var()).toString())
          : eng.sessionDir().getChildFile ("exports")
                .getChildFile ("stems-" + String (Time::getCurrentTime().toMilliseconds()));
      dir.createDirectory();

      const bool includeEmpty = (bool) args.getProperty ("includeEmpty", false);

      // Render exclusivity teardown ONCE (mirror cmdExportAudio:7360-7363).
      unregisterAllMeterClients();
      edit.getTransport().stop (false, false);
      edit.getTransport().freePlaybackContext();
      lastSeenContext = nullptr;

      // Edit-wide render mode (mirror cmdExportAudio:7332-7352).
      const auto rtReason = findSerumRealtimeRenderReason (edit);
      const bool realtime = rtReason.isNotEmpty()
                            || args.getProperty ("renderMode", "auto").toString().toLowerCase() == "realtime";

      const double len = juce::jmax (0.1, edit.getLength().inSeconds());
      juce::Array<var> stems; juce::String firstError; int index = 0;

      for (auto* t : te::getAudioTracks (edit))
      {
          if (t == nullptr) continue;
          if ((bool) t->state.getProperty (ids::moshHidden, false)) continue;   // Phase-2 hidden track
          const int myIndex = index++;                                          // matches snapshot index
          if (! includeEmpty && t->getClips().isEmpty()) continue;

          auto file = dir.getChildFile (String (myIndex).paddedLeft ('0', 2)
                          + "-" + juce::File::createLegalFileName (t->getName()))
                          .withFileExtension (s.extension);
          file.deleteFile();

          te::Renderer::Parameters params (edit);
          params.destFile           = file;
          params.audioFormat        = s.format;
          params.bitDepth           = s.bitDepth;
          params.sampleRateForAudio = s.sampleRate;
          params.blockSizeForAudio  = juce::jmax (512, edit.engine.getDeviceManager().getBlockSize());
          params.time               = { tracktion::TimePosition(), edit.getLength() };   // COMMON zero point
          juce::Array<te::Track*> one; one.add (t);
          params.tracksToDo         = te::toBitSet (one);       // ONLY this track — no allowedClips
          params.usePlugins         = true;                     // instrument + inserts = the track's sound
          params.useMasterPlugins   = false;                    // pre-master; sum + master = the mix
          params.createMidiFile     = false;
          params.realTimeRender     = realtime;

          // ScopedRenderStatus + turnOffAllPlugins + the SAME no-progress watchdog/deadline
          // loop as cmdExportAudio:7401-7451 / bounceClipToWav:6226-6258 (copy verbatim).
          // On per-track error: record firstError, delete the partial, CONTINUE (best-effort;
          // one bad track must not abort the whole set).
          ...

          if (file.existsAsFile() && file.getSize() > 0)
          {
              auto* so = new DynamicObject();
              so->setProperty ("trackId",   t->itemID.toString());
              so->setProperty ("logicalId", logicalid::ensureTrack (t->state));
              so->setProperty ("name",      t->getName());
              so->setProperty ("index",     myIndex);
              so->setProperty ("file",      file.getFullPathName());
              so->setProperty ("bytes",     (juce::int64) file.getSize());
              stems.add (var (so));
          }
      }

      const bool ok = ! stems.isEmpty();
      logLine ("export_stems", args, ok, ok ? String() : (firstError.isNotEmpty() ? firstError
               : String ("no renderable tracks")), false);
      if (! ok) return errResult ("export_stems", firstError.isNotEmpty() ? firstError
                                  : String ("no renderable tracks (all empty or hidden)"));

      auto* data = new DynamicObject();
      data->setProperty ("dir",        dir.getFullPathName());
      data->setProperty ("format",     s.formatName);
      data->setProperty ("bitDepth",   s.bitDepth);
      data->setProperty ("sampleRate", s.sampleRate);
      data->setProperty ("seconds",    len);
      data->setProperty ("count",      stems.size());
      data->setProperty ("stems",      stems);
      return okResult ("export_stems", var (data));
  }
  ```

### `src/multiplayer/LockManager.cpp` (modify)
- Add `"export_stems"` to the `unguarded` set (next to `"export_audio"` at `:24`) — it's a read/render, contends for no track.

### `src/app/MenuController.cpp` (modify — optional UI rung)
- Add `fileExportStems` to the `CommandIDs` enum (`:9`) and `getAllCommands` (`:130`); `getCommandInfo` label *"Export Stems…"* under File; `perform` → `fire ("export_stems");` (mirrors `:150,177`). Add `menu.addCommandItem (&commands, fileExportStems);` near `:89`.

### `ui/src/types.ts` (modify — optional)
- Add `StemExportResult = { dir: string; format: ExportFormat; bitDepth: number; sampleRate: number; seconds: number; count: number; stems: { trackId: string; logicalId: string; name: string; index: number; file: string; bytes: number }[] }` beside `ExportResult` (`:563`).

### `ui/src/keymap.ts` + `ui/src/menuActions.ts` (modify — optional)
- Add `"export_stems"` to the `ActionId` union (`:8-9`) and a `case "export_stems":` in `runAction` that calls `store.exec("export_stems")` (MVP: no dir arg → backend defaults to `sessionDir/exports/stems-<ms>`; show `r.data.dir`). A native folder-picker is a follow-up, not required.

### `ui/src/ui/ExportControls.tsx` (modify — optional)
- Add a second button *"Export stems"* reusing `format`/`bitDepth` state → `exec("export_stems", { format, bitDepth })`; on success show `Exported N stems → <dir>`.

### `ui/src/bridge.mock.ts` (modify — required if any UI/e2e rung lands)
- Add `"export_stems"` to `NON_UNDOABLE` (`:180`) and a mock case (`~:1110`) returning `{ dir:"/mock/stems", format, bitDepth, sampleRate:SR, count:2, seconds:4, stems:[{trackId:"t1",logicalId:"L1",name:"Track 1",index:0,file:"/mock/stems/00-Track_1.wav",bytes:400000}, …] }`.

### `scripts/verify-hardware/verify.py` (modify)
- Add `check_stem_export(ctx)` (see §5) and register it in the check list.

### `scripts/daw-conformance/conformance.py` + `scoreboard.py` (modify) + `docs/FEATURE_AUDIT.md` (regenerated)
- Flip G7 from a gap to pass once the command lands (see §5); regenerate the audit via `scoreboard.py`.

---

## 4. Commands / contracts affected

- **Fully additive.** New command `export_stems`; **no existing command signature changes.** `cmdExportAudio`'s observable behavior is byte-identical (the refactor only relocates code — proven by `verify.py --gate`).
- **Agent catalog:** intentionally **not** added to `AGENT_COMMANDS` (mirrors `export_audio`, which is a menu/UI action, not agent-callable). Therefore the `commands.contract.test.ts` obligation (every declared arg must be read — `ui/src/agent/commands.contract.test.ts:77-92`) does **not** apply. If a future rung makes it agent-callable, every declared arg (`format`/`bitDepth`/`dir`/…) must be read by `cmdExportStems` or the contract test red-flags it.
- **LockManager:** `export_stems` classified `unguarded` (additive to the set).

---

## 5. Test plan (concrete)

### `--selftest` / Catch2 (`src/app/SelfTest.cpp`, in the export section near `:1879-1925`)
Build a 2-track edit with **distinct** content (Track A: `add_test_tone_clip freq 220`; Track B: `add_test_tone_clip freq 660`), then:
- `auto r = cmd (ops, "export_stems", objN({{"dir", stemDir}}));  check (ok(r), "export_stems ok");`
- `check ((int) r["data"]["count"] == 2, "two stems for two non-empty tracks");`
- For each entry in `r["data"]["stems"]`: `File(entry["file"]).existsAsFile() && getSize()>0` and extension `.wav`.
- **Naming**: stem filenames start with `00-`/`01-` and contain the sanitized track names.
- **Hidden-track exclusion**: after a MIDI re-imagine that creates a `moshHidden` track (or synthesize one), assert `count` still equals the number of visible audio tracks (no hidden stem).
- **Empty skip**: add a third clip-less track → `count` stays 2; with `{"includeEmpty":true}` → `count` == 3.
- **Format/depth reject** (shared helper): `export_stems` with `format:"mp3"` fails; `format:"wav", bitDepth:7` fails (mirror `:1914-1920`).
- **No-tracks**: on an empty edit `export_stems` returns `ok:false` with a clear message.
- Clean up `stemDir` at the end (mirror `:1922-1924`).

### `verify.py` (real rendered audio — the "actually correct samples" gate)
`check_stem_export(ctx)`:
- Script: create Track A (220 Hz, 2 s), create Track B (660 Hz, 2 s), `export_stems {dir: ART/stems}`.
- Parse `results[-1]["data"]["stems"]` → assert `len == 2`.
- For each stem WAV: `stats()` → `peak > 0.05`, `rms > 0.01` (non-silent), and **`duration_s` equal across both stems** (the common zero point — same length).
- **`diff_rms(stemA, stemB) > 0.05`** — the two stems are genuinely different signals (not both the full mix).
- Also export the full mix and assert **`diff_rms(stemA, fullmix) > 0.0`** (a single stem ≠ the mix). *(Alignment is structural — both stems share `{0, editLength}` — so no cross-correlation needed; equal frame counts + independent content is sufficient evidence for inv 84.)*

### vitest (only if the UI rung lands)
- `menuActions.test.ts`: `runAction("export_stems", ctx)` issues an `exec("export_stems", …)` call (mirror `:100-103`).
- `ExportControls` test: clicking *Export stems* calls `exec` with `export_stems`.
- Mock returns a `stems` array of length 2.

### py goldens
- None required — no new Python service surface (this is engine-only). The verify.py WAVs stay gitignored; only the PCM-SHA/feature baseline is committed if you add stems to the golden manifest (optional; the mix already covers the render DSP).

### conformance
- `conformance.py`: add an `export_stems` probe so the G7 eval rows pass; `scoreboard.py:34` G7 row flips gap→pass; regenerate `docs/FEATURE_AUDIT.md`. Re-run `--selftest ×3` for determinism.

---

## 6. Risks & seam concerns

- **Hard-excluded seams — none touched.**
  - **`MoshEngine`**: untouched — `cmdExportStems` uses `eng.edit()` / `eng.sessionDir()` read-only, same as `cmdExportAudio`.
  - **`src/state`**: untouched — export is a **read/render**, no ValueTree mutation, **NON-undoable** (no `beginNewTransaction`), no schema/format-version bump. `logicalid::ensureTrack` is already called all over the snapshot path (`:8362`) and only backfills an id — not a schema change.
  - **plugins/hosting**: untouched — reuses the existing `te::Renderer::RenderTask` path; `usePlugins=true` runs the already-hosted chain exactly as the mix render does. No `PluginHost`/`EditorWindow` changes.
  - **deploy / CI**: no changes. No new deps, no service, no bundle whitelist entry, no `.github` change.
- **Real correctness risks (bounded):**
  1. **Multi-render teardown.** Detaching the device once and running N `RenderTask`s in a loop: each render must be wrapped in its own `te::Edit::ScopedRenderStatus` + `te::Renderer::turnOffAllPlugins` before/after (copy `bounceClipToWav:6226-6258` verbatim). Mitigation: reuse the proven per-render block; the no-progress watchdog + deadline bound each track's render so a bad source errors cleanly instead of hanging (the exact class fixed for `export_audio` in PR #104, guarded by `check_relative_ref_export`).
  2. **Realtime-only synths (Serum).** A realtime-only synth on any track forces `realTimeRender` (edit-wide, mirrors export). Correct but slow for long edits × many tracks; the deadline scales with edit length so it won't hang.
  3. **Mute/solo semantics** are a product decision (§2) — muted track ⇒ silent stem; other tracks' solo is neutralized by single-track `tracksToDo`. Document in a code comment so it isn't read as a bug.
  4. **Long-render UX.** N sequential offline renders on the message thread block like `export_audio` does today; acceptable for v1 (same posture). A background/progress variant is a follow-up, not required.

---

## 7. Acceptance criteria

- `execute("export_stems", …)` renders **one file per visible, non-empty audio track**, each over the shared `{0, editLength}` window, into one directory, named `NN-<track>.<ext>`.
- Result envelope lists every stem with `{trackId, logicalId, name, index, file, bytes}`; `count` == number of files written.
- **`moshHidden` tracks never produce a stem**; folder/group tracks excluded; empty tracks skipped unless `includeEmpty:true`.
- Stems are **pre-master** and **mutually distinct** (verify.py: `diff_rms(A,B) > 0.05`); all stems share the same frame count (aligned zero point).
- Unsupported `format`/`bitDepth` rejected before any render; empty edit returns a clean error.
- `cmdExportAudio` output unchanged (`verify.py --gate` PCM-SHA identical).
- Gates green: `--selftest ×3` deterministic (new stem checks incl. hidden-exclusion + count), `verify.py` `check_stem_export` pass, Catch2 pass, conformance G7 flips to pass, `docs/FEATURE_AUDIT.md` regenerated. If any UI rung lands: `tsc` clean, vitest + e2e green, `NON_UNDOABLE` updated.

---

## 8. Size & mergeability

- **Size: M.** Core is one new C++ handler (~90 lines) + a mechanical ~130-line helper extraction + dispatch/LockManager one-liners + tests + a conformance/audit flip. The optional UI rung (menu item, ExportControls button, mock, types, vitest) is small and can land in the same PR or a follow-up.
- **Auto-mergeable: yes**, provided the standard gate (build, `--selftest ×3`, Catch2, `verify.py`, conformance) is green and adversarial diff review is clean — the change is additive and touches **no excluded seam**. The only non-automatable confirmation is a by-ear "the stems sound right / re-import in line," which is **not a blocker** because alignment is structural (identical `{0, editLength}` window ⇒ equal-length files by construction) and content-distinctness is asserted numerically in `verify.py`.
