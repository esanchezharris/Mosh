# Pro Tools & Logic Templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two DAW templates — Pro Tools and Logic — at parity with the shipped Ableton/FL/Mosh templates, mapping each onto existing dock affordances.

**Architecture:** A template is a UI-local bundle of settings values (`skin`, `theme`, `layout`, `gestureTable`, `keymap`, `feel.*`). Each slot has an enum/registry a new id is added to. The only structural change is a backward-compatible extension of the layout-preset type so a preset can also drive the existing right rail (`right`) and the existing Arrange/Mixer toggle (`mainView`). Zero C++ — the swappable backend seam is untouched.

**Tech Stack:** React 18 + Zustand, TypeScript (strict), Vitest (unit), Playwright (e2e), CSS custom-property token skins.

## Global Constraints

- **Zero C++.** Touch only `ui/**` and `docs/**`. The C++ backend must stay byte-identical (swappability prime directive). Final gate confirms `git status` shows no `src/**` non-UI changes.
- **UI-local only.** Templates/skins/keymaps/gestures/feel never cross the bridge — no MoshOps commands, no snapshot/event changes.
- **String ids are persisted** (templates + localStorage) — once shipped they must not change. New ids: `protools`, `logic`.
- **Accent token values are final** (the e2e `LIME` map asserts them): `protools` → `#34c3a4`, `logic` → `#4d8df0`. (Hex authored lowercase in CSS so `getComputedStyle().getPropertyValue("--lime")` matches.)
- **Follow the existing style:** keymaps spread `MOSH` and override only what differs; gesture tables are explicit rule lists; skins set the accent once and remap only grounds in the light block.
- **TDD, frequent commits.** Each task: failing test → run-fail → implement → run-pass → commit.
- Spec: `docs/superpowers/specs/2026-06-22-protools-logic-templates-design.md`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `ui/src/settings/schema.ts` | enum options for skin / layout / gestureTable / keymap | 1 |
| `ui/src/settings/schema.test.ts` | assert new enum ids coerce | 1 |
| `ui/src/interaction/keymap.ts` | `PROTOOLS` / `LOGIC` keymaps + registry + rebindable union | 2 |
| `ui/src/interaction/keymap.test.ts` | per-DAW binding assertions | 2 |
| `ui/src/interaction/gestureTables.ts` | `PROTOOLS` / `LOGIC` gesture tables + registry | 3 |
| `ui/src/interaction/gestureTables.test.ts` | per-DAW gesture assertions | 3 |
| `ui/src/settings/layoutPresets.ts` | `LayoutPreset`/`LayoutDeps` extension + 5 presets + applier | 4 |
| `ui/src/App.tsx` | switch-site deps wiring (`setMainView`, `right`) | 4 |
| `ui/src/settings/layoutPresets.test.ts` | preset + applier assertions (incl. updates) | 4 |
| `ui/src/settings/templates.ts` | `protools` / `logic` Template objects | 5 |
| `ui/src/settings/templates.test.ts` | template registry assertions (incl. updates) | 5 |
| `ui/src/ui/mosh.css` | 4 skin blocks (PT + PT-light, Logic + Logic-light) | 6 |
| `ui/e2e/helpers.ts` | `TEMPLATES` / `TEMPLATE_SKIN` / `bootRedesign` | 6 |
| `ui/e2e/templates.spec.ts` | per-skin + gesture + dock-restructure e2e | 6 |

---

### Task 1: Schema enum options

**Files:**
- Modify: `ui/src/settings/schema.ts` (skin options ~64-68, layout options ~141-145, `DAW_OPTIONS` ~167-171)
- Test: `ui/src/settings/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `coerceSetting("skin","protools")==="protools"` (and `"logic"`); same for `layout`, `gestureTable`, `keymap`. This is what makes Task 5's templates coerce without being dropped to defaults.

- [ ] **Step 1: Write the failing test** — append to `ui/src/settings/schema.test.ts` inside the existing `describe("coerceSetting", ...)`:

```ts
  it("accepts the Pro Tools / Logic enum values across the DAW selectors", () => {
    for (const id of ["skin", "layout", "gestureTable", "keymap"]) {
      expect(coerceSetting(id, "protools")).toBe("protools");
      expect(coerceSetting(id, "logic")).toBe("logic");
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/settings/schema.test.ts`
Expected: FAIL — values coerce to `"mosh"` (default) because the options don't list them yet.

- [ ] **Step 3: Add the options.** In `ui/src/settings/schema.ts`, add two entries to the **skin** options list (after `{ value: "fl", label: "FL" }`, ~line 67):

```ts
        { value: "protools", label: "Pro Tools" },
        { value: "logic", label: "Logic" },
```

Add the identical two entries to the **layout** options list (after its `{ value: "fl", label: "FL" }`, ~line 144), and to **`DAW_OPTIONS`** (after its `{ value: "fl", label: "FL" }`, ~line 170):

```ts
    { value: "protools", label: "Pro Tools" },
    { value: "logic", label: "Logic" },
```

(`DAW_OPTIONS` feeds both the `gestureTable` and `keymap` selectors, so one edit covers both.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run src/settings/schema.test.ts`
Expected: PASS (including the existing well-formed/default-in-set invariants).

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/schema.ts ui/src/settings/schema.test.ts
git commit -m "feat(templates): schema enum options for Pro Tools & Logic"
```

---

### Task 2: Keymaps

**Files:**
- Modify: `ui/src/interaction/keymap.ts` (after `FL`, ~line 116; registry ~118; `REBINDABLE_ACTIONS` ~126-132)
- Test: `ui/src/interaction/keymap.test.ts`

**Interfaces:**
- Consumes: `EditorAction as A`, `MOSH`, `KEYMAPS`, `getKeymap` (existing).
- Produces: `getKeymap("protools")` and `getKeymap("logic")` resolving the iconic combos below.

- [ ] **Step 1: Write the failing test** — append to `ui/src/interaction/keymap.test.ts` inside `describe("per-DAW keymaps", ...)`:

```ts
  it("pro tools: ⌘E separates, ⌘Space records, F7/F8 pick Selector/Grabber, Return → start", () => {
    const pt = getKeymap("protools");
    expect(resolveKey(pt, ev({ key: "e", metaKey: true }))).toBe(A.SPLIT);
    expect(resolveKey(pt, ev({ key: " ", metaKey: true }))).toBe(A.RECORD);
    expect(resolveKey(pt, ev({ key: "F7" }))).toBe(A.TOOL_RANGE);
    expect(resolveKey(pt, ev({ key: "F8" }))).toBe(A.TOOL_MOVE);
    expect(resolveKey(pt, ev({ key: "Enter" }))).toBe(A.TO_START);
    // differs from mosh: F7 unbound, Home → start, plain R still records on mosh
    expect(resolveKey(getKeymap("mosh"), ev({ key: "F7" }))).toBeNull();
    expect(resolveKey(getKeymap("mosh"), ev({ key: "Home" }))).toBe(A.TO_START);
  });

  it("logic: ⌘T splits at playhead, Return → start, R still records (from mosh core)", () => {
    const lg = getKeymap("logic");
    expect(resolveKey(lg, ev({ key: "t", metaKey: true }))).toBe(A.SPLIT);
    expect(resolveKey(lg, ev({ key: "Enter" }))).toBe(A.TO_START);
    expect(resolveKey(lg, ev({ key: "r" }))).toBe(A.RECORD);
    // logic does NOT use ⌘E (only ...MOSH, which leaves it unbound)
    expect(resolveKey(lg, ev({ key: "e", metaKey: true }))).toBeNull();
  });
```

Also extend the existing shared-core loop (`it("every preset keeps undo on Mod+Z ...")`) to include the new ids:

```ts
    for (const name of ["mosh", "ableton", "fl", "protools", "logic"])
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/interaction/keymap.test.ts`
Expected: FAIL — `getKeymap("protools")`/`("logic")` fall back to mosh, so the iconic combos don't resolve.

- [ ] **Step 3: Implement.** In `ui/src/interaction/keymap.ts`, after the `FL` definition (~line 116) add:

```ts
// Pro Tools — Separate Clip = ⌘E; Selector = F7, Grabber = F8; Record = ⌘Space
// (PT also uses numpad 3); Return = back to start.
const PROTOOLS: Keymap = {
  ...MOSH,
  [A.SPLIT]: "Mod+E",
  [A.RECORD]: "Mod+Space",
  [A.TOOL_RANGE]: "F7",
  [A.TOOL_MOVE]: "F8",
  [A.TO_START]: "Enter",
};

// Logic — Split at Playhead = ⌘T; Record stays R (mosh core); Return = back to start.
const LOGIC: Keymap = {
  ...MOSH,
  [A.SPLIT]: "Mod+T",
  [A.TO_START]: "Enter",
};
```

Update the registry (~line 118):

```ts
export const KEYMAPS: Record<string, Keymap> = { mosh: MOSH, ableton: ABLETON, fl: FL, protools: PROTOOLS, logic: LOGIC };
```

Add both to the `REBINDABLE_ACTIONS` union (~line 126-132):

```ts
export const REBINDABLE_ACTIONS: Action[] = Array.from(
  new Set<Action>([
    ...(Object.keys(MOSH) as Action[]),
    ...(Object.keys(ABLETON) as Action[]),
    ...(Object.keys(FL) as Action[]),
    ...(Object.keys(PROTOOLS) as Action[]),
    ...(Object.keys(LOGIC) as Action[]),
  ]),
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run src/interaction/keymap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/interaction/keymap.ts ui/src/interaction/keymap.test.ts
git commit -m "feat(templates): Pro Tools & Logic keymaps"
```

---

### Task 3: Gesture tables

**Files:**
- Modify: `ui/src/interaction/gestureTables.ts` (after `FL`, ~line 67; registry ~69-73)
- Test: `ui/src/interaction/gestureTables.test.ts`

**Interfaces:**
- Consumes: `EditorAction as A`, `GestureRule`/`GestureTable`, `RULER_RULES`, `getGestureTable`, `GESTURE_TABLES`.
- Produces: `getGestureTable("protools")` (Smart-Tool/Ableton-family) and `getGestureTable("logic")` (Pointer/Mosh-family).

- [ ] **Step 1: Write the failing test** — append to `ui/src/interaction/gestureTables.test.ts`:

```ts
describe("pro tools preset (Smart Tool)", () => {
  it("clip.header drag MOVE; clip.body drag TIME_SELECT, dblclick OPEN; edge TRIM", () => {
    expect(r("protools", { region: "clip.header", gesture: "drag" })).toBe(A.MOVE);
    expect(r("protools", { region: "clip.body", gesture: "drag" })).toBe(A.TIME_SELECT);
    expect(r("protools", { region: "clip.body", gesture: "dblclick" })).toBe(A.OPEN);
    expect(r("protools", { region: "clip.edge", gesture: "drag" })).toBe(A.TRIM);
  });
});

describe("logic preset (Pointer)", () => {
  it("whole clip drag MOVE (the key Logic distinction), edge TRIM, empty MARQUEE", () => {
    expect(r("logic", { region: "clip.body", gesture: "drag" })).toBe(A.MOVE);
    expect(r("logic", { region: "clip.body", gesture: "click" })).toBe(A.SELECT);
    expect(r("logic", { region: "clip.edge", gesture: "drag" })).toBe(A.TRIM);
    expect(r("logic", { region: "empty", gesture: "drag" })).toBe(A.MARQUEE);
  });
});
```

Extend the `getGestureTable` fallback test and the shared-ruler loop to include the new ids:

```ts
    expect(getGestureTable("protools")).toBe(GESTURE_TABLES.protools);
    expect(getGestureTable("logic")).toBe(GESTURE_TABLES.logic);
```
```ts
    for (const name of ["mosh", "ableton", "fl", "protools", "logic"]) {
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/interaction/gestureTables.test.ts`
Expected: FAIL — both fall back to mosh, so PT body-drag resolves MOVE (not TIME_SELECT) and `GESTURE_TABLES.protools` is undefined.

- [ ] **Step 3: Implement.** In `ui/src/interaction/gestureTables.ts`, after the `FL` table (~line 67) add:

```ts
// ── Pro Tools — the Smart Tool: top of clip = Grabber (move), lower = Selector
// (time-select), edges = Trim. Same shape as Ableton's header/body split.
const PROTOOLS: GestureTable = [
  { region: "clip.header", gesture: "click", action: A.SELECT },
  { region: "clip.header", gesture: "drag", action: A.MOVE },
  { region: "clip.body", gesture: "click", action: A.SELECT },
  { region: "clip.body", gesture: "drag", action: A.TIME_SELECT },
  { region: "clip.body", gesture: "dblclick", action: A.OPEN },
  { region: "clip.edge", gesture: "drag", action: A.TRIM },
  { region: "empty", gesture: "click", action: A.DESELECT },
  { region: "empty", gesture: "drag", action: A.MARQUEE },
  ...RULER_RULES,
];

// ── Logic — the default Pointer tool: dragging a region moves it (whole clip).
// Marquee (Logic's range tool) is out of scope here. Edge trims; empty marquees.
const LOGIC: GestureTable = [
  { region: "clip", gesture: "click", action: A.SELECT },
  { region: "clip", gesture: "drag", action: A.MOVE },
  { region: "clip", gesture: "dblclick", action: A.OPEN },
  { region: "clip", gesture: "contextmenu", action: A.CONTEXT_MENU },
  { region: "clip.edge", gesture: "drag", action: A.TRIM },
  { region: "empty", gesture: "click", action: A.DESELECT },
  { region: "empty", gesture: "drag", action: A.MARQUEE },
  ...RULER_RULES,
];
```

Update the registry (~line 69):

```ts
export const GESTURE_TABLES: Record<string, GestureTable> = {
  mosh: MOSH,
  ableton: ABLETON,
  fl: FL,
  protools: PROTOOLS,
  logic: LOGIC,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run src/interaction/gestureTables.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/interaction/gestureTables.ts ui/src/interaction/gestureTables.test.ts
git commit -m "feat(templates): Pro Tools (Smart Tool) & Logic (Pointer) gesture tables"
```

---

### Task 4: Layout presets + App.tsx wiring

**Files:**
- Modify: `ui/src/settings/layoutPresets.ts` (types ~11-31, presets ~17-24, applier ~34-43)
- Modify: `ui/src/App.tsx` (the switch-site deps, ~67-72)
- Test: `ui/src/settings/layoutPresets.test.ts`

**Interfaces:**
- Consumes: `Snapshot` (existing), `View` type from `../store` (`"arrange" | "mixer"`), `useStore.getState().setView`, `useDockLayout.getState().applyPreset` (already accepts `{left?,right?,bottom?}`).
- Produces: `LayoutPreset` with optional `right?: ZonePreset` and `mainView?: View`; `LayoutDeps` with `setMainView: (v: View) => void` and `applyDock: (p:{left?:ZonePreset; right?:ZonePreset}) => void`; `LAYOUT_PRESETS` now has `protools` and `logic`.

> **Why types + App.tsx are one task:** making `setMainView` a required `LayoutDeps` field breaks the App.tsx call site at compile time. They must land in the same commit to keep the build green.

- [ ] **Step 1: Update the existing tests + write the new ones.** In `ui/src/settings/layoutPresets.test.ts`:

  a. Extend the `deps()` helper to provide `setMainView`:

```ts
const deps = (snapshot: Snapshot | null = null) => ({
  applyDock: vi.fn(),
  openDrumWindow: vi.fn(),
  closeDrumWindow: vi.fn(),
  setMainView: vi.fn(),
  snapshot,
});
```

  b. Replace the registry-count test body:

```ts
  it("ships the five v1 templates", () => {
    expect(Object.keys(LAYOUT_PRESETS).sort()).toEqual(["ableton", "fl", "logic", "mosh", "protools"]);
  });
```

  c. Update the two `applyDock` shape assertions (now carry `right`):

```ts
    // in the ableton test:
    expect(d.applyDock).toHaveBeenCalledWith({ left: { collapsed: false, size: 260 }, right: { collapsed: false } });
    // in the mosh test:
    expect(d.applyDock).toHaveBeenCalledWith({ left: { collapsed: true }, right: { collapsed: false } });
```

  d. Repoint the "unknown layout falls back to mosh" test off the now-real `"protools"`:

```ts
  it("an unknown layout falls back to mosh (minimal)", () => {
    const d = deps();
    applyLayoutArrangement("cubase", d);
    expect(d.applyDock).toHaveBeenCalledWith({ left: { collapsed: true }, right: { collapsed: false } });
    expect(d.closeDrumWindow).toHaveBeenCalled();
  });
```

  e. Add new behavior tests:

```ts
describe("Pro Tools & Logic presets", () => {
  it("pro tools: collapses both rails and opens the Edit (arrange) view", () => {
    const d = deps();
    applyLayoutArrangement("protools", d);
    expect(d.applyDock).toHaveBeenCalledWith({ left: { collapsed: true }, right: { collapsed: true } });
    expect(d.setMainView).toHaveBeenCalledWith("arrange");
    expect(d.closeDrumWindow).toHaveBeenCalled();
  });
  it("logic: opens Library (left) + Inspector (right), arrange view", () => {
    const d = deps();
    applyLayoutArrangement("logic", d);
    expect(d.applyDock).toHaveBeenCalledWith({ left: { collapsed: false, size: 230 }, right: { collapsed: false, size: 300 } });
    expect(d.setMainView).toHaveBeenCalledWith("arrange");
  });
  it("a preset without mainView (mosh) does not force the view", () => {
    const d = deps();
    applyLayoutArrangement("mosh", d);
    expect(d.setMainView).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/settings/layoutPresets.test.ts`
Expected: FAIL — `setMainView` undefined / presets missing / applyDock shape mismatch.

- [ ] **Step 3: Implement `layoutPresets.ts`.** Replace the types + presets + applier (lines 9-43) with:

```ts
import type { Snapshot } from "../types";
import type { View } from "../store"; // "arrange" | "mixer"

export type ZonePreset = { collapsed?: boolean; size?: number };
export type LayoutPreset = {
  left?: ZonePreset;             // the browser rail (the main per-DAW IA difference)
  right?: ZonePreset;            // the Session/Inspector rail (Logic's inspector; PT tucks it)
  drumWindow?: "open" | "close"; // FL's floating channel-rack / drum window
  mainView?: View;              // drive the existing Arrange/Mixer toggle (PT Edit window)
};

export const LAYOUT_PRESETS: Record<string, LayoutPreset> = {
  // Minimal, agent-driven default: browser tucked, the Moshi/Inspector rail kept open.
  mosh: { left: { collapsed: true }, right: { collapsed: false }, drumWindow: "close" },
  // Browser-forward — the Ableton/Live resting shape.
  ableton: { left: { collapsed: false, size: 260 }, right: { collapsed: false }, drumWindow: "close" },
  // Browser-forward + the floating channel-rack / drum window — FL's signature.
  fl: { left: { collapsed: false, size: 220 }, right: { collapsed: false }, drumWindow: "open" },
  // Pro Tools — the Edit window: both rails out of the way → a focused timeline. The
  // existing Mixer view is PT's "Mix window," reached by the existing toggle.
  protools: { left: { collapsed: true }, right: { collapsed: true }, drumWindow: "close", mainView: "arrange" },
  // Logic — Library (left) + Inspector (right, our Session rail), arrange in the middle.
  logic: { left: { collapsed: false, size: 230 }, right: { collapsed: false, size: 300 }, drumWindow: "close", mainView: "arrange" },
};

export type LayoutDeps = {
  applyDock: (p: { left?: ZonePreset; right?: ZonePreset }) => void;
  openDrumWindow: (clipId: string) => void;
  closeDrumWindow: () => void;
  setMainView: (v: View) => void;
  snapshot: Snapshot | null;
};

/** Apply a template's panel arrangement. Pure over injected deps (testable headless). */
export function applyLayoutArrangement(layout: string, deps: LayoutDeps): void {
  const preset = LAYOUT_PRESETS[layout] ?? LAYOUT_PRESETS.mosh;
  deps.applyDock({ left: preset.left, right: preset.right });
  if (preset.mainView) deps.setMainView(preset.mainView);
  if (preset.drumWindow === "open") {
    const clip = deps.snapshot?.tracks.find((t) => t.type === "drum")?.clips.find((c) => c.type === "midi");
    if (clip) deps.openDrumWindow(clip.id);
  } else if (preset.drumWindow === "close") {
    deps.closeDrumWindow();
  }
}
```

(Keep the file's existing header comment; update its last sentence — drop the "Pro Tools / Logic deferred" note since they now ship.)

- [ ] **Step 4: Wire the App.tsx switch site.** In `ui/src/App.tsx`, the `applyLayoutArrangement(...)` call (~67-72) becomes:

```tsx
      applyLayoutArrangement(layout, {
        applyDock: useDockLayout.getState().applyPreset,
        openDrumWindow: useDrumWindow.getState().open,
        closeDrumWindow: useDrumWindow.getState().close,
        setMainView: useStore.getState().setView,
        snapshot,
      });
```

(`useStore` is already imported at `ui/src/App.tsx:13`; `setView` exists on the store. No other App.tsx change — the boot/reload guard is untouched: `mainView` is transient and defaults to `"arrange"` on reload, which both new templates want.)

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `cd ui && npx vitest run src/settings/layoutPresets.test.ts && npx tsc --noEmit`
Expected: PASS, and `tsc` clean (the App.tsx call site satisfies the new `LayoutDeps`).

- [ ] **Step 6: Commit**

```bash
git add ui/src/settings/layoutPresets.ts ui/src/settings/layoutPresets.test.ts ui/src/App.tsx
git commit -m "feat(templates): layout presets drive right rail + Arrange/Mixer view (PT/Logic)"
```

---

### Task 5: Template definitions

**Files:**
- Modify: `ui/src/settings/templates.ts` (`TEMPLATES` array, ~17-48)
- Test: `ui/src/settings/templates.test.ts`

**Interfaces:**
- Consumes: schema options (Task 1), keymap/gesture/layout registries (Tasks 2-4) — so the referenced ids resolve and coerce.
- Produces: `template("protools")` / `template("logic")`; `TEMPLATES.length === 5`.

- [ ] **Step 1: Update the existing tests + add coverage.** In `ui/src/settings/templates.test.ts`:

```ts
  it("ships the five built-ins", () => {
    expect(TEMPLATES.map((t) => t.name).sort()).toEqual(["ableton", "fl", "logic", "mosh", "protools"]);
  });
```

Extend the layout-pin test:

```ts
  it("pins a panel layout per template (FL = its floating layout)", () => {
    expect(template("mosh")?.values.layout).toBe("mosh");
    expect(template("ableton")?.values.layout).toBe("ableton");
    expect(template("fl")?.values.layout).toBe("fl");
    expect(template("protools")?.values.layout).toBe("protools");
    expect(template("logic")?.values.layout).toBe("logic");
  });
```

(The "distinct skin" and "carries only already-valid values" tests scale automatically — they iterate `TEMPLATES`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/settings/templates.test.ts`
Expected: FAIL — only three built-ins; `template("protools")` undefined.

- [ ] **Step 3: Implement.** In `ui/src/settings/templates.ts`, add two entries to `TEMPLATES` after the `fl` entry (~line 47):

```ts
  {
    name: "protools",
    label: "Pro Tools",
    values: {
      skin: "protools", theme: "dark", layout: "protools",
      gestureTable: "protools", keymap: "protools",
      "feel.dragThreshold": 3, "feel.edgeGrabPx": 6, "feel.snapStrength": 1,
    },
  },
  {
    name: "logic",
    label: "Logic",
    values: {
      skin: "logic", theme: "dark", layout: "logic",
      gestureTable: "logic", keymap: "logic",
      "feel.dragThreshold": 3, "feel.edgeGrabPx": 7, "feel.snapStrength": 1,
    },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run src/settings/templates.test.ts`
Expected: PASS (coercion no-op holds because Task 1 added the enum options).

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/templates.ts ui/src/settings/templates.test.ts
git commit -m "feat(templates): Pro Tools & Logic template bundles"
```

---

### Task 6: Skins (CSS) + e2e

**Files:**
- Modify: `ui/src/ui/mosh.css` (insert after the FL light block, ~line 130, before `* { box-sizing: border-box; }`)
- Modify: `ui/e2e/helpers.ts` (`TEMPLATES` line 8, `TEMPLATE_SKIN` lines 11-15, add `bootRedesign`)
- Modify: `ui/e2e/templates.spec.ts` (`LIME` line 13, the move-loop line 42, add a PT body-time-select test, add a redesign-on dock-restructure describe)

**Interfaces:**
- Consumes: everything from Tasks 1-5; the dock test surface from `DockShell.tsx` (`dock-left`, `browser-expand`, `dock-right` [hidden when collapsed], `inspector-expand` [present when collapsed]); the redesign default (right rail rendered only when `redesignShell` on).
- Produces: the end-to-end proof the templates render + behave.

- [ ] **Step 1: Add the skin CSS.** In `ui/src/ui/mosh.css`, insert after the `[data-skin="fl"][data-theme="light"]` block (~line 130):

```css
/* Pro Tools — flat neutral charcoal, teal-green accent (PT's edit-selection green). */
[data-skin="protools"] {
  --ink: #1b1c1e;
  --ink-raise: #27282b;
  --ink-deep: #121315;
  --ink-line: #34363a;
  --ink-line-soft: #25272a;
  --bone: #e9eaec;
  --mist: #c9cbcf;
  --bone-dim: rgba(233, 234, 236, 0.55);
  --lime: #34c3a4;
  --lime-glow: #4fd9bb;
  --lime-dim: rgba(52, 195, 164, 0.5);
  --lime-faint: rgba(52, 195, 164, 0.14);
}
[data-skin="protools"][data-theme="light"] {
  --ink: #eceef0;
  --ink-raise: #ffffff;
  --ink-deep: #dfe2e5;
  --ink-line: #cdd1d6;
  --ink-line-soft: #dde0e4;
  --bone: #1b1c1e;
  --mist: #3a3d42;
  --bone-dim: rgba(27, 28, 30, 0.6);
}

/* Logic — warm graphite, azure-blue accent (Logic's transport/selection blue). */
[data-skin="logic"] {
  --ink: #1d1e22;
  --ink-raise: #2a2b30;
  --ink-deep: #141519;
  --ink-line: #383a40;
  --ink-line-soft: #292b30;
  --bone: #e8e9ed;
  --mist: #c8cad0;
  --bone-dim: rgba(232, 233, 237, 0.55);
  --lime: #4d8df0;
  --lime-glow: #6ba3f6;
  --lime-dim: rgba(77, 141, 240, 0.5);
  --lime-faint: rgba(77, 141, 240, 0.14);
}
[data-skin="logic"][data-theme="light"] {
  --ink: #e9eaee;
  --ink-raise: #ffffff;
  --ink-deep: #dcdee3;
  --ink-line: #c9ccd2;
  --ink-line-soft: #d9dbe0;
  --bone: #1d1e22;
  --mist: #3a3c42;
  --bone-dim: rgba(29, 30, 34, 0.6);
}
```

- [ ] **Step 2: Extend the e2e helpers.** In `ui/e2e/helpers.ts`:

```ts
export const TEMPLATES = ["mosh", "ableton", "fl", "protools", "logic"] as const;
```

Add to `TEMPLATE_SKIN`:

```ts
  protools: { skin: "protools", theme: "dark", label: "Pro Tools" },
  logic: { skin: "logic", theme: "dark", label: "Logic" },
```

Add a `bootRedesign` helper (next to `boot`):

```ts
/** Boot in the agent-first REDESIGN shell (the shipping default) so the right
 *  Session/Inspector rail is present — needed to observe the PT/Logic right-rail
 *  restructure. (redesign-shell.spec has its own local copy; this is the shared one.) */
export async function bootRedesign(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 1, template: null, values: { redesignShell: true } }));
  });
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("arrangement")).toBeVisible();
}
```

- [ ] **Step 3: Extend `templates.spec.ts`.** Add the accent entries:

```ts
const LIME: Record<string, string> = { mosh: "#ccff23", ableton: "#ffcf33", fl: "#ff7a1a", protools: "#34c3a4", logic: "#4d8df0" };
```

Add Logic to the body-drag-moves loop (line 42):

```ts
  for (const name of ["mosh", "fl", "logic"] as const) {
```

Add a Pro Tools body-time-select test (after the ableton one, ~line 62):

```ts
  test("pro tools: clip body time-selects, header moves", async ({ page }) => {
    await applyTemplate(page, "protools");
    const clip = await singleMidiClip(page);
    await dragClipBy(page, clip, 140);
    await expect(page.getByTestId("range-band")).toBeVisible();
    expect(await clipNum(clip, "data-clip-start")).toBe(0);
    await dragClipHeaderBy(page, clip, 120);
    await expect.poll(() => clipNum(clip, "data-clip-start")).toBeGreaterThan(0);
  });
```

Add `bootRedesign` to the helpers import (line 2-6 import block), then add a redesign-on dock-restructure describe (after the existing `test.describe` block, before the persistence test):

```ts
test.describe("dock restructure (redesign shell)", () => {
  test("Pro Tools tucks both rails; Logic opens Library + Inspector", async ({ page }) => {
    await bootRedesign(page);
    await expect(page.getByTestId("dock-right")).toBeVisible(); // redesign default: Inspector open
    // Pro Tools → Edit window: both rails collapse to tabs
    await applyTemplate(page, "protools");
    await expect(page.getByTestId("inspector-expand")).toBeVisible(); // right collapsed
    await expect(page.getByTestId("browser-expand")).toBeVisible();   // left collapsed
    // Logic → Library + Inspector open
    await applyTemplate(page, "logic");
    await expect(page.getByTestId("dock-right")).toBeVisible();        // Inspector back
    await expect(page.getByTestId("dock-left")).toBeVisible();         // Library open
  });
});
```

> NOTE: `applyTemplate` (the spec-local helper) opens Settings via `button[title="Settings"]`. Confirm that button is present in the redesign shell before relying on it; if Settings was relocated into the "+" FileOptions control, open it from there instead. (The redesign relocates File/Export, not Settings, so it should be present — verify during the run.)

- [ ] **Step 4: Run vitest (full) to confirm no unit regressions**

Run: `cd ui && npm test`
Expected: PASS (all suites, including the four touched in Tasks 1-5).

- [ ] **Step 5: Run the e2e suite**

Run: `cd ui && npm run test:e2e`
Expected: PASS — the per-template loop now covers Pro Tools + Logic (skin/theme/accent), the gesture tests pass, and the redesign dock-restructure test passes. (Playwright's `webServer` starts Vite automatically.)

If the redesign Settings selector differs (see NOTE), fix the helper and re-run.

- [ ] **Step 6: Commit**

```bash
git add ui/src/ui/mosh.css ui/e2e/helpers.ts ui/e2e/templates.spec.ts
git commit -m "feat(templates): Pro Tools & Logic skins + e2e coverage"
```

---

### Task 7: Verification gate + visual proof

**Files:** none (verification only).

- [ ] **Step 1: Typecheck (src + e2e)**

Run: `cd ui && npm run typecheck`
Expected: clean (`tsc --noEmit && tsc -p tsconfig.e2e.json`, no errors).

- [ ] **Step 2: Full unit + e2e**

Run: `cd ui && npm test && npm run test:e2e`
Expected: both green.

- [ ] **Step 3: Confirm zero C++ / backend churn**

Run: `git diff --name-only main...HEAD`
Expected: only `ui/**` and `docs/**` paths. No `src/**` (C++), `service/**`, `relay/**`, or CMake changes. (Satisfies the swappability prime directive — the backend is byte-identical.)

- [ ] **Step 4: Visual proof.** Start the UI dev server and screenshot the two new skins (via the preview tools): apply Pro Tools, screenshot; apply Logic, screenshot. Confirm the teal (PT) and azure (Logic) accents render and the dock restructures (PT focused timeline; Logic Library + Inspector). Attach the screenshots to the summary.

- [ ] **Step 5: Final summary.** Report: vitest count, e2e count, tsc clean, the name-only diff (UI/docs only), and the two screenshots. No commit (Task 6 was the last change).

---

## Self-Review

**1. Spec coverage:**
- §2 skins → Task 6 (CSS) + Task 1 (skin enum). ✓
- §3 layout presets (right + mainView, all-five) → Task 4. ✓
- §4 gesture tables → Task 3. ✓
- §5 keymaps → Task 2. ✓
- §6 feel → Task 5 (in template `values`). ✓
- §7 templates → Task 5. ✓
- §8 registration checklist → spread across Tasks 1-6 (schema, layoutPresets+App, gestureTables, keymap, mosh.css, e2e helpers). ✓
- §9 tests → each task's test step + Task 6 e2e. The "update the existing `protools`-fallback test" is Task 4 step 1d. ✓
- §10 verification gate → Task 7. ✓
- §11 out-of-scope → not built (no Edit/Mix dual-window, no new keymap action). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows the actual code; commands have expected output. The one judgment note (redesign Settings selector) carries a concrete verification + fallback, not a placeholder.

**3. Type consistency:** `setMainView: (v: View) => void` and `View` import from `../store` used consistently across `LayoutDeps`, `applyLayoutArrangement`, and the App.tsx call site (`useStore.getState().setView`). `applyDock` signature `{left?,right?}` matches the `{ left, right }` call and `useDockLayout.applyPreset`. Registry keys (`protools`/`logic`) identical across schema options, KEYMAPS, GESTURE_TABLES, LAYOUT_PRESETS, templates, TEMPLATE_SKIN, LIME. Accent hexes (`#34c3a4`, `#4d8df0`) identical in mosh.css and the e2e LIME map. ✓
