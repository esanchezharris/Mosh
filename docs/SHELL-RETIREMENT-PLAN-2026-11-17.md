# Shell retirement plan — 2026-11-17

**Status:** owner chose to retire all four shells (2026-11-17). Step 1 (move the shared
pieces) is on `claude/shells-1-shared`. Decisions 2–4 in §6 are still open. Nothing is
deleted yet.

**Goal:** make V3 the only interface. Retire Classic, v2 ("Mosh (new)"), Live (clone) and
Pro Tools, delete their code and tests together, and cut the gate's time to match.

## 1. Why

- About 45% of e2e worker time (~13 of ~30 worker-minutes) tests the old shells.
  The slowest spec files are `live-shell` (201 s), `v2-shell` (152 s), `v2-edgecases`
  (76 s) and `redesign-shell` (70 s).
- The friends build (north star 2026-11-16) uses V3 only.
- CLAUDE.md still describes the old shells as selectable, so their tests can only go
  out together with their code.

## 2. What goes

Counted by a reachability pass from `main.tsx` with the four old `App*` entry points cut,
measured after step 1:

| | Files | Lines |
|---|---:|---:|
| Production modules unreachable once only V3 remains | 217 | ~26,600 |
| `protools/` | 106 (all) | |
| `live/` | 33 (all) | |
| `v2/` | 46 (all except the four shell-switching files below) | |
| `ui/` (old Arrange, Dock, Inspector, Rack, Topbar, SessionRail, presence, Meter, …) | 26 | |
| `AppLegacy.tsx`, two hooks, `chrome/Menu`, `settings/layoutPresets`, one agent card | 6 | |
| Vitest files under `protools/`, `live/`, `v2/` | 137 of 561 | |
| e2e specs that drive an old shell | 52 of ~100 | |

**Step 1 moved what V3 actually uses out of the old shells:**
- `addTrackOfKind` and `TRACK_KINDS` → `ui/src/trackKinds.ts`. `menuActions.ts` imported
  them from `v2/lanes/TrackLaneList`, which alone kept ~25 v2 lane and timeline files alive.
- `v2/PluginBrowser` and `v2/pluginPicker` → `v3/`, where `PluginsPane` uses them.
- `live/ClipLoopBar` → `ui/`, where `PianoRoll` uses it.
- `live/liveState`, `live/transportBar`, `live/zoomHistory` → `ui/src/`, used by
  `menuActions`, the keyboard shortcuts hook and `PianoRoll`.

Still in `v2/`: `shellFlag`, `shellQuery`, `shellState` (the shell-switching machinery,
collapsed in step 3) and `cssSource` (a test helper for the v2 stylesheet, deleted with it).

## 3. The 52 old-shell e2e specs fall into three groups

1. **Shell UI only. Delete with the shell.** The `protools-*` specs (17), `live-shell`,
   `live-grid`, `v2-shell`, `v2-edgecases`, `v2-annotations`, `v2-sections`,
   `v2-section-render`, `v2-tempo`, `v2-timerange`, `redesign-shell`, `polish`,
   `walkthrough`, `portfolio-shot`, `felt-wrong`.
2. **Core behaviour that happens to run through an old shell. Port to V3, or confirm that
   V3 or native coverage already exists, before deleting.** `automation-write`,
   `clip-edit-fades`, `drum-pattern`, `export-dialog`, `gesture-clip-regions`,
   `guest-degradation`, `master-bus`, `multiplayer`, `pattern-library`, `record-arm`,
   `replay-capture`, `ripple-delete`, `session-lifecycle`, `templates`, `warp`,
   `uireach-drum-kit-reset`, `uireach-input-monitor`, `uireach-remove-track`.
3. **Deferred AI. Goes with friends slice 2 (AI off), not here.** `lyrics`, `agent-loop`,
   `agent-memory`.

## 4. Commands that lose coverage

`scripts/daw-conformance/coverage_check.py`, rerun with the 52 specs removed, reports
**24** MoshOps commands with no remaining test. Before the cut it reports none, so the
coverage gate would go red:

| Commands | Count | Proposed handling |
|---|---:|---|
| Lyrics: `analyze_lyrics`, `complete_lyrics`, `suggest_next_line`, `get_rhymes`, `fill_lyric_gap`, `regenerate_lyric`, `accept/reject_lyric_proposal`, `build_lyrics_from_clip`, `build_skeleton_from_clip`, `get_lyric_corpus_stats` | 14 | FMS is paused. Either remove these commands with the lyrics UI, or add one native conformance test each. Don't paper over them with waivers, which expire as a batch. |
| Track and clip groups: `create/rename/duplicate/remove/configure_track_group`, `set_track_group_enabled`, `set_track_group_members`, `set_track_groups_suspended`, `create/rename/regroup/ungroup_clip_group` | 9 (the 4 clip-group commands overlap) | Only the Pro Tools shell exposes these. Keep the backend and add conformance tests (cheap, and the commands are engine-level), or remove them if groups are not planned for V3. |
| `mp_send_signal` | 1 | V3 has multiplayer, so port `multiplayer.spec.ts` to V3. |

## 5. PR sequence

Start after #817 merges, because it touches V3 and settings.

1. **Move the shared pieces (no behaviour change). Done on `claude/shells-1-shared`.**
   See §2. The gate stays green with nothing deleted.
2. **Coverage first.** Port the group-2 specs to `?shell=v3` (fold them into existing V3
   specs where they overlap). Add conformance tests for the group and lyrics commands, or
   remove those commands per the §6 decisions. `coverage_check` must still pass with the
   old specs deleted (simulate as in §4).
3. **Delete.** Push an immutable tag, `archive/shells-<date>`, on the main commit just
   before the deletion merges (repository-safety rule).
   - Remove the four shells, the 193 modules, their 141 vitest files and the group-1 specs.
   - Settings: collapse the `uiShell` enum to `v3`, and migrate any stored old value to
     `v3`, with a vitest case.
   - Remove the `protools` and `live` templates and the `protools`
     skin/layout/gestureTable/keymap values.
   - Native and bridge: narrow `preferredShell` in `OwnerRuntime.cpp` and `bridge.ts`.
   - `shellQuery`/`resolveShell` become trivial or go away.
   - `menuActions.ts`, `store.ts` and `settings/*` drop their shell branches.
4. **Docs.**
   - CLAUDE.md shell sentence; `docs/CURRENT_STATUS.md`.
   - Regenerate `docs/FEATURE_AUDIT.md` with `scoreboard.py`.
   - Mark the Live-grid-parity (#667) and Pro Tools parity records as archived at the tag.

Slice 2 (AI off) removes the group-3 specs along with the generative UI.

## 6. Owner decisions

1. **Retire all four shells?** Or keep one, for example Pro Tools for your own mixing?
   Keeping one keeps its code and specs.
2. **Track and clip groups.** Keep the backend commands with conformance tests and no UI,
   or remove them?
3. **Lyrics commands.** Remove with FMS, or keep them paused and covered by native tests?
4. **Existing installs on an old shell** move to V3 silently at next launch. Is a one-line
   notice wanted?

## 7. Expected effect

- e2e worker time drops by up to ~45%. Ported group-2 specs add some back.
- On CI's 2 workers, that is an estimated 10–13 minutes off the cheap gate's ~31.
  This is unmeasured until step 3 lands; the per-step timings on `claude/gate-timing`
  will show the real number.
- Vitest drops a quarter of its files.
- The native gate is not affected by the e2e cut. Its 52 minutes are a separate
  investigation once step timings are in CI.
