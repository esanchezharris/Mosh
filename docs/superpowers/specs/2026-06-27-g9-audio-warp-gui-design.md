# G9 — Audio warp / time-stretch GUI

*Backlog item G9. Class: cheap. Scope: UI-only (`ui/src/`). The backend command
`set_clip_warp` and the snapshot fields (`autoTempo`, `stretchMode`) already exist —
this item surfaces them in the clip UI.*

## Problem

Wave clips can be warped (auto-tempo time-stretch following the tempo map) through the
`set_clip_warp` MoshOps command, and the snapshot already carries each clip's
`autoTempo` / `stretchMode`. But there is no GUI for it: a user can't toggle warp on a
clip or pick a stretch mode. G9 closes that gap.

## Non-goals

- No backend change. `set_clip_warp` (validate → undo txn → snapshot) is the one
  mutation path and stays untouched. No new command, no engine code.
- No free warp *markers* (a deferred subsystem per `MoshOps.cpp`). G9 is the
  auto-tempo toggle + stretch-mode pick only.
- No per-mode quality tuning. The backend's `checkModeIsAvailable` already returns a
  usable fallback for any mode this build doesn't compile in.

## Design

### 1. Pure helper — `ui/src/ui/clipWarp.ts`

The load-bearing logic is extracted into a pure, unit-testable module (vitest only
collects `src/**/*.test.ts`, so the testable core must be plain TS, not a `.tsx`
component):

- `WARP_MODES`: the curated stretch-mode options the UI offers — `{ id, label }`.
  `id` is the engine mode name the command sends (`""` = engine default; `"soundtouch"`
  = the mode this build vendors). The backend validates/falls back, so the list is
  forgiving.
- `clipIsWarpable(clip)`: only `wave` clips.
- `warpToggleArgs(clip, mode?)`: builds the `set_clip_warp` args to FLIP the clip's
  current `autoTempo`. When enabling, includes the chosen `mode` (omitted ⇒ default).
- `warpModeArgs(clip, modeId)`: builds args to set warp on with a specific mode.
- `warpModeLabel(stretchMode?)`: maps a snapshot `stretchMode` string back to a label
  for display.

### 2. Clip context menu wiring — `v2/lanes/ClipView.tsx` `ClipMenu`

For wave clips, the menu gains:
- A **Warp** toggle row (shows ✓ when `clip.autoTempo`), execs `set_clip_warp` with
  `warpToggleArgs`.
- A **stretch-mode** `<select>` (enabled only when warp is on) that execs
  `set_clip_warp` with `warpModeArgs` on change.

Classic shell (`ui/Arrange.tsx` `ClipMenu`) gains the same Warp toggle row for
parity. Both couple to the backend ONLY via `exec("set_clip_warp", …)`.

### 3. Mock bridge — `bridge.mock.ts`

Add a `set_clip_warp` case mirroring `set_clip_mute`: toggle `clip.autoTempo`, set
`clip.stretchMode` from the requested mode (default `"soundtouch"`), `pushUndo`,
`invalidate`. This lets the dev mock + e2e exercise the real UI path; the snapshot
fields then drive the UI's checkmark / select value.

### 4. Agent catalog — `agent/commands.ts`

Add `set_clip_warp` to `AGENT_COMMANDS` (`clipId`, `autoTempo`, optional `mode`) so
warp is voice/agent reachable. Contract-safe: the backend handler reads all three.

## Testing

- **vitest** (`ui/src/ui/clipWarp.test.ts`): mode list shape, `clipIsWarpable`,
  toggle-arg construction (on→off and off→on with mode), mode-arg construction,
  label mapping. RED first against a stub that returns the wrong shape.
- **vitest** (`agent/commands.contract.test.ts`): already parametrized over
  `AGENT_COMMANDS` — the new entry must pass the catalog⇄backend arg contract.
- **e2e** (`e2e/v2-shell.spec.ts`): right-click the seeded wave clip → Warp menu item
  visible → click → menu shows it enabled (✓) and the mode select appears.
- `tsc` clean (src + e2e).

## Prime-directive check

- One mutation path: every change is `exec("set_clip_warp")`. ✓
- Swappable seam: UI-only; no Tracktion/audio concept leaks; the C++ binary is
  untouched (no `src/` C++ edits). ✓
- No tier-wall / ASTD / cache surfaces touched. ✓
