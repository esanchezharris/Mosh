# FS-ST3 — Mosh + FL v2 workflow-profile contract

**Lane:** ST (Style / interaction) · **Spec:** `docs/first-stranger-program/SPEC.md` §0 and
§7 ST3 · **Backlog class:** `native` · **Route:** owner-merge · **Status:** implementation
complete, final integration blocked on the active v2 edge and DAW-parity branches.

## Purpose

FS-ST3 defines the cold, UI-local contract that the later v2 integration consumes. It gives the
shell two explicit workflow profiles:

- **Mosh** is the native profile and the visual identity remains Mosh.
- **FL** is beta behavior/workspace parity only. It selects FL key and mouse behavior, but never
  changes skin, branding, or theme and never creates a user-facing FLP import path.

The registry owns profile metadata, the exhaustive FL v1 capability matrix, strict-mouse support,
reserved shortcut combos, and resting workspace intent. The settings store owns only local
persistence; no profile operation crosses the bridge or mutates project state.

## Implementation

### Authoritative registry

`ui/src/settings/workflowProfiles.ts` exports `WORKFLOW_PROFILES`, the ordered
`WORKFLOW_PROFILE_IDS`, `DEFAULT_WORKFLOW_PROFILE_ID`, and `getWorkflowProfile`. The only v2-ready
profiles are `mosh` and `fl`. Each record carries:

- stable id, label, maturity, and `v2Available`;
- keymap and gesture-table ids;
- the Mosh-only visual policy;
- strict-mouse support;
- browser, right-rail, section-zoom, sounds-tab, and drum-window defaults; and
- capability rows with stable id, label, status, surface, safe/strict scope, input when applicable,
  concise semantics, and an official Image-Line source whenever FL behavior is claimed.

The FL matrix has 28 unique rows: 20 supported, 3 explicit divergences, and 5 deferred. Supported
rows cover the complete v1 global/file, arrangement, view, and opt-in Strict FL mouse promises.
The safe default never advertises destructive right-click behavior as active. Divergences pin
conventional Mosh undo/redo, Mosh visual identity, and the Mosh project model. Deferred rows name
Step Edit, the remaining Playlist tools, Pattern/Song mode, right-drag multi-erase, and user-facing
FLP import without implying that any is implemented.

The shortcut seam is complete for this cold contract: the FL registry reserves `Mod+E` for deferred
Step Edit, and the effective v2 keymap resolver consumes profile reservation metadata after applying
persisted rebinds. Classic behavior remains unchanged; the resolver contains no FL-id or duplicated
`Mod+E` reservation.

Unknown profile ids resolve to Mosh.

### Schema and v3 persistence

`ui/src/settings/schema.ts` adds `workflowProfile` (`mosh | fl`, default `mosh`) and
`strictFlMouse` (default `false`) in the Workflow category. Classic template values for skin,
theme, and layout are unchanged.

`ui/src/settings/store.ts` writes `mosh.settings` as version 3. The migration is additive:

- no entry gives Mosh defaults, an empty profile-workspace map, and an undismissed onboarding flag;
- valid v1/v2 entries preserve template, values, and key overrides, force the v2 profile to Mosh,
  and mark onboarding dismissed;
- a valid v3 profile is retained, while an unknown id falls back to Mosh;
- corrupt or future entries fall back safely and mark onboarding dismissed because storage existed;
- legacy FL skin, template, keymap, and gesture values never infer the FL v2 profile; and
- reset clears values, workspace overrides, and key overrides while retaining a dismissed onboarding
  flag.

In v2, key overrides are scoped to the active workflow profile. Classic keeps the legacy keymap
scope. Store-local operations set a profile, save a profile workspace override, read effective
workspace (registry defaults layered with the saved override), and dismiss onboarding.
Workspace tokens are exact unions: browser tab is `sounds | plugins`, and section zoom is
`8b | 16b | full`. Hydration and live saves preserve valid overrides, reject unknown strings, and
therefore fall back to the selected profile's defaults.

## Acceptance evidence

| Acceptance clause | Repository proof |
|---|---|
| Exhaustive 28-row FL v1 matrix, official sources, and Mosh-only visual policy | `ui/src/settings/workflowProfiles.ts` and `workflowProfiles.test.ts` |
| Workflow schema controls; no other v2-ready DAW profiles | `schema.ts` and schema tests |
| v2→v3 migration, new-install onboarding, corrupt fallback, no legacy-FL inference | store tests and persisted JSON assertions |
| Key override preservation/scoping, workspace defaults/overrides, reset | store tests covering v2, Classic, reload, and reset |
| Exact workspace tokens and invalid-token fallback | workflow-profile persistence tests covering valid and invalid browser/zoom values |
| Registry-owned deferred `Mod+E` reservation | `workflowProfiles.test.ts`, `interaction/config.ts`, and `interaction/config.test.ts` |
| Native menu ownership proof | Required in the final integration gate after the v2 edge lands; this cold lane records the capability as deferred |
| Local gate and installed-app proof | Required owner-run evidence before final integration; not claimed by this UI-local contract |
| No user-facing FLP import | Explicit non-goal and final integration acceptance; no importer or bridge path is added here |

Required focused checks for this lane:

```sh
cd ui
npm test -- src/settings/workflowProfiles.test.ts src/settings/store.test.ts \
  src/settings/schema.test.ts src/settings/templates.test.ts src/interaction/config.test.ts
npm test
npm run typecheck
cd ..
git diff --check
```

The owner must additionally run `scripts/auto-loop/gate.sh native` against the integration worktree
and attach native menu ownership plus installed-app proof before clearing the blocked status.

## Files in scope

| Path | Role |
|---|---|
| `ui/src/settings/workflowProfiles.ts` | authoritative cold profile registry and FL v1 matrix |
| `ui/src/settings/workflowProfiles.test.ts` | registry, migration, workspace, and onboarding tests |
| `ui/src/settings/schema.ts` | Workflow settings descriptors |
| `ui/src/settings/schema.test.ts` | Workflow category and default invariants |
| `ui/src/settings/store.ts` | v3 persistence, migration, and store-local operations |
| `ui/src/settings/store.test.ts` | existing settings and persistence regression coverage |
| `ui/src/interaction/config.ts` | registry-driven effective keymap reservations |
| `ui/src/interaction/config.test.ts` | reservation behavior and no-duplicate-combo proof |
| `ui/src/settings/templates.ts` | existing Classic definitions, intentionally unchanged |
| `docs/first-stranger-program/backlog.jsonl` | FS-ST3 owner-merge registration |
| `docs/first-stranger-program/lanes/fs-st3.md` | this lane plan and acceptance map |

## §0 constraints and non-goals

- This worktree contains only FS-ST3 registration and the cold settings/interaction contract.
- No `ui/src/v2/**`, v2 e2e, bridge mock, MoshOps C++, selftest, parity, or native integration file is
  changed.
- The registry and store are UI-local and bridge-free; no project/session state is introduced.
- No FLP/project-file importer, native menu hook, or installed-app claim is added by this lane.
- Existing Classic skin/theme/layout template definitions remain byte-for-byte unchanged.
- The owner merges only after the active v2 edge and DAW-parity branches land and the native gate,
  native menu ownership proof, installed-app proof, and no-user-facing-FLP-import check pass.
