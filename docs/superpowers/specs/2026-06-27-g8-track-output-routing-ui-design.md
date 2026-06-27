# G8 — Per-track output / multi-out routing UI

*Design — 2026-06-27. Auto-loop backlog item G8 (class: cheap, UI-only).*

## Problem

The backend already ships per-track output routing: `list_track_outputs`
(enumerate hardware outs + candidate tracks) and `set_track_output`
(route a track into another track / a hardware device / back to default;
self + cycle rejected; undoable). The store has a `loadRouting()` action
that fetches `list_wave_inputs` + `list_track_outputs` into `waveInputs` /
`trackOutputs` — but it has **no caller**, and no component ever reads the
`trackOutputs` / `waveInputs` state or surfaces `set_track_output`. The
v2 `Mixer.tsx` explicitly defers routing ("routing from the legacy Mixer
are deferred to a later pass"). So the feature is invisible in the UI.

## Goal

The v2 Mixer channel strip gains an `out:` selector wired to
`set_track_output` / `list_track_outputs` through the now-orphaned
`loadRouting()`. Pure UI work — no C++ change (the binary must stay
byte-identical: swappable seam), no new commands, one mutation path.

## Approach

The project has no React component-test surface (vitest `include` is
`src/**/*.test.ts`, no testing-library). So, matching the existing
util-module convention (`meterGeom.ts`, `sampleBrowserUtil.ts`,
`pluginBrowserUtil.ts`), the selector logic lives in a pure, fully-tested
module and the component stays a thin shell.

### New: `ui/src/ui/routingUtil.ts`

- `routingOptions(trackId, trackOutputs): RoutingOption[]` — ordered list:
  `Default` first, then candidate **tracks** (excluding self), then
  hardware **outputs**. Each `{ value, label }`; `value` encodes kind:
  `"default"`, `"track:<id>"`, `"out:<deviceID>"`.
- `routingArgs(trackId, value): Record<string, unknown>` — maps a selected
  `value` to the `set_track_output` args the backend reads:
  `{ trackId, output: "default" }` | `{ trackId, destTrackId }` |
  `{ trackId, deviceID }`.
- `currentRoutingValue(track): string` — derives the selected option
  `value` from `track.output` (`isTrack` → `track:<destId>`, else
  `out:<deviceID>`, else `default`).

### `ui/src/ui/Mixer.tsx`

- Call `loadRouting()` once on mount (lazy; native-guarded inside the
  store action — no-op under the dev mock's `isNative()===false`, so the
  select renders only when `trackOutputs` is present).
- Each `Strip` renders a `<select class="strip-out">` built from
  `routingOptions(track.id, trackOutputs)`, value =
  `currentRoutingValue(track)`, `onChange` →
  `exec("set_track_output", routingArgs(track.id, value))`. Pointer events
  stop-propagation so selecting doesn't trigger track-select. Hidden when
  `trackOutputs` is null (graceful: nothing to choose).

### Dev mock (`ui/src/bridge.mock.ts`) — test/dev only, not the binary

Add a `set_track_output` case mirroring the backend contract (set/clear
`track.output`; reject self) so dev + e2e flows stay coherent with the
real engine. The mock is not the C++ backend — this does not touch the
swappable seam.

## Prime-directive compliance

- **One mutation path:** routing changes go only through
  `exec("set_track_output", …)`. No new commands, no direct mutation.
- **Swappable seam:** UI + dev-mock only; C++ untouched → binary
  unaffected.
- **No tier-wall / ASTD / cache / undo concerns** (read + one existing
  undoable command).

## Tests (RED first)

- `routingUtil.test.ts` — options include Default + tracks (self
  excluded) + outputs in order; `routingArgs` maps each value → correct
  command args; `currentRoutingValue` round-trips `track.output`.
- `routing.store.test.ts` — `loadRouting()` populates `waveInputs` /
  `trackOutputs` from the bridge (native-forced), and is a no-op under
  the non-native dev mock.

## Gate

`cd ui && npm run typecheck && npm test && npm run test:e2e`.
