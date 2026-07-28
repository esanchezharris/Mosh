# Instrument Affordance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it obvious how to get a synth onto an instrument track in the v2 shell — a working empty-lane double-click, a pinned instrument slot, and an instrument-aware track icon.

**Architecture:** Interaction routes through the existing gesture table (`region × gesture × mods × tool → action`), so lane behaviour is declared as data and resolved by `resolveGesture`, not by hand-written branches. A new `LANE_NEW` action is added to the `MOSH` table only; `.v2-lane` gains handlers that classify, select the track, and dispatch. The branch between "make a clip" and "offer a choice" lives in a pure function so it is testable with no DOM.

**Tech Stack:** TypeScript, React 18, Zustand, Vitest (jsdom), Playwright.

**Spec:** [`docs/superpowers/specs/2026-07-27-instrument-affordance-design.md`](../specs/2026-07-27-instrument-affordance-design.md)

## Global Constraints

- **Frontend only.** No files under `src/` (C++). No native rebuild. `--selftest` cannot prove any of this — vitest and e2e are the verdict.
- **The classic shell must not change behaviour.** `ui/src/ui/Arrange.tsx` resolves only `empty × drag`, so new `empty` rules are inert there. Any task that changes a file classic shares (`ui/src/ui/Dock.tsx`, `ui/src/ui/icons.tsx`) must keep classic's call sites working unchanged.
- **RED-prove every guard.** Run each new test and see it FAIL for the right reason before implementing. A test that cannot fail looks exactly like one that passes — this repo's documented recurring failure mode.
- **No `SABOTAGE` left in the tree.** If you temporarily break code to prove a test fails, restore it and run `grep -rn SABOTAGE ui/src` before committing.
- **`EditorAction` string values are persisted** in templates/localStorage. `"lane_new"` is permanent once shipped — do not rename it later.
- **DRM-001 stays.** Never remove the default-instrument auto-load in `src/moshops/MoshOps.cpp:6648`. A MIDI clip on an instrument-less track is silent.
- **Test commands** run from `ui/`: `npm test` (vitest), `npm run typecheck`, `npm run test:e2e`.
- **e2e uses the isolated config only:** `npx playwright test --config playwright.isolated.config.ts` (port 5191). Never `:5173` — another session's dev server may own it and will false-fail every spec.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `ui/src/interaction/actions.ts` | add `LANE_NEW` to the action vocabulary | 1 |
| `ui/src/interaction/gestureTables.ts` | two new `empty` rules on the `MOSH` preset | 1 |
| `ui/src/v2/lanes/laneNew.ts` | **new** — pure `resolveLaneNew(track)` planner | 2 |
| `ui/src/v2/shellState.ts` | one-shot `pendingCollection` + `openBrowserTab` arg | 3 |
| `ui/src/v2/PluginBrowser.tsx` | consume `pendingCollection` on mount | 3 |
| `ui/src/v2/lanes/LaneMenu.tsx` | **new** — the lane context menu | 4 |
| `ui/src/v2/lanes/TrackLaneList.tsx` | lane handlers, menu state, `TrackTypeIcon`, `addTrackOfKind` | 4, 6, 7 |
| `ui/src/v2/inspector/InstrumentSlot.tsx` | **new** — the pinned instrument slot | 5 |
| `ui/src/v2/inspector/Inspector.tsx` | render the slot above `Rack` | 5 |
| `ui/src/ui/Dock.tsx` | `hideInstrument` prop on `Rack` | 5 |
| `ui/src/ui/icons.tsx` | add `IconKeys` | 6 |
| `ui/src/v2/shell.css` | lane-menu + slot styling | 4, 5 |

---

### Task 1: `LANE_NEW` action and gesture-table rules

Pure interaction layer. No UI yet — this task ends with the resolver returning the right action for the right context, and every other preset provably unchanged.

**Files:**
- Modify: `ui/src/interaction/actions.ts:25` (add to the pointer block)
- Modify: `ui/src/interaction/gestureTables.ts:39-42` (the `MOSH` "empty lanes" block)
- Test: `ui/src/interaction/gestureTables.test.ts:102`

**Interfaces:**
- Consumes: nothing.
- Produces: `EditorAction.LANE_NEW` (string value `"lane_new"`), consumed by Task 4.

- [ ] **Step 1: Write the failing test**

In `ui/src/interaction/gestureTables.test.ts`, inside `describe("mosh preset — current behavior preserved", ...)`, add after the existing `empty:` test at line 102:

```ts
  it("empty: dblclick → LANE_NEW, contextmenu → CONTEXT_MENU", () => {
    expect(r("mosh", { region: "empty", gesture: "dblclick" })).toBe(A.LANE_NEW);
    expect(r("mosh", { region: "empty", gesture: "contextmenu" })).toBe(A.CONTEXT_MENU);
  });
  it("the new empty rules do not disturb the existing ones", () => {
    expect(r("mosh", { region: "empty", gesture: "click" })).toBe(A.DESELECT);
    expect(r("mosh", { region: "empty", gesture: "drag" })).toBe(A.MARQUEE);
    expect(r("mosh", { region: "empty", gesture: "drag", tool: "range" })).toBe(A.TIME_SELECT);
  });
  it("clip dblclick still OPENs — the new empty rule does not out-rank it", () => {
    expect(r("mosh", { region: "clip.body", gesture: "dblclick" })).toBe(A.OPEN);
  });
  it("LANE_NEW is mosh-only — other presets leave empty dblclick unbound", () => {
    for (const t of ["ableton", "fl", "protools", "logic"]) {
      expect(r(t, { region: "empty", gesture: "dblclick" })).toBeNull();
      expect(r(t, { region: "empty", gesture: "contextmenu" })).toBeNull();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui && npx vitest run src/interaction/gestureTables.test.ts
```

Expected: FAIL. The first test errors because `A.LANE_NEW` is `undefined`, so `toBe(undefined)` compares against the resolver's `null`.

- [ ] **Step 3: Add the action**

In `ui/src/interaction/actions.ts`, in the pointer block, after the `PAINT` line (line 24):

```ts
  PAINT: "paint",
  // Empty-lane "make something here" (dblclick). The lane handler picks the concrete
  // outcome from track state (see v2/lanes/laneNew.ts): a MIDI clip when the track
  // already hosts an instrument, otherwise a menu offering instrument vs audio.
  LANE_NEW: "lane_new",
  CONTEXT_MENU: "context_menu",
```

- [ ] **Step 4: Add the rules**

In `ui/src/interaction/gestureTables.ts`, replace the `// empty lanes` block in `MOSH` (lines 39-42) with:

```ts
  // empty lanes
  { region: "empty", gesture: "click", action: A.DESELECT },
  { region: "empty", gesture: "drag", action: A.MARQUEE },
  { region: "empty", gesture: "drag", tool: "range", action: A.TIME_SELECT },
  // v2 only: the classic Arrange resolves just `empty × drag`, so these two are inert
  // there and classic behaviour is unchanged even on the mosh table. Both are deliberately
  // absent from the other presets — v2 pins to "mosh" (see v2/lanes/ClipView.tsx).
  { region: "empty", gesture: "dblclick", action: A.LANE_NEW },
  { region: "empty", gesture: "contextmenu", action: A.CONTEXT_MENU },
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd ui && npx vitest run src/interaction/
```

Expected: PASS, all files in `src/interaction/`.

- [ ] **Step 6: RED-prove the mosh-only guard**

Temporarily append `{ region: "empty", gesture: "dblclick", action: A.LANE_NEW },` to the `FL` table, re-run, and confirm the "LANE_NEW is mosh-only" test FAILS. Remove the line and confirm it passes again.

```bash
cd ui && npx vitest run src/interaction/gestureTables.test.ts && grep -rn SABOTAGE src/ || echo "clean"
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/interaction/actions.ts ui/src/interaction/gestureTables.ts ui/src/interaction/gestureTables.test.ts
git commit -m "feat(interaction): LANE_NEW action + empty-lane dblclick/contextmenu rules on the mosh table"
```

---

### Task 2: `resolveLaneNew` — the pure planner

The branch between "add a clip" and "offer a choice", isolated from React so it is testable without a DOM.

**Files:**
- Create: `ui/src/v2/lanes/laneNew.ts`
- Test: `ui/src/v2/lanes/laneNew.test.ts`

**Interfaces:**
- Consumes: `Track` from `ui/src/types.ts` (only `isInstrument?: boolean` is read).
- Produces: `resolveLaneNew(track: LaneTrack): LaneNewPlan`, where `LaneNewPlan` is `{ kind: "clip" } | { kind: "menu" }` and `LaneTrack` is `Pick<Track, "isInstrument">`. Task 4 consumes both.

- [ ] **Step 1: Write the failing test**

Create `ui/src/v2/lanes/laneNew.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveLaneNew } from "./laneNew";

// isInstrument is DERIVED per-snapshot by the backend (trackHasInstrument, MoshOps.cpp),
// so it is true iff the track genuinely hosts a synth and can never be stale.
describe("resolveLaneNew", () => {
  it("a track that already hosts an instrument gets a clip", () => {
    expect(resolveLaneNew({ isInstrument: true })).toEqual({ kind: "clip" });
  });
  it("a bare track gets the menu instead of a silent clip", () => {
    expect(resolveLaneNew({ isInstrument: false })).toEqual({ kind: "menu" });
  });
  it("an absent flag is treated as bare, not as an instrument", () => {
    expect(resolveLaneNew({})).toEqual({ kind: "menu" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui && npx vitest run src/v2/lanes/laneNew.test.ts
```

Expected: FAIL — `Failed to resolve import "./laneNew"`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/v2/lanes/laneNew.ts`:

```ts
// What an empty-lane double-click should DO, as a pure function of track state.
//
// Split out of TrackLaneList so the decision is unit-testable with no DOM and no store.
// The caller owns the side effects: "clip" means run add_midi_clip at the snapped bar,
// "menu" means open the LaneMenu at the pointer.
//
// Why the branch exists at all: there is no native "midi" track TYPE — an instrument
// track is type:"audio" carrying a synth (see the spec). So a bare instrument track and
// a plain audio track are indistinguishable here, and guessing either way is wrong for
// half the users. A bare track is asked; a track that already has a synth is not.

import type { Track } from "../../types";

export type LaneTrack = Pick<Track, "isInstrument">;

export type LaneNewPlan =
  | { kind: "clip" }   // has an instrument -> a MIDI clip here is audible
  | { kind: "menu" };  // bare -> offer instrument vs audio rather than a silent clip

export function resolveLaneNew(track: LaneTrack): LaneNewPlan {
  return track.isInstrument ? { kind: "clip" } : { kind: "menu" };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ui && npx vitest run src/v2/lanes/laneNew.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: RED-prove the branch**

Temporarily change the return to `return { kind: "clip" };` and confirm the two bare-track tests FAIL. Restore, confirm green.

```bash
cd ui && npx vitest run src/v2/lanes/laneNew.test.ts && grep -rn SABOTAGE src/ || echo "clean"
```

- [ ] **Step 6: Commit**

```bash
git add ui/src/v2/lanes/laneNew.ts ui/src/v2/lanes/laneNew.test.ts
git commit -m "feat(v2): resolveLaneNew — pure empty-lane double-click planner"
```

---

### Task 3: Picker pre-filtering

`buildCollections` already emits an `inst` collection, but the selection lives in `useState` inside `usePluginPicker` and cannot be set from outside. Add a one-shot channel so "Add instrument…" lands on Instruments.

**Files:**
- Modify: `ui/src/v2/shellState.ts:11,47,77`
- Modify: `ui/src/v2/PluginBrowser.tsx:34-42,161`
- Test: `ui/src/v2/shellState.test.ts`

**Interfaces:**
- Consumes: `CollectionId` from `ui/src/v2/pluginPicker.ts`.
- Produces: `openBrowserTab(tab: BrowserTab, collection?: CollectionId)` and `takePendingCollection(): CollectionId | null` on `useShell`. Task 4 and Task 5 call `openBrowserTab("plugins", "inst")`.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/v2/shellState.test.ts`:

```ts
describe("openBrowserTab pending collection (one-shot)", () => {
  it("opens the drawer on the tab with no collection by default", () => {
    useShell.getState().openBrowserTab("plugins");
    expect(useShell.getState().browserOpen).toBe(true);
    expect(useShell.getState().browserTab).toBe("plugins");
    expect(useShell.getState().takePendingCollection()).toBeNull();
  });

  it("carries a requested collection through exactly once", () => {
    useShell.getState().openBrowserTab("plugins", "inst");
    expect(useShell.getState().takePendingCollection()).toBe("inst");
    // One-shot: a second read is empty, so it never fights the user's own chip clicks
    // on a later re-render.
    expect(useShell.getState().takePendingCollection()).toBeNull();
  });

  it("a later plain open clears a collection that was never consumed", () => {
    useShell.getState().openBrowserTab("plugins", "inst");
    useShell.getState().openBrowserTab("sounds");
    expect(useShell.getState().takePendingCollection()).toBeNull();
  });
});
```

Add `import { useShell } from "./shellState";` and `describe`/`it`/`expect` imports at the top if the file does not already have them.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui && npx vitest run src/v2/shellState.test.ts
```

Expected: FAIL — `takePendingCollection is not a function`.

- [ ] **Step 3: Extend the shell store**

In `ui/src/v2/shellState.ts`, add the import at the top:

```ts
import type { CollectionId } from "./pluginPicker";
```

Add to the `ShellState` interface, after `browserTab: BrowserTab;`:

```ts
  // A collection the drawer should land on when it opens ("inst" for "Add instrument…").
  // ONE-SHOT: PluginDock takes it on mount and clears it, so it seeds the initial view
  // without overriding the chips the user clicks afterwards.
  pendingCollection: CollectionId | null;
```

Replace the `openBrowserTab` signature in the interface (line 47):

```ts
  openBrowserTab: (t: BrowserTab, collection?: CollectionId) => void;  // open the drawer ON a tab
  takePendingCollection: () => CollectionId | null;                    // read-and-clear
```

In the `create<ShellState>` body, add `pendingCollection: null,` next to `browserTab: "sounds",`, and replace the `openBrowserTab` implementation (line 77):

```ts
  openBrowserTab: (t, collection) => set({ browserOpen: true, browserTab: t, pendingCollection: collection ?? null }),
  takePendingCollection: () => {
    const c = useShell.getState().pendingCollection;
    if (c !== null) set({ pendingCollection: null });
    return c;
  },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ui && npx vitest run src/v2/shellState.test.ts
```

Expected: PASS.

- [ ] **Step 5: Consume it in PluginDock**

In `ui/src/v2/PluginBrowser.tsx`, change the `usePluginPicker` signature (line 34) to accept an initial collection:

```ts
function usePluginPicker(onLoaded?: () => void, initialCollection?: CollectionId) {
```

and its collection state (line 42):

```ts
  const [collection, setCollection] = useState<CollectionId>(initialCollection ?? "all");
```

In `PluginDock` (line 161), take the pending collection once on mount and seed the picker with it:

```ts
export function PluginDock() {
  // ONE-SHOT read: "Add instrument…" asks the drawer to open on Instruments. useState's
  // initialiser runs once per mount, which is exactly the lifetime we want — after this
  // the user's own chip clicks own the selection.
  const [seed] = useState(() => useShell.getState().takePendingCollection() ?? undefined);
  const pk = usePluginPicker(undefined, seed); // no onLoaded → the dock stays open after adding (it's a dock)
```

`CollectionId` is already imported at line 20. `useShell` is not — add it after the `useSettings` import at line 14:

```ts
import { useShell } from "./shellState";
```

- [ ] **Step 6: Verify the whole suite and types**

```bash
cd ui && npx vitest run src/v2/ && npm run typecheck
```

Expected: PASS, and `tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/v2/shellState.ts ui/src/v2/shellState.test.ts ui/src/v2/PluginBrowser.tsx
git commit -m "feat(v2): one-shot pendingCollection so the drawer can open on Instruments"
```

---

### Task 4: Lane menu and lane gesture handlers

The visible payoff: double-click and right-click on empty lane space do something.

**Files:**
- Create: `ui/src/v2/lanes/LaneMenu.tsx`
- Modify: `ui/src/v2/lanes/TrackLaneList.tsx` (imports, component state, `.v2-lane` at line 196)
- Modify: `ui/src/v2/shell.css` (append)
- Test: `ui/src/v2/lanes/laneGesture.test.tsx`

**Interfaces:**
- Consumes: `EditorAction.LANE_NEW` (Task 1), `resolveLaneNew` / `LaneNewPlan` (Task 2), `openBrowserTab(tab, collection)` (Task 3).
- Produces: `LaneMenu` component with props `{ x: number; y: number; track: Track; onClose: () => void }`. Nothing later depends on it.

- [ ] **Step 1: Write the LaneMenu component**

Create `ui/src/v2/lanes/LaneMenu.tsx`:

```tsx
// The empty-lane menu: what you can put on a track that has nothing here yet.
//
// Dismissal/portal behaviour mirrors ClipView's ClipMenu verbatim (portal to body,
// pointerdown-or-Escape closes, one tick's delay so the opening event does not
// immediately close it) so both menus feel identical.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { Track } from "../../types";

export function LaneMenu({ x, y, track, barLen, onClose }: {
  x: number; y: number; track: Track; barLen: number; onClose: () => void;
}) {
  const exec = useStore((s) => s.exec);
  const openBrowserTab = useShell((s) => s.openBrowserTab);
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const t = window.setTimeout(() => { window.addEventListener("pointerdown", close); window.addEventListener("keydown", onKey); }, 0);
    return () => { window.clearTimeout(t); window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  const run = (fn: () => void) => { fn(); onClose(); };
  // The track is already selected by the lane handler before this menu opens — both the
  // plugin picker and the sample browser load onto the SELECTED track.
  return createPortal(
    <div className="v2-lanemenu" role="menu" data-testid="v2-lane-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <button role="menuitem" data-testid="lane-add-instrument"
        onClick={() => run(() => openBrowserTab("plugins", "inst"))}>
        {track.isInstrument ? "Swap instrument…" : "Add instrument…"}
      </button>
      <button role="menuitem" data-testid="lane-import-audio"
        onClick={() => run(() => openBrowserTab("sounds"))}>Import audio…</button>
      {/* Always enabled, including on a bare track: it is an explicit request, and the
          backend's DRM-001 policy loads a default instrument in the same transaction so
          the clip lands audible rather than silent. */}
      <button role="menuitem" data-testid="lane-add-midi-clip"
        onClick={() => run(() => void exec("add_midi_clip", { trackId: track.id, start: 0, length: barLen }))}>
        Add MIDI clip
      </button>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Write the failing test**

Create `ui/src/v2/lanes/laneGesture.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EditorAction as A } from "../../interaction/actions";
import { resolveGesture } from "../../interaction/gestures";
import { getGestureTable } from "../../interaction/gestureTables";
import { resolveLaneNew } from "./laneNew";

// The lane handler is the composition of three already-tested pieces: the resolver says
// WHICH action, resolveLaneNew says WHICH outcome, and the handler runs it. These tests
// pin the composition (and the guards around it) without mounting the whole timeline.

const TABLE = () => getGestureTable("mosh");

describe("lane gesture composition", () => {
  it("dblclick on empty resolves to LANE_NEW", () => {
    expect(resolveGesture(TABLE(), { region: "empty", gesture: "dblclick", mods: {} })).toBe(A.LANE_NEW);
  });

  it("an instrument track double-clicked yields a clip; a bare one yields the menu", () => {
    expect(resolveLaneNew({ isInstrument: true })).toEqual({ kind: "clip" });
    expect(resolveLaneNew({ isInstrument: false })).toEqual({ kind: "menu" });
  });

  it("right-click on empty resolves to CONTEXT_MENU regardless of track state", () => {
    expect(resolveGesture(TABLE(), { region: "empty", gesture: "contextmenu", mods: {} })).toBe(A.CONTEXT_MENU);
  });
});

describe("LaneMenu", () => {
  let host: HTMLDivElement;
  let root: Root;
  // The menu portals to document.body, so query the DOCUMENT, not the host.
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const mount = async (isInstrument: boolean) => {
    const track = { id: "t1", name: "Inst", type: "audio", clips: [], plugins: [], isInstrument } as never;
    await act(async () => {
      root.render(React.createElement(LaneMenu, { x: 0, y: 0, track, barLen: 2, onClose: () => {} }));
    });
  };

  it("offers instrument, import and MIDI-clip actions on a bare track", async () => {
    await mount(false);
    expect(q("lane-add-instrument")?.textContent).toBe("Add instrument…");
    expect(q("lane-import-audio")).toBeTruthy();
    expect(q("lane-add-midi-clip")).toBeTruthy();
  });

  it("says SWAP once the track already hosts a synth", async () => {
    await mount(true);
    expect(q("lane-add-instrument")?.textContent).toBe("Swap instrument…");
  });
});
```

Add these imports at the top of the file — this repo has **no `@testing-library/react`** (jsdom only), so components mount via `React.act` + `createRoot`, exactly as `ui/src/v2/busAndMasterParams.test.ts` does:

```tsx
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";
import { LaneMenu } from "./LaneMenu";
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd ui && npx vitest run src/v2/lanes/laneGesture.test.tsx
```

Expected: FAIL on the `LaneMenu` import until Step 1's file is saved; if Step 1 is already saved, the gesture tests pass and only a mounting mismatch (if any) remains.

- [ ] **Step 4: Wire the handlers into TrackLaneList**

In `ui/src/v2/lanes/TrackLaneList.tsx`, add imports:

```ts
import { EditorAction as EA, type Mods } from "../../interaction/actions";
import { resolveGesture } from "../../interaction/gestures";
import { getGestureTable } from "../../interaction/gestureTables";
import { tempoMapFrom } from "../../time";
import { snappedSecAt } from "../timeline/BarRuler";
import { resolveLaneNew } from "./laneNew";
import { LaneMenu } from "./LaneMenu";
```

Add module-scope helpers next to the existing ones:

```ts
const TABLE = () => getGestureTable("mosh"); // v2 = single Mosh interaction model
const modsOf = (e: { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): Mods =>
  ({ shift: !!e.shiftKey, alt: !!e.altKey, meta: !!(e.metaKey || e.ctrlKey) });
```

In the timeline component (the one that already computes `barLen` at line 80), add state and the handler:

```tsx
  const exec = useStore((s) => s.exec);
  const tool = useStore((s) => s.tool);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const [laneMenu, setLaneMenu] = useState<{ x: number; y: number; track: Track } | null>(null);

  // Empty-lane gestures. `.v2-lane` owns no drag (v2 has no marquee), so a native
  // dblclick is correct here — ClipView needs its manual timer only because it also
  // owns drag.
  const laneGesture = useCallback((e: React.MouseEvent<HTMLDivElement>, gesture: "dblclick" | "contextmenu", track: Track) => {
    // A hit on a child ClipView is not "empty". Without this the lane would claim
    // double-clicks meant for the piano roll.
    if (e.target !== e.currentTarget) return;
    const action = resolveGesture(TABLE(), { region: "empty", gesture, mods: modsOf(e), tool });
    if (action !== EA.LANE_NEW && action !== EA.CONTEXT_MENU) return;
    e.preventDefault();
    // LOAD-BEARING: the plugin picker and sample browser both load onto the SELECTED
    // track, so without this you could double-click lane 7 and load a synth onto lane 2.
    setSelectedTrack(track.id);
    if (action === EA.CONTEXT_MENU || resolveLaneNew(track).kind === "menu") {
      setLaneMenu({ x: e.clientX, y: e.clientY, track });
      return;
    }
    const start = snappedSecAt(tempoMapFrom(snapshot.session), pxPerSec, e.clientX, e.currentTarget.getBoundingClientRect().left);
    void exec("add_midi_clip", { trackId: track.id, start, length: barLen });
  }, [exec, tool, setSelectedTrack, snapshot, pxPerSec, barLen]);
```

Add the two handlers to the `.v2-lane` div (line 196), leaving every existing attribute in place:

```tsx
                <div className={`v2-lane${varTempo ? " v2-lane-mapped" : ""}`} data-track-id={t.id} data-testid="v2-lane"
                  onDoubleClick={(e) => laneGesture(e, "dblclick", t)}
                  onContextMenu={(e) => laneGesture(e, "contextmenu", t)}
                  style={{ width: contentW, "--beat-px": `${beatPx}px` } as React.CSSProperties}>
```

Render the menu next to the existing `{dragging && ...}` block near the end of the component:

```tsx
        {laneMenu && (
          <LaneMenu x={laneMenu.x} y={laneMenu.y} track={laneMenu.track} barLen={barLen}
            onClose={() => setLaneMenu(null)} />
        )}
```

- [ ] **Step 5: Style the menu**

Append to `ui/src/v2/shell.css`:

```css
/* Empty-lane menu — same surface language as .v2-clipmenu, which it sits beside. */
.v2-lanemenu {
  position: fixed;
  z-index: 60;
  min-width: 180px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background: var(--v2-surface-raised, #1b1b1b);
  border: 1px solid var(--v2-line, rgba(255, 255, 255, 0.12));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
}
.v2-lanemenu button {
  appearance: none;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 7px 10px;
  border-radius: 7px;
  cursor: pointer;
}
.v2-lanemenu button:hover { background: var(--v2-hover, rgba(255, 255, 255, 0.08)); }
```

Check the variable names against the existing `.v2-clipmenu` rule in the same file and match whatever it uses — the fallbacks above are only a safety net.

- [ ] **Step 6: Run the tests and typecheck**

```bash
cd ui && npx vitest run src/v2/ && npm run typecheck
```

Expected: PASS, `tsc` clean.

- [ ] **Step 7: RED-prove the menu labels and the child-hit guard**

First the labels. Temporarily hardcode the button text to `"Add instrument…"` in `LaneMenu.tsx` and confirm the "says SWAP" test FAILS with `expected 'Add instrument…' to be 'Swap instrument…'`. Restore.

The child-hit guard needs a real dispatch, so cover it in the e2e spec (Task 8) where a genuine clip exists to double-click. Add this case to `ui/e2e/instrument-affordance.spec.ts` in Task 8:

```ts
test("double-clicking a MIDI clip opens the piano roll, not the lane menu", async ({ page }) => {
  await bootV2(page);
  await newProject(page);
  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-midi").click();
  const clip = page.locator('[data-testid="v2-lane"] [data-clip-id]').first();
  await expect(clip).toBeVisible();
  await clip.dblclick();
  // The guard is what keeps this from being the lane menu.
  await expect(page.getByTestId("v2-lane-menu")).toHaveCount(0);
});
```

To RED-prove it, delete `if (e.target !== e.currentTarget) return;`, run that spec, and confirm the lane menu appears. Restore the line.

```bash
cd ui && grep -rn SABOTAGE src/ || echo "clean"
```

Note: this e2e case needs a clip to exist, so it must add the clip explicitly via the lane menu's **Add MIDI clip** — after Task 7 the Instrument track lands bare.

- [ ] **Step 8: Commit**

```bash
git add ui/src/v2/lanes/LaneMenu.tsx ui/src/v2/lanes/TrackLaneList.tsx ui/src/v2/lanes/laneGesture.test.tsx ui/src/v2/shell.css
git commit -m "feat(v2): empty-lane double-click and right-click — instrument, import, MIDI clip"
```

---

### Task 5: Instrument slot in the Inspector

**Files:**
- Create: `ui/src/v2/inspector/InstrumentSlot.tsx`
- Modify: `ui/src/v2/inspector/Inspector.tsx:66`
- Modify: `ui/src/ui/Dock.tsx:30-55`
- Modify: `ui/src/v2/shell.css` (append)
- Test: `ui/src/v2/inspector/instrumentSlot.test.tsx`

**Interfaces:**
- Consumes: `openBrowserTab(tab, collection)` (Task 3).
- Produces: `InstrumentSlot({ track }: { track: Track })`; `Rack` gains an optional `hideInstrument?: boolean` prop. Classic passes nothing and is unaffected.

- [ ] **Step 1: Write the failing test**

Create `ui/src/v2/inspector/instrumentSlot.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { instrumentOf } from "./InstrumentSlot";

// The slot's whole job is answering "does this track have a synth, and which one".
// That lookup is the part worth pinning; the buttons are thin exec wrappers.
describe("instrumentOf", () => {
  const fx = { index: 0, name: "OTT", enabled: true, external: true, isInstrument: false } as never;
  const synth = { index: 1, name: "Vital", enabled: true, external: true, isInstrument: true } as never;

  it("finds the instrument among effects", () => {
    expect(instrumentOf({ plugins: [fx, synth] } as never)?.name).toBe("Vital");
  });
  it("returns null on a bare track", () => {
    expect(instrumentOf({ plugins: [fx] } as never)).toBeNull();
  });
  it("returns null when the track has no plugin array at all", () => {
    expect(instrumentOf({} as never)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui && npx vitest run src/v2/inspector/instrumentSlot.test.tsx
```

Expected: FAIL — `Failed to resolve import "./InstrumentSlot"`.

- [ ] **Step 3: Write the component**

Create `ui/src/v2/inspector/InstrumentSlot.tsx`:

```tsx
// The instrument slot — a pinned, always-present row above the effects rack.
//
// This exists because the rack is FLAT: a synth was just another card with a small
// "inst" badge, inside a tab labelled FX. A producer looking for "where does my synth
// go" was being told to look under effects. An empty slot that says so is the fix —
// it is self-explaining in a way a missing card never is.

import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { Plugin, Track } from "../../types";

/** The track's instrument, or null. Exported for the unit test. */
export function instrumentOf(track: Pick<Track, "plugins">): Plugin | null {
  return (track.plugins ?? []).find((p) => p.isInstrument) ?? null;
}

export function InstrumentSlot({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const openBrowserTab = useShell((s) => s.openBrowserTab);
  const inst = instrumentOf(track);
  const pick = () => openBrowserTab("plugins", "inst");

  if (!inst) {
    return (
      <div className="v2-instslot v2-instslot-empty" data-testid="v2-instrument-slot">
        <span className="v2-instslot-label">Instrument</span>
        <button className="btn v2-instslot-pick" data-testid="instslot-choose" onClick={pick}>
          No instrument — click to choose
        </button>
      </div>
    );
  }
  return (
    <div className="v2-instslot" data-testid="v2-instrument-slot">
      <span className="v2-instslot-label">Instrument</span>
      <span className="v2-instslot-name" data-testid="instslot-name">{inst.name}</span>
      <div className="v2-instslot-actions">
        <button className="btn" data-testid="instslot-edit"
          onClick={() => void exec("open_plugin_editor", { trackId: track.id, index: inst.index })}>Edit</button>
        <button className="btn" data-testid="instslot-swap" onClick={pick}>Swap</button>
        <button className="btn x" data-testid="instslot-remove"
          onClick={() => void exec("remove_plugin", { trackId: track.id, index: inst.index })}>✕</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ui && npx vitest run src/v2/inspector/instrumentSlot.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Add `hideInstrument` to Rack**

In `ui/src/ui/Dock.tsx`, change the `Rack` signature (line 30) and the `plugins` filter (line 35):

```tsx
export function Rack({ track, onAddPlugin, hideInstrument }: { track: Track | null; onAddPlugin?: () => void; hideInstrument?: boolean }) {
```

```tsx
  // hideInstrument: the v2 Inspector renders the instrument in its own pinned slot above
  // this rack, so showing it here too would render the same device twice. Classic passes
  // nothing and keeps the flat chain it has always had.
  const plugins = (track?.plugins ?? [])
    .filter((p) => p.external || p.builtin || p.rave)
    .filter((p) => !(hideInstrument && p.isInstrument));
```

- [ ] **Step 6: Render the slot in the Inspector**

In `ui/src/v2/inspector/Inspector.tsx`, add the import:

```ts
import { InstrumentSlot } from "./InstrumentSlot";
```

and replace the `fx` tab line (line 66):

```tsx
        {active === "fx" && (
          <>
            <InstrumentSlot track={track} />
            <Rack track={track} hideInstrument onAddPlugin={() => useShell.getState().openBrowserTab("plugins")} />
          </>
        )}
```

The tab keeps its "FX" label — the slot above the list carries the distinction, and renaming would churn tests and docs that assert it.

- [ ] **Step 7: Style the slot**

Append to `ui/src/v2/shell.css`:

```css
/* Instrument slot — pinned above the effects rack, visually distinct from a plugin card
   so an empty one reads as "something goes here", not as a missing item. */
.v2-instslot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  border-radius: 10px;
  border: 1px solid var(--v2-line, rgba(255, 255, 255, 0.12));
  background: var(--v2-surface-raised, rgba(255, 255, 255, 0.04));
}
.v2-instslot-empty { border-style: dashed; }
.v2-instslot-label {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.6;
}
.v2-instslot-name { font-weight: 600; }
.v2-instslot-actions { margin-left: auto; display: flex; gap: 4px; }
.v2-instslot-pick { margin-left: auto; }
```

- [ ] **Step 8: Verify nothing double-renders and classic is untouched**

```bash
cd ui && npx vitest run && npm run typecheck
```

Expected: PASS across the whole suite. If any existing Dock/Rack test asserts a plugin count, confirm it exercises classic (no `hideInstrument`) and is therefore unchanged.

- [ ] **Step 9: Add the de-duplication test and RED-prove it**

`instrumentOf` alone cannot catch a double-render — that needs the real `Rack` filter. Add to `ui/src/v2/inspector/instrumentSlot.test.tsx` (note: no `@testing-library/react` in this repo — `React.act` + `createRoot`, same as `ui/src/v2/busAndMasterParams.test.ts`):

```tsx
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach } from "vitest";
import { Rack } from "../../ui/Dock";

describe("Rack hideInstrument", () => {
  let host: HTMLDivElement;
  let root: Root;
  const track = {
    id: "t1", name: "Inst", type: "audio", clips: [],
    plugins: [
      { index: 0, name: "OTT", enabled: true, external: true, isInstrument: false },
      { index: 1, name: "Vital", enabled: true, external: true, isInstrument: true },
    ],
  } as never;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const cardNames = () =>
    [...host.querySelectorAll('[data-testid="plugin-card"] .pname')].map((n) => n.textContent);

  it("v2 hides the instrument — the slot above already shows it", async () => {
    await act(async () => { root.render(React.createElement(Rack, { track, hideInstrument: true })); });
    expect(cardNames()).toEqual(["OTT"]);
  });

  it("classic passes no flag and keeps the flat chain it always had", async () => {
    await act(async () => { root.render(React.createElement(Rack, { track })); });
    expect(cardNames()).toEqual(["OTT", "Vital"]);
  });
});
```

RED-prove: drop the `.filter((p) => !(hideInstrument && p.isInstrument))` line and confirm the first test FAILS with `["OTT","Vital"]`. Restore, confirm both pass. The second test is what stops a future "simplification" from filtering the instrument out for classic too.

```bash
cd ui && npx vitest run src/v2/inspector/instrumentSlot.test.tsx && grep -rn SABOTAGE src/ || echo "clean"
```

- [ ] **Step 10: Commit**

```bash
git add ui/src/v2/inspector/InstrumentSlot.tsx ui/src/v2/inspector/Inspector.tsx ui/src/v2/inspector/instrumentSlot.test.tsx ui/src/ui/Dock.tsx ui/src/v2/shell.css
git commit -m "feat(v2): pinned instrument slot above the FX rack"
```

---

### Task 6: `IconKeys` and an instrument-aware track icon

**Files:**
- Modify: `ui/src/ui/icons.tsx` (append near `IconDrum`, line 92)
- Modify: `ui/src/v2/lanes/TrackLaneList.tsx:24,459-463`
- Test: `ui/src/v2/lanes/trackTypeIcon.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `IconKeys(p: IconProps)`; `TrackTypeIcon` changes signature from `{ type: string }` to `{ type: string; isInstrument?: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `ui/src/v2/lanes/trackTypeIcon.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { pickTrackIcon } from "./TrackLaneList";

// An instrument track is type:"audio" carrying a synth, so before this it rendered the
// SAME waveform glyph as a plain audio track and the two were indistinguishable.
describe("pickTrackIcon", () => {
  it("an instrument track is keys, even though its type is audio", () => {
    expect(pickTrackIcon("audio", true)).toBe("keys");
  });
  it("a plain audio track stays a waveform", () => {
    expect(pickTrackIcon("audio", false)).toBe("waveform");
  });
  it("a drum track stays drums even when it hosts a sampler", () => {
    expect(pickTrackIcon("drum", true)).toBe("drum");
  });
  it("an unknown type falls back to layers", () => {
    expect(pickTrackIcon("bus", false)).toBe("layers");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui && npx vitest run src/v2/lanes/trackTypeIcon.test.tsx
```

Expected: FAIL — `pickTrackIcon` is not exported.

- [ ] **Step 3: Add the icon**

In `ui/src/ui/icons.tsx`, after `IconDrum` (ends line 100), add — same 24-unit grid and 1.7 stroke as every other icon:

```tsx
export function IconKeys(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="6" width="18" height="12" rx="1.6" />
      <path d="M8 6v7M12 6v7M16 6v7" />
    </Svg>
  );
}
```

- [ ] **Step 4: Make the icon choice testable and instrument-aware**

In `ui/src/v2/lanes/TrackLaneList.tsx`, add `IconKeys` to the icons import (line 24), then replace `TrackTypeIcon` (lines 459-463):

```tsx
/** Which glyph a track gets. Pure + exported so the choice is unit-testable — the
 *  interesting case is that an INSTRUMENT track has type "audio" (there is no native
 *  "midi" track type), so type alone cannot tell it from a plain audio track. */
export function pickTrackIcon(type: string, isInstrument?: boolean): "drum" | "keys" | "waveform" | "layers" {
  if (type === "drum") return "drum";      // a drum track hosts a sampler; it is still drums
  if (isInstrument) return "keys";
  if (type === "audio") return "waveform";
  return "layers";
}

function TrackTypeIcon({ type, isInstrument }: { type: string; isInstrument?: boolean }) {
  const which = pickTrackIcon(type, isInstrument);
  if (which === "drum") return <IconDrum size={16} />;
  if (which === "keys") return <IconKeys size={16} />;
  if (which === "waveform") return <IconWaveform size={16} />;
  return <IconLayers size={16} />;
}
```

- [ ] **Step 5: Pass the flag at the call site**

Find the `<TrackTypeIcon` usage in `TrackLaneList.tsx` and add the prop:

```bash
cd ui && grep -n "<TrackTypeIcon" src/v2/lanes/TrackLaneList.tsx
```

Change it to `<TrackTypeIcon type={track.type} isInstrument={track.isInstrument} />`.

- [ ] **Step 6: Run tests and typecheck**

```bash
cd ui && npx vitest run src/v2/ && npm run typecheck
```

Expected: PASS, `tsc` clean.

- [ ] **Step 7: RED-prove the instrument branch**

Temporarily remove the `if (isInstrument) return "keys";` line and confirm the first test FAILS with `expected 'waveform' to be 'keys'`. Restore.

```bash
cd ui && npx vitest run src/v2/lanes/trackTypeIcon.test.tsx && grep -rn SABOTAGE src/ || echo "clean"
```

- [ ] **Step 8: Commit**

```bash
git add ui/src/ui/icons.tsx ui/src/v2/lanes/TrackLaneList.tsx ui/src/v2/lanes/trackTypeIcon.test.tsx
git commit -m "feat(v2): instrument tracks get their own header icon"
```

---

### Task 7: Bare instrument tracks

`Add track → Instrument` stops silently auto-loading 4OSC. **Do this task after Task 4** — the lane menu is what keeps `add_midi_clip` reachable.

**Files:**
- Modify: `ui/src/v2/lanes/TrackLaneList.tsx:244-255`
- Modify: `ui/src/v2/lanes/trackKinds.test.ts:69-79` (the `instrument →` case) and its file header
- Test: `ui/src/agent/uiReachability.test.ts` (verify only, no edit expected)

**Interfaces:**
- Consumes: the lane menu's `exec("add_midi_clip", …)` call site from Task 4.
- Produces: `addTrackOfKind("midi", exec)` now issues `create_track` only.

**Read this before editing.** `trackKinds.test.ts` is not incidental coverage — its whole header argues that "a drum or MIDI track without an instrument is silent, which is the failure mode that would otherwise pass a string-matching test", and it runs against the real `bridge.mock` backend to prove tracks land *playable*. This task deliberately inverts that for the instrument kind. That is a real change to a documented invariant, so the test gets a rewritten reason, not a flipped number. The invariant that survives is narrower and still true: **a track must never end up with a clip it cannot play.** Before, that was satisfied by loading a synth the user did not pick; now it is satisfied by not creating the clip until they do.

Leave the drum case exactly as it is — a drum track still auto-loads its sampler+kit, and nothing in this plan touches that.

- [ ] **Step 1: Rewrite the instrument case**

In `ui/src/v2/lanes/trackKinds.test.ts`, replace the `it("instrument → a synth-bearing track AND an empty MIDI clip…")` block (lines 69-79) with:

```ts
  it("instrument → a BARE track: no clip, no unpicked synth (the slot asks instead)", async () => {
    const before = snap().tracks.length;
    await addTrackOfKind("midi", exec);
    await settle();
    // One command now. This used to also run add_midi_clip, which trips the backend's
    // DRM-001 default-instrument policy and silently loaded 4OSC — a synth the user never
    // chose and had no prompt to change. The Inspector's instrument slot and the empty-lane
    // double-click now ask. DRM-001 is untouched and still right for every other caller.
    expect(calls.map((c) => c.command)).toEqual(["create_track"]);
    expect(calls[0].args).toEqual({ name: "Instrument" });
    expect(snap().tracks.length).toBe(before + 1);
    const t = newest();
    // The invariant that still holds: never a clip the track cannot play. Before, that was
    // bought by auto-loading a synth; now by not making the clip until one is picked.
    expect(t.clips.length).toBe(0);
    expect(hasInstrument(t)).toBe(false);
  });
```

Also update the file header's third paragraph, which currently cites `add_midi_clip` having "no v2 call site at all" as the gap this file closed. Append:

```ts
// UPDATE (instrument affordance, 2026-07-27): the Instrument kind now creates a BARE
// track. add_midi_clip's v2 call site moved to the empty-lane menu (v2/lanes/LaneMenu.tsx),
// where the user asks for a clip explicitly. The "lands playable" claim below still holds
// for drums and tone; for instrument it is now "lands with nothing it cannot play".
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui && npx vitest run src/v2/lanes/trackKinds.test.ts
```

Expected: FAIL — the recorded sequence is still `["create_track", "add_midi_clip"]`, and `t.clips.length` is 1.

- [ ] **Step 3: Make the track land bare**

In `ui/src/v2/lanes/TrackLaneList.tsx`, replace the comment block and the two statements at lines 244-254 with:

```ts
  // There is no native "midi" track TYPE — cmdCreateTrack accepts only audio|drum, and an
  // instrument track IS an audio track carrying a synth plus MIDI clips.
  //
  // The track is created BARE, on purpose. This used to also run add_midi_clip, which
  // trips the backend's DRM-001 default-instrument policy and silently loaded 4OSC — a
  // synth the user never picked and had no prompt to change. The Inspector's instrument
  // slot now asks instead, and double-clicking the empty lane offers the same choice.
  // DRM-001 itself is untouched and still correct for every other caller: it exists
  // because a MIDI clip on an instrument-less track is silent.
  await exec("create_track", { name: "Instrument" });
```

- [ ] **Step 4: Run the rewritten kind test and the reachability suite**

```bash
cd ui && npx vitest run src/v2/lanes/trackKinds.test.ts src/agent/uiReachability.test.ts
```

Expected: PASS, including `expect(Object.keys(UI_REACH_GAPS).length).toBe(0)` and the probe sanity check that requires `add_midi_clip` to read as reachable.

If `add_midi_clip` now reads as unreachable, the cause is Task 4's call site not being in the scanned graph. The probe is a literal string search — `shell.includes('"add_midi_clip"')` — over files reachable from `ui/src/v2/AppV2.tsx`, excluding `src/agent`, `bridge.mock.ts`, and `CLASSIC_ONLY_MODULES`. `LaneMenu.tsx` is imported by `TrackLaneList.tsx`, which `AppV2` renders, so it qualifies. Verify with:

```bash
cd ui && grep -n 'add_midi_clip' src/v2/lanes/LaneMenu.tsx
```

- [ ] **Step 5: Full suite and typecheck**

```bash
cd ui && npm test && npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/v2/lanes/TrackLaneList.tsx ui/src/v2/lanes/trackKinds.test.ts
git commit -m "feat(v2): Add track → Instrument lands bare so the slot asks for a real choice"
```

---

### Task 8: End-to-end proof and full gate

The unit tests pin the pieces; this proves a mouse-only user can actually do it.

**Files:**
- Create: `ui/e2e/instrument-affordance.spec.ts`
- Test: the whole suite

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the spec**

Create `ui/e2e/instrument-affordance.spec.ts`. `bootV2` and `newProject` are the existing shared helpers (`ui/e2e/helpers.ts:52,70`); `v2-track-add` / `v2-track-add-midi` are the add-track menu's testids (`TrackLaneList.tsx:303,324`):

```ts
import { test, expect } from "@playwright/test";
import { bootV2, newProject } from "./helpers";

// A mouse-only producer's actual path: make an instrument track, discover it has no
// synth, and pick one — no keyboard, no agent.

test.beforeEach(async ({ page }) => {
  await bootV2(page);
  await newProject(page);
  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-midi").click();
});

test("empty-lane double-click on a bare track offers instrument vs audio", async ({ page }) => {
  const lane = page.getByTestId("v2-lane").last();
  await expect(lane).toBeVisible();
  await lane.dblclick({ position: { x: 300, y: 20 } });
  await expect(page.getByTestId("v2-lane-menu")).toBeVisible();
  await expect(page.getByTestId("lane-add-instrument")).toHaveText("Add instrument…");
  await page.getByTestId("lane-add-instrument").click();
  // The drawer opens on the plugins tab, pre-filtered to Instruments.
  await expect(page.getByTestId("v2-plugin-dock")).toBeVisible();
});

test("the Inspector FX tab shows an empty instrument slot on a bare track", async ({ page }) => {
  await page.getByTestId("v2-insp-tab-fx").click();
  await expect(page.getByTestId("instslot-choose")).toBeVisible();
});

test("double-clicking a MIDI clip opens the piano roll, not the lane menu", async ({ page }) => {
  const lane = page.getByTestId("v2-lane").last();
  // The Instrument track lands BARE after Task 7, so make a clip explicitly first.
  await lane.dblclick({ position: { x: 300, y: 20 } });
  await page.getByTestId("lane-add-midi-clip").click();
  const clip = lane.locator("[data-clip-id]").first();
  await expect(clip).toBeVisible();
  await clip.dblclick();
  // The e.target === e.currentTarget guard is what keeps this from being the lane menu.
  await expect(page.getByTestId("v2-lane-menu")).toHaveCount(0);
});
```

Check `data-clip-id` against what `ClipView` actually renders before relying on it:

```bash
cd ui && grep -n 'data-clip-id\|data-testid' src/v2/lanes/ClipView.tsx | head
```

Never use `force: true` on a click. If a click reports "intercepts pointer events", a menu scrim is open from an earlier step — close it, because a real user would be one click behind too.

- [ ] **Step 2: Run e2e on the isolated config**

```bash
cd ui && npx playwright test --config playwright.isolated.config.ts instrument-affordance
```

Expected: both tests PASS. Port 5191 — never `:5173`.

- [ ] **Step 3: Full local gate**

```bash
cd ui && npm test && npm run typecheck && npx playwright test --config playwright.isolated.config.ts
```

Expected: vitest green, `tsc` clean, e2e green.

- [ ] **Step 4: Confirm no sabotage survived**

```bash
grep -rn SABOTAGE ui/src ui/e2e || echo "clean"
```

Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add ui/e2e/instrument-affordance.spec.ts
git commit -m "test(e2e): a mouse-only producer can find and load an instrument"
```

---

## Verification checklist

Before calling this done, confirm each spec requirement has a task:

| Spec requirement | Task |
|---|---|
| `LANE_NEW` action, `MOSH`-only rules, classic inert | 1 |
| Double-click: instrument → clip at snapped bar | 2, 4 |
| Double-click: bare → menu (instrument / import) | 2, 4 |
| Right-click → menu + always-enabled Add MIDI clip | 4 |
| Menu labels swap vs add by track state | 4 |
| Track selected before the picker opens | 4 |
| Picker pre-filtered to `inst`, one-shot | 3 |
| Pinned instrument slot, empty and filled states | 5 |
| Instrument hidden from the rack list in v2 only | 5 |
| FX tab keeps its label | 5 |
| `IconKeys` + `isInstrument`-aware header icon | 6 |
| `addTrackOfKind` leaves the track bare | 7 |
| Stale comment rewritten, not left behind | 7 |
| `UI_REACH_GAPS` stays exactly 0 | 7 |
| DRM-001 untouched | all (no `src/` files touched) |
| e2e on the isolated config | 8 |
