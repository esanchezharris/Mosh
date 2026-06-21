# UI redesign — sub-phase 1: shell skeleton (Inspector right rail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible, resizable **Inspector right rail** to the arrange-view dock shell (mirroring the existing left browser rail), gated behind a default-off `redesignShell` flag so nothing in the current UI changes until we flip it.

**Architecture:** The dock is three layers: a pure geometry engine (`dockLayout.ts`, already generic over zones), a persisted Zustand store (`useDockLayout.ts`, currently holds `left` + `bottom` zones), and the `DockShell` component that renders them. We add a `right` zone to the store and a right-rail render path to `DockShell`, surfaced only when `App` passes a `right` child — which it does only when the `redesignShell` setting is on. Pure view-state, zero backend.

**Tech Stack:** React 18 + TypeScript, Zustand, Vite. Tests: vitest (jsdom) for pure logic, Playwright for DOM behavior.

## Global Constraints

- **Zero C++ / swappable seam:** no backend command, no `bridge` change. After this sub-phase, rebuilding the bundle must leave the `Mosh` backend binary byte-identical.
- **UI-local view state only:** zone sizes/collapsed live in `localStorage` (`mosh.dockLayout`), never cross the seam.
- **Flag default OFF:** `redesignShell` defaults to `false`; every existing vitest + Playwright test must stay green unchanged.
- **Follow existing patterns:** the pure engine in `ui/src/ui/dock/dockLayout.ts` (`resizeZone`/`toggleZone`), the store shape in `ui/src/ui/dock/useDockLayout.ts`, the settings schema in `ui/src/settings/schema.ts`, and the e2e helpers in `ui/e2e/helpers.ts`.
- All commands run from the `ui/` directory.

## File Structure

- `ui/src/ui/dock/useDockLayout.ts` (modify) — add the `right` zone: default, parse/persist, `resizeRight`/`toggleRight`. Extract a pure `parseDock(raw)` for testability.
- `ui/src/ui/dock/useDockLayout.test.ts` (create) — unit-test `parseDock` (defaults / reads / old-shape migration).
- `ui/src/ui/dock/DockShell.tsx` (modify) — accept a `right?: ReactNode` prop; render the right rail; generalize the divider drag tracker to left/right/bottom.
- `ui/src/ui/Inspector.tsx` (create) — minimal placeholder panel (full mixer/params come in sub-phase 2–3).
- `ui/src/settings/schema.ts` (modify) — add the `redesignShell` bool setting (category "Layout", default false).
- `ui/src/App.tsx` (modify) — read the flag; pass `right={<Inspector/>}` and a `data-redesign` attribute when on.
- `ui/src/ui/mosh.css` (modify) — `.dock-right`, `.dock-right-rail`, and a modest gutter under `data-redesign`.
- `ui/e2e/redesign-shell.spec.ts` (create) — flag-on shows/expands the rail; flag-off shows nothing.

---

### Task 1: Add the `right` (Inspector) zone to the dock store

**Files:**
- Modify: `ui/src/ui/dock/useDockLayout.ts`
- Test: `ui/src/ui/dock/useDockLayout.test.ts` (create)

**Interfaces:**
- Consumes: `Zone`, `resizeZone`, `toggleZone` from `./dockLayout` (unchanged).
- Produces: `parseDock(raw: unknown): { bottom: Zone; left: Zone; right: Zone }`; the store now exposes `right: Zone`, `resizeRight(deltaPx: number): void`, `toggleRight(): void` alongside the existing `bottom`/`left` members.

- [ ] **Step 1: Write the failing test**

Create `ui/src/ui/dock/useDockLayout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDock } from "./useDockLayout";

describe("parseDock", () => {
  it("defaults all three zones when storage is null", () => {
    const d = parseDock(null);
    expect(d.right).toMatchObject({ id: "inspector", collapsed: true });
    expect(d.left.id).toBe("browser");
    expect(d.bottom.id).toBe("detail");
  });
  it("reads a stored, pinned-open right zone", () => {
    const d = parseDock({ bottom: { size: 200 }, left: { size: 240 }, right: { size: 320, collapsed: false } });
    expect(d.right.size).toBe(320);
    expect(d.right.collapsed).toBe(false);
  });
  it("migrates the old { bottom, left } shape by defaulting right to collapsed", () => {
    const d = parseDock({ bottom: { size: 200 }, left: { size: 240, collapsed: true } });
    expect(d.right).toMatchObject({ id: "inspector", collapsed: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dock/useDockLayout.test.ts`
Expected: FAIL — `parseDock` is not exported from `./useDockLayout`.

- [ ] **Step 3: Write the implementation**

Edit `ui/src/ui/dock/useDockLayout.ts`. Add the default after `DEFAULT_LEFT`:

```ts
// The Inspector (right) rail mirrors the browser: opt-in, collapsed to an edge tab
// by default so it never disrupts the existing layout; pin it open and width persists.
const DEFAULT_RIGHT: Zone = { id: "inspector", size: 280, min: 200, max: 460, collapsed: true, prevSize: 280 };
```

Replace `load()` with a pure `parseDock` + a thin `load`:

```ts
export function parseDock(raw: unknown): { bottom: Zone; left: Zone; right: Zone } {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if ("bottom" in r || "left" in r || "right" in r)
      return { bottom: readZone(r.bottom, DEFAULT_BOTTOM), left: readZone(r.left, DEFAULT_LEFT), right: readZone(r.right, DEFAULT_RIGHT) };
    // old bottom-only shape { size,… }
    return { bottom: readZone(raw, DEFAULT_BOTTOM), left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
  }
  return { bottom: DEFAULT_BOTTOM, left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
}
function load(): { bottom: Zone; left: Zone; right: Zone } {
  try { return parseDock(JSON.parse(localStorage.getItem(KEY) || "null")); }
  catch { return { bottom: DEFAULT_BOTTOM, left: DEFAULT_LEFT, right: DEFAULT_RIGHT }; }
}
```

Update `save` to include `right`:

```ts
function save(s: { bottom: Zone; left: Zone; right: Zone }): void {
  try { localStorage.setItem(KEY, JSON.stringify({ bottom: pack(s.bottom), left: pack(s.left), right: pack(s.right) })); } catch { /* noop */ }
}
```

Extend the store interface and creator:

```ts
interface DockLayoutState {
  bottom: Zone;
  left: Zone;
  right: Zone;
  resizeBottom: (deltaPx: number) => void;
  toggleBottom: () => void;
  resizeLeft: (deltaPx: number) => void;
  toggleLeft: () => void;
  resizeRight: (deltaPx: number) => void;
  toggleRight: () => void;
}

export const useDockLayout = create<DockLayoutState>((set, get) => {
  const persist = () => save({ bottom: get().bottom, left: get().left, right: get().right });
  return {
    ...load(),
    resizeBottom: (deltaPx) => { set({ bottom: resizeZone(get().bottom, deltaPx) }); persist(); },
    toggleBottom: () => { set({ bottom: toggleZone(get().bottom, 0) }); persist(); },
    resizeLeft: (deltaPx) => { set({ left: resizeZone(get().left, deltaPx) }); persist(); },
    toggleLeft: () => { set({ left: toggleZone(get().left, 0) }); persist(); },
    resizeRight: (deltaPx) => { set({ right: resizeZone(get().right, deltaPx) }); persist(); },
    toggleRight: () => { set({ right: toggleZone(get().right, 0) }); persist(); },
  };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dock/useDockLayout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: tsc clean; all vitest green (424+ now incl. the 3 new).

- [ ] **Step 6: Commit**

```bash
git add ui/src/ui/dock/useDockLayout.ts ui/src/ui/dock/useDockLayout.test.ts
git commit -m "feat(ui): add Inspector right zone to the dock store"
```

---

### Task 2: Render the Inspector right rail, gated by the `redesignShell` flag

**Files:**
- Modify: `ui/src/ui/dock/DockShell.tsx`, `ui/src/settings/schema.ts`, `ui/src/App.tsx`, `ui/src/ui/mosh.css`
- Create: `ui/src/ui/Inspector.tsx`
- Test: `ui/e2e/redesign-shell.spec.ts` (create)

**Interfaces:**
- Consumes: `right`/`resizeRight`/`toggleRight` from Task 1's store; `useSettings` (`ui/src/settings/store.ts`) for the flag.
- Produces: `DockShell` now accepts `right?: ReactNode`; `Inspector` component (`{ snapshot }` props); testids `inspector-expand` (collapsed tab), `dock-right` (expanded panel).

- [ ] **Step 1: Write the failing e2e test**

Create `ui/e2e/redesign-shell.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

async function bootRedesign(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 1, template: null, values: { redesignShell: true } }));
  });
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("arrangement")).toBeVisible();
}

test("flag on: Inspector right rail starts collapsed and expands on click", async ({ page }) => {
  await bootRedesign(page);
  const tab = page.getByTestId("inspector-expand");
  await expect(tab).toBeVisible();
  await expect(page.getByTestId("dock-right")).toHaveCount(0);
  await tab.click();
  await expect(page.getByTestId("dock-right")).toBeVisible();
});

test("flag off (default): no Inspector rail", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("inspector-expand")).toHaveCount(0);
});
```

- [ ] **Step 2: Run e2e to verify it fails**

Run: `npm run test:e2e -- redesign-shell`
Expected: FAIL — `inspector-expand` never appears (no flag, no rail yet).

- [ ] **Step 3: Add the `redesignShell` setting**

In `ui/src/settings/schema.ts`, add this descriptor to the `SETTINGS` array immediately after the `layout` descriptor (before `...interactionSettings()`):

```ts
  {
    id: "redesignShell",
    type: "bool",
    default: false,
    scope: "app",
    category: "Layout",
    label: "Redesign shell (preview)",
    help: "Opt into the agent-first shell: an Inspector right rail + side gutters. Off by default while it's built out.",
  },
```

- [ ] **Step 4: Create the Inspector placeholder**

Create `ui/src/ui/Inspector.tsx`:

```tsx
// Inspector right-rail (sub-phase 1 placeholder). Full volume/pan/sends + selected-item
// params land in sub-phase 2–3; for the skeleton this just establishes the rail surface.
import type { Snapshot } from "../types";
import { useStore } from "../store";

export function Inspector({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const track = snapshot.tracks.find((t) => t.id === selectedTrackId);
  return (
    <div className="inspector" data-testid="inspector">
      <div className="inspector-head">Inspector</div>
      <div className="inspector-body">
        {track ? track.name : "Select a track to see its controls."}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Render the right rail in `DockShell`**

Edit `ui/src/ui/dock/DockShell.tsx`. Update the signature and pull the right-zone state/actions:

```tsx
export function DockShell({ left, children, right, bottom }: { left: ReactNode; children: ReactNode; right?: ReactNode; bottom: ReactNode }) {
  const bottomZone = useDockLayout((s) => s.bottom);
  const leftZone = useDockLayout((s) => s.left);
  const rightZone = useDockLayout((s) => s.right);
  const resizeBottom = useDockLayout((s) => s.resizeBottom);
  const toggleBottom = useDockLayout((s) => s.toggleBottom);
  const resizeLeft = useDockLayout((s) => s.resizeLeft);
  const toggleLeft = useDockLayout((s) => s.toggleLeft);
  const resizeRight = useDockLayout((s) => s.resizeRight);
  const toggleRight = useDockLayout((s) => s.toggleRight);
```

Replace the drag tracker (the `last`/`begin`/`drag`/`end` block) with a 3-way version:

```tsx
  // One drag tracker reused by the three dividers (only one drags at a time).
  const last = useRef<{ kind: "left" | "right" | "bottom"; v: number } | null>(null);
  const begin = (kind: "left" | "right" | "bottom") => (e: React.PointerEvent) => {
    last.current = { kind, v: kind === "bottom" ? e.clientY : e.clientX };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const drag = (e: React.PointerEvent) => {
    if (!last.current) return;
    if (last.current.kind === "bottom") {
      const dy = e.clientY - last.current.v; last.current.v = e.clientY;
      if (dy !== 0) resizeBottom(-dy);              // drag UP → grow the bottom dock
    } else {
      const dx = e.clientX - last.current.v; last.current.v = e.clientX;
      if (dx === 0) return;
      if (last.current.kind === "left") resizeLeft(dx);   // drag RIGHT → grow the browser
      else resizeRight(-dx);                              // drag LEFT → grow the Inspector
    }
  };
  const end = (e: React.PointerEvent) => {
    last.current = null;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };
```

Update the two existing `begin("x")`/`begin("y")` call sites to `begin("left")` / `begin("bottom")`. Then, inside `.dock-main`, after `{children}`, add the right rail:

```tsx
        {children}
        {right && (rightZone.collapsed ? (
          <button className="dock-right-rail" data-testid="inspector-expand" onClick={toggleRight}
            title="Show the inspector">◂</button>
        ) : (
          <>
            <div className="dock-vdivider" data-testid="dock-rdivider" role="separator" aria-orientation="vertical"
              aria-label="Resize the inspector" title="Drag to resize · double-click to collapse"
              onPointerDown={begin("right")} onPointerMove={drag} onPointerUp={end} onDoubleClick={toggleRight} />
            <div className="dock-right" data-testid="dock-right" style={{ width: rightZone.size }}>{right}</div>
          </>
        ))}
```

- [ ] **Step 6: Add the CSS**

In `ui/src/ui/mosh.css`, after the `.dock-left-rail:hover` rule (~line 446) add:

```css
.dock-right { flex: 0 0 auto; min-width: 0; overflow: auto; border-left: 1px solid var(--ink-line); background: var(--ink-raise); }
.dock-right-rail { flex: 0 0 18px; width: 18px; border: none; border-left: 1px solid var(--ink-line); background: var(--ink-raise); color: var(--bone-dim); cursor: pointer; font: inherit; font-size: 11px; padding: 0; }
.dock-right-rail:hover { color: var(--lime); }
.inspector { padding: 10px 12px; color: var(--bone-dim); font-size: 12px; }
.inspector-head { color: var(--lime); letter-spacing: 0.08em; text-transform: uppercase; font-size: 11px; margin-bottom: 8px; }
.app[data-redesign="on"] .dock-main { padding: 0 8px; }
```

- [ ] **Step 7: Wire the flag in `App.tsx`**

In `ui/src/App.tsx`, add the import and read the flag:

```tsx
import { Inspector } from "./ui/Inspector";
```

```tsx
  const redesign = useSettings((s) => Boolean(s.values.redesignShell));
```

Set the attribute on the root and pass `right` to `DockShell`:

```tsx
    <div className="app" data-testid="app" data-redesign={redesign ? "on" : undefined}>
```

```tsx
          <DockShell left={<SampleBrowser />} right={redesign ? <Inspector snapshot={snapshot} /> : undefined} bottom={<Dock snapshot={snapshot} />}>
            <Arrange snapshot={snapshot} />
          </DockShell>
```

- [ ] **Step 8: Run the new e2e to verify it passes; confirm no regressions**

Run: `npm run test:e2e -- redesign-shell`
Expected: PASS (2 tests).

Run: `npm run test:e2e`
Expected: ALL existing specs still green (flag off → unchanged DOM).

- [ ] **Step 9: Typecheck + unit suite + swappability**

Run: `npm run typecheck && npx vitest run`
Expected: clean + green.
Swappability note: this sub-phase touches only `ui/` + CSS — confirm `git status` shows no `src/` (C++) changes before committing.

- [ ] **Step 10: Commit**

```bash
git add ui/src/ui/dock/DockShell.tsx ui/src/ui/Inspector.tsx ui/src/settings/schema.ts ui/src/App.tsx ui/src/ui/mosh.css ui/e2e/redesign-shell.spec.ts
git commit -m "feat(ui): Inspector right rail behind the redesignShell flag"
```

---

## Self-Review

- **Spec coverage (sub-phase 1 = "shell skeleton: zones + right rail + gutters + collapse, behind a flag"):** right zone (Task 1) ✓, right-rail render + collapse/resize (Task 2 steps 5) ✓, gutters (Task 2 step 6, `data-redesign` padding) ✓, flag (Task 2 steps 3/7) ✓, per-skin e2e (Task 2 step 1; runs under the default Mosh skin — extend to other skins in sub-phase 4 visual pass) ✓.
- **Placeholder scan:** none — every step carries real code/commands.
- **Type consistency:** `parseDock` return type, `resizeRight`/`toggleRight`, the `right?: ReactNode` prop, and the `inspector-expand`/`dock-right` testids match across Tasks 1–2 and the e2e.
- **Deferred (correct for this sub-phase):** the Inspector's real contents (mixer/params), Moshi relocation, per-track FX drawer, sections — all later sub-phases per the design spec.
