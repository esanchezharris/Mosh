# Pro Tools & Logic DAW Templates — Design

**Date:** 2026-06-22
**Branch:** `claude/ui-redesign-v1`
**Scope:** Add two new DAW templates — **Pro Tools** and **Logic** — alongside the
shipped Mosh / Ableton / FL templates. **Parity + existing affordances:** each new
template fills the same six slots Ableton/FL fill, and maps each DAW's identity onto
dock affordances that *already exist*. **Zero C++.** No new dock-engine machinery —
the only structural change is a small, backward-compatible extension to the
layout-preset type so a preset can drive the existing right rail and the existing
Arrange/Mixer view toggle.

This closes the deferral noted in `ui/src/settings/layoutPresets.ts:7`
("Pro Tools (Edit/Mix split) and Logic (left inspector) are deferred — bigger
structural changes") **without** building the heavy structural features — instead it
reuses what's already there.

---

## 1. Background — how a template works today

A template (`ui/src/settings/templates.ts`) is a pure UI-local bundle of settings
values. Selecting it materialises all its `values` into the settings store
(`applyTemplate`), then `applySettingEffects` writes `data-skin` / `data-theme` on
`<html>`, and an `App.tsx` effect calls `applyLayoutArrangement(layout, deps)` on a
template *switch* (never on boot — boot respects the user's saved dock drags).

A template fills six slots:

| Slot | Where it lives | What it controls |
|---|---|---|
| `skin` | `mosh.css` `[data-skin="…"]` blocks | CSS token set (accent + grounds) |
| `theme` | `[data-theme="light"]` combined selector | light/dark ground (independent axis) |
| `layout` | `layoutPresets.ts` `LAYOUT_PRESETS` | dock restructure on switch |
| `gestureTable` | `gestureTables.ts` `GESTURE_TABLES` | clip pointer behavior |
| `keymap` | `keymap.ts` `KEYMAPS` | keyboard shortcuts |
| `feel.*` | `feel.ts` / schema | drag threshold, edge grab, snap, etc. |

Every slot has an enum/registry that a new id must be added to (see §8 checklist).
All of it is UI-local — the swappable backend seam is untouched.

---

## 2. Skins (CSS tokens — `ui/src/ui/mosh.css`)

The shipped trio is all **warm**: Mosh lime `#ccff23`, Ableton amber `#ffcf33`, FL
orange `#ff7a1a`. The two new skins are **cool**, so all five read as distinct at a
glance and PT vs Logic are clearly separable (green-teal vs blue).

Each skin defines exactly the token set an existing skin block defines (mirror the
FL block: the four `--lime*` accent tokens + the `--ink*` grounds + `--bone`/`--mist`/
`--bone-dim` text). Per the independent-axis technique, the **accent is set once** in
the base skin block and **not** remapped in the light block; the light block only
remaps grounds + text.

### Pro Tools — flat neutral charcoal, teal-green accent (precise/technical)

```css
/* Pro Tools — flat neutral charcoal, teal-green accent. PT's edit-selection green. */
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
```

### Logic — warm graphite, azure-blue accent (musical/modern)

```css
/* Logic — warm graphite, azure-blue accent. Logic's transport/selection blue. */
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

> Exact ground hexes will be reconciled against the existing FL/Ableton blocks during
> implementation so contrast holds; the **accent values above are final** (the e2e
> `LIME` map asserts them): `protools` → `#34c3a4`, `logic` → `#4d8df0`.

---

## 3. Layout presets — the "existing affordances" mapping

`LayoutPreset` gains two **optional, backward-compatible** fields. Both ride paths
that already exist: `applyPreset` in `useDockLayout.ts` already merges a `right` zone,
and the store already has `view`/`setView` for the Arrange/Mixer toggle.

```ts
import type { View } from "../store"; // "arrange" | "mixer"

export type LayoutPreset = {
  left?: ZonePreset;
  right?: ZonePreset;            // NEW — the Session/Inspector rail (Logic's inspector)
  drumWindow?: "open" | "close";
  mainView?: View;               // NEW — drive the existing Arrange/Mixer toggle (PT Edit/Mix)
};

export type LayoutDeps = {
  applyDock: (p: { left?: ZonePreset; right?: ZonePreset }) => void; // right added
  openDrumWindow: (clipId: string) => void;
  closeDrumWindow: () => void;
  setMainView: (v: View) => void; // NEW
  snapshot: Snapshot | null;
};
```

`applyLayoutArrangement` additionally calls `deps.applyDock({ left, right })` and, when
`preset.mainView` is set, `deps.setMainView(preset.mainView)`.

### Preset table — `right` is declared on **all five** so switching is deterministic in any order

```ts
export const LAYOUT_PRESETS: Record<string, LayoutPreset> = {
  // unchanged behavior — right was already open by default; declaring it is a no-op
  mosh:    { left: { collapsed: true },              right: { collapsed: false }, drumWindow: "close" },
  ableton: { left: { collapsed: false, size: 260 },  right: { collapsed: false }, drumWindow: "close" },
  fl:      { left: { collapsed: false, size: 220 },  right: { collapsed: false }, drumWindow: "open" },

  // Pro Tools — the Edit window: both rails out of the way → maximal focused timeline.
  // The existing Mixer view is PT's "Mix window," reached by the existing toggle.
  protools:{ left: { collapsed: true },              right: { collapsed: true },  drumWindow: "close", mainView: "arrange" },

  // Logic — left Library + right Inspector (our Session rail = Logic's Inspector),
  // arrange in the middle.
  logic:   { left: { collapsed: false, size: 230 },  right: { collapsed: false, size: 300 }, drumWindow: "close", mainView: "arrange" },
};
```

**Why `right` on the existing three:** the right rail (Moshi + collaborators +
inspector) defaults **open** in the redesign and no template previously touched it, so
switching among mosh/ableton/fl always left it open. Declaring `right: {collapsed:false}`
makes that explicit and — crucially — guarantees that switching **away from Pro Tools**
(which collapses it) re-opens the agent rail. No observable change to the existing
three; it only makes order-independence true.

**App.tsx wiring:** at the switch call site, add `setMainView: useStore.getState().setView`
to the deps and let `applyDock` receive `right`. The boot/reload guard is unchanged —
`mainView` is transient (defaults to `"arrange"` on reload, which both new templates
want) and the dock rails still restore from their own persistence on boot.

---

## 4. Gesture tables (`ui/src/interaction/gestureTables.ts`)

Two new tables, defined explicitly (not aliased) so they can diverge later.

- **Pro Tools** = Smart-Tool model (same shape as the existing **Ableton** table):
  `clip.header`→`MOVE`, `clip.body`→`TIME_SELECT`, `clip.body` dblclick→`OPEN`,
  `clip.edge`→`TRIM`, `empty` click→`DESELECT` / drag→`MARQUEE`, plus the shared
  `RULER_RULES`. Faithful to PT's Smart Tool: top of clip = Grabber (move), lower =
  Selector (time-select), edges = Trim.

- **Logic** = Pointer model (same shape as the existing **Mosh** table): whole clip
  click→`SELECT` / drag→`MOVE` / dblclick→`OPEN`, `clip.edge`→`TRIM`, `empty`
  click→`DESELECT` / drag→`MARQUEE`, plus `RULER_RULES`. Faithful to Logic's default
  Pointer tool: dragging a region moves it (the Marquee tool — not modeled here —
  is Logic's range tool).

Register both in `GESTURE_TABLES`.

---

## 5. Keymaps (`ui/src/interaction/keymap.ts`)

Follow the existing style: spread `MOSH`, override only the bindings that differ.
MOSH baseline (confirmed): `PLAY_PAUSE:Space`, `RECORD:R`, `UNDO:Mod+Z`,
`REDO:Mod+Shift+Z`, `SAVE:Mod+S`, `DELETE:[Delete,Backspace]`, `COPY/CUT/PASTE:Mod+C/X/V`,
`DUPLICATE:Mod+D`, `GROUP:Mod+G`, `TO_START:Home`, `TO_END:End`,
`TOOL_MOVE:1`, `TOOL_SPLIT:2`, `TOOL_RANGE:3`. MOSH has **no** `SPLIT` command binding.

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

// Logic — Split at Playhead = ⌘T; Record stays R (MOSH); Return = back to start.
const LOGIC: Keymap = {
  ...MOSH,
  [A.SPLIT]: "Mod+T",
  [A.TO_START]: "Enter",
};
```

Register both in `KEYMAPS`. (`REBINDABLE_ACTIONS` already unions every preset's keys;
add the two new presets to that union so any new action — none here — would surface
as a rebind descriptor.)

**Distinctness (asserted by tests, faithful to the real DAWs):**
- PT vs MOSH: `SPLIT` (Mod+E, MOSH unbound), `RECORD` (Mod+Space vs R), `TOOL_RANGE`
  (F7 vs 3), `TOOL_MOVE` (F8 vs 1), `TO_START` (Enter vs Home).
- Logic vs MOSH: `SPLIT` (Mod+T, MOSH unbound), `TO_START` (Enter vs Home).
- Logic `SPLIT` (Mod+T) is distinct from PT/Ableton/FL (`Mod+E`).

---

## 6. Feel (`feel.*` in each template's `values`)

- **Pro Tools:** `feel.dragThreshold: 3`, `feel.edgeGrabPx: 6` (tighter — grid-precise
  editing), `feel.snapStrength: 1`.
- **Logic:** `feel.dragThreshold: 3`, `feel.edgeGrabPx: 7` (default), `feel.snapStrength: 1`.

---

## 7. Templates (`ui/src/settings/templates.ts`)

```ts
{
  name: "protools", label: "Pro Tools",
  values: {
    skin: "protools", theme: "dark", layout: "protools",
    gestureTable: "protools", keymap: "protools",
    "feel.dragThreshold": 3, "feel.edgeGrabPx": 6, "feel.snapStrength": 1,
  },
},
{
  name: "logic", label: "Logic",
  values: {
    skin: "logic", theme: "dark", layout: "logic",
    gestureTable: "logic", keymap: "logic",
    "feel.dragThreshold": 3, "feel.edgeGrabPx": 7, "feel.snapStrength": 1,
  },
},
```

The SettingsPanel renders `TEMPLATES.map(...)`, so the picker shows both new buttons
automatically.

---

## 8. Registration checklist (every spot a new id must be added)

1. `ui/src/settings/templates.ts` — two `Template` objects (§7).
2. `ui/src/settings/schema.ts` — add `{value:"protools",label:"Pro Tools"}` and
   `{value:"logic",label:"Logic"}` to: the **skin** options, the **layout** options,
   and `DAW_OPTIONS` (shared by **gestureTable** + **keymap**).
3. `ui/src/settings/layoutPresets.ts` — extend `LayoutPreset` (`right`, `mainView`) +
   `LayoutDeps` (`setMainView`, `applyDock` right) + `applyLayoutArrangement` body;
   add `protools`/`logic` presets; add `right` to mosh/ableton/fl.
4. `ui/src/App.tsx` — pass `setMainView: useStore.getState().setView` into the deps and
   let `applyDock` receive `right`.
5. `ui/src/interaction/gestureTables.ts` — `PROTOOLS` + `LOGIC` tables, register.
6. `ui/src/interaction/keymap.ts` — `PROTOOLS` + `LOGIC` keymaps, register, add to
   `REBINDABLE_ACTIONS` union.
7. `ui/src/ui/mosh.css` — four blocks (`protools` + `protools` light, `logic` +
   `logic` light).
8. `ui/e2e/helpers.ts` — add `protools`/`logic` to the `TEMPLATES` tuple and the
   `TEMPLATE_SKIN` record (`{skin, theme:"dark", label}`).

---

## 9. Tests (TDD — write first where practical)

### vitest (unit)
- `templates.test.ts` — now five templates; each has a distinct skin and a pinned
  layout; PT/Logic values coerce cleanly. Update any count assertion (3 → 5).
- `layoutPresets.test.ts` — **must update** the existing test that asserts `"protools"`
  falls back to mosh (it becomes a real preset now; switch that test to a different
  unknown id, e.g. `"nonesuch"`). Add: PT preset collapses left **and** right and sets
  `mainView:"arrange"`; Logic preset opens left+right and sets `mainView:"arrange"`;
  `applyLayoutArrangement` calls `setMainView` when `mainView` is present and passes
  `right` to `applyDock`.
- `keymap.test.ts` — `getKeymap("protools")` / `getKeymap("logic")` resolve the iconic
  combos and differ from mosh per §5.
- `gestureTables.test.ts` — PT `clip.body` drag → `TIME_SELECT`; Logic `clip.body`
  drag → `MOVE`; both keep edge → `TRIM` and share ruler rules.

### e2e (Playwright — `ui/e2e/templates.spec.ts`)
- The existing `for (const name of TEMPLATES)` loop auto-covers skin/theme/accent/
  picker-state/persistence once `helpers.ts` lists the two new ids — add `protools`/
  `logic` to the `LIME` map (`#34c3a4` / `#4d8df0`).
- Add targeted assertions: switching to Pro Tools **collapses** the right Session rail;
  switching to Logic **opens** it; PT clip-body drag time-selects; Logic clip-body drag
  moves. Add a per-skin screenshot for each (matching the walkthrough convention).

---

## 10. Verification gate

- `cd ui && npx tsc --noEmit` clean (src + e2e).
- `cd ui && npm test` (vitest) green, including the new/updated cases.
- `cd ui && npm run test:e2e` green (per-template loop + new PT/Logic assertions).
- Per the swappability prime directive, this is **UI-only** — the C++ backend must be
  byte-identical (no `src/**` C++ touched). Confirm `git status` shows only
  `ui/**` + `docs/**`.

---

## 11. Out of scope (explicitly deferred)

- A true PT **Edit/Mix dual-window** mode and a true Logic **dedicated left Inspector
  zone** (new dock-engine machinery) — the user chose parity + existing affordances.
- A dedicated "toggle Edit/Mix" **keymap action** (would require a new global
  `EditorAction` — beyond parity). `mainView:"arrange"` on switch is the parity-safe
  use of the existing toggle. Trivial to add later if wanted.
