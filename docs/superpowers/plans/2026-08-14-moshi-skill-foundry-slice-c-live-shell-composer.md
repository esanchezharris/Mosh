# Moshi Skill Foundry Slice C: Live-Shell Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Live shell's Moshi stub with the shared composer, task drawer, and change toast while matching Pro Tools for input, choices, focus, Escape, project replacement, and packaged refusal.

**Architecture:** Add one Live-only presentation adapter around `AgentComposer`, `AgentDrawer`, and `ChangeToast`. `AppLive` owns one trigger ref and threads it through the control bar and detail dock. The shared composer exposes semantic outcome metadata for tests, and a typed Playwright bridge owns all mock-store access; Live adds no runtime, router, command, or reset path.

**Tech Stack:** TypeScript 5, React 18, Zustand, Vitest/jsdom, Playwright/Chromium, Vite single-file e2e builds, existing Mosh bridge mocks.

**Spec:** `docs/superpowers/specs/2026-08-14-moshi-skill-foundry-design.md`

## Global Constraints

- Start after Slices B and D land on `main`; use branch/worktree `codex/moshi-skill-foundry-c`. Preserve D's exact `"teach-moshi": "tsx src/skillFoundry/cli.ts"` package script.
- Consume exactly `runStudioSkill(utterance: string, environment: StudioSkillEnvironment, continuationToken?: string): Promise<SkillOutcomeV1>` through `AgentComposer`.
- `AgentComposer` alone owns `useRef<string | null>` and receives `needs_choice.continuationToken`. Live must not import the registry, Foundry runtime, continuation store, native handler, or `runStudioSkill`.
- Render the existing `AgentComposer`, `AgentDrawer`, and `ChangeToast`; do not fork markup, speech, mutation, undo, task, or choice logic.
- Live owns only layout, open/close, focus entry, Escape registration, and trigger-focus restoration.
- Keep the drawer nonmodal (`role="complementary"`, no `aria-modal`, no focus trap), collapsed by default, and controlled by `useLive().moshiOpen`.
- Do not close/reset the drawer on project replacement. Shared runtime validation must reject the opaque stale token against current `projectEpoch`, with zero `load_plugin` mutation.
- Preserve DetailDock priority and behavior: Moshi, MIDI/audio editor, Devices, splitter sizing, one Close action. MIDI double-click still replaces Devices; track-name click still restores Devices.
- Every Moshi-drawer mutation remains `AgentComposer` -> shared runtime -> MoshOps. The new drawer and its `DetailDock` integration may not call `store.exec`; existing non-Moshi Live controls remain outside this slice.
- Typed text and final speech use the same shared `run()` path; add no Live voice controller.
- Test outcomes by stable `data-outcome-kind`/`data-outcome-code`, not localized `say` prose. User-visible copy remains asserted only for presence/accessibility.
- The developer free-form loop stays available only under its existing compile-time flag. A built e2e bundle with that flag `0` must refuse unsupported free-form work without `/api/brain/chat`, a task drawer, or snapshot mutation.
- Call the built-browser check a packaged-posture surrogate, not native/WKWebView proof. Run and report the native gate separately.
- Add no dependencies, snapshot/event fields, settings, teaching recorder, Ableton path, runtime web access, or source ingestion.
- Before each test/build/gate command run `scripts/auto-loop/memory-preflight.sh`; stop on failure. Never touch owner projects or Ableton.
- Preserve unrelated changes, stage only listed files, scan staged diffs, open a PR, and never merge.

## File Map

- Create `ui/src/live/LiveMoshiDrawer.tsx` and `ui/src/live/LiveMoshiDrawer.test.tsx`: adapter and parity proof.
- Modify `ui/src/ui/AgentComposer.tsx` and `ui/src/ui/AgentComposer.skillFoundry.test.tsx`: semantic outcome metadata.
- Modify `ui/src/live/AppLive.tsx`, `ui/src/live/ControlBar.tsx`, `ui/src/live/ControlBar.protoolsSwitch.test.ts`, and `ui/src/live/DetailDock.tsx`: trigger ref and stub replacement.
- Modify `ui/src/live/live.css`: Live-scoped shared-surface skin.
- Create `ui/e2e/agent-test-bridge.ts`; modify `ui/e2e/live-shell.spec.ts`: typed mock access and real-shell proofs.
- Modify `ui/package.json`: focused loop-disabled e2e build without losing D's script.
- Read only: Pro Tools drawer/tests and Slice B runtime/registry/continuation files.

### Task 1: Add the Thin Live Adapter

**Files:**
- Create: `ui/src/live/LiveMoshiDrawer.tsx`, `ui/src/live/LiveMoshiDrawer.test.tsx`
- Modify: `ui/src/ui/AgentComposer.tsx`, `ui/src/ui/AgentComposer.skillFoundry.test.tsx`; test `ui/src/protools/ProToolsMoshiDrawer.test.ts`

**Interfaces:**
- Produce `LiveMoshiDrawer({ open, onClose, returnFocusRef }: { open: boolean; onClose: () => void; returnFocusRef: RefObject<HTMLButtonElement> }): JSX.Element | null`.
- Produce `[data-testid="agent-outcome"][data-outcome-kind][data-outcome-code]`: completed/choice use kind as code; blocked/unsupported use `SkillOutcomeV1.code`. Consume shared surfaces/`pushEscapeHandler`; expose no runtime props.

- [ ] **Step 1 (2 min): lock the merged Slice B seam.**

```bash
rg -n 'useRef<string \| null>|continuationToken|runStudioSkill\(' \
  ui/src/ui/AgentComposer.tsx ui/src/agent/studioSkills.ts \
  ui/src/agent/skillFoundry/runtime.ts
```
Expected: composer owns the string ref; `runStudioSkill` accepts the optional token. Stop if not—do not add compatibility code in Live.

- [ ] **Step 2 (5 min): write RED component contracts.**

Create `LiveMoshiDrawer.test.tsx` with the React-root/store reset pattern from `ProToolsMoshiDrawer.test.ts`. Use this real harness:

```tsx
function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return <><button ref={triggerRef} data-testid="test-live-moshi-trigger"
    onClick={() => setOpen(value => !value)}>Ask Moshi</button>
    <LiveMoshiDrawer open={open} onClose={() => setOpen(false)} returnFocusRef={triggerRef} /></>;
}
```

Seed a MIDI track `{ id: "synth", name: "Synth" }`, `projectEpoch: 7`, and an `exec` mock returning two `Serum 2` entries for `list_plugins` and `{ ok: true, command }` otherwise. Retain real composer/runtime; mock `createVoiceInput` only, capturing `callbacks.onFinal`.

Add these exact assertions across three tests:

```tsx
const drawer = await openDrawer();
expect(drawer.getAttribute("role")).toBe("complementary"); expect(drawer.hasAttribute("aria-modal")).toBe(false);
expect(drawer.querySelector("[data-testid=agent-stop]")).not.toBeNull(); expect(drawer.querySelector("[data-testid=v2-toast-undo]")).not.toBeNull();
expect(document.activeElement).toBe(drawer.querySelector("[data-testid=agent-input]"));
await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
expect(host.querySelector("[data-testid=live-moshi-drawer]")).toBeNull();
expect(document.activeElement).toBe(host.querySelector("[data-testid=test-live-moshi-trigger]"));
```

```tsx
await submit(drawer, "mute Synth"); expect(exec).toHaveBeenCalledWith("set_track_mute", { trackId: "synth", mute: true });
expect(drawer.querySelector("[data-testid=agent-outcome]"))
  .toHaveAttribute("data-outcome-kind", "completed");
exec.mockClear(); act(() => voiceCallbacks.onFinal?.("unmute Synth"));
await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("set_track_mute",
  { trackId: "synth", mute: false }));
```

```tsx
await submit(drawer, "load Serum 2"); expect(drawer.querySelector("[data-testid=agent-outcome]"))
  .toHaveAttribute("data-outcome-kind", "needs_choice");
act(() => useStore.setState({ projectEpoch: 8 })); await submit(drawer, "2");
const outcome = drawer.querySelector("[data-testid=agent-outcome]");
expect(outcome).toHaveAttribute("data-outcome-kind", "blocked");
expect(outcome).toHaveAttribute("data-outcome-code", "stale_context");
expect(outcome?.textContent?.trim().length).toBeGreaterThan(0);
expect(exec.mock.calls.some(([command]) => command === "load_plugin")).toBe(false);
```

Reset task store, app store, voice callback, root, and host after every test.

- [ ] **Step 3 (2 min): run RED.**

```bash
scripts/auto-loop/memory-preflight.sh
(cd ui && npx vitest run src/live/LiveMoshiDrawer.test.tsx \
  src/ui/AgentComposer.skillFoundry.test.tsx \
  src/protools/ProToolsMoshiDrawer.test.ts)
```
Expected RED: `./LiveMoshiDrawer` cannot resolve and shared outcome attributes are absent; Pro Tools reference remains green.

- [ ] **Step 4 (5 min): expose stable shared outcome semantics.**

In `AgentComposer.tsx`, add and clear metadata at the start of every `run`, then set it immediately after `runStudioSkill` returns:

```tsx
type AgentOutcomeMeta = {
  readonly kind: "completed" | "needs_choice" | "blocked" | "unsupported";
  readonly code: string;
};
const [outcomeMeta, setOutcomeMeta] = useState<AgentOutcomeMeta | null>(null);
setOutcomeMeta(null); // first statement inside run(), before routing
// immediately after await runStudioSkill(...):
setOutcomeMeta({ kind: skill.kind, code: skill.kind === "blocked" ||
  skill.kind === "unsupported" ? skill.code : skill.kind });
```

Render semantic metadata on the existing live region without changing copy:

```tsx
{say && <div className="agent-say" role="status" aria-live="polite"
  data-testid={outcomeMeta ? "agent-outcome" : undefined}
  data-outcome-kind={outcomeMeta?.kind}
  data-outcome-code={outcomeMeta?.code}>{say}</div>}
```

Add `AgentComposer.skillFoundry.test.tsx` assertions for `needs_choice`, `blocked/stale_context`, and `unsupported/unsupported_intent`; assert only that visible status text is nonempty.

- [ ] **Step 5 (5 min): implement the adapter.**

```tsx
import { useEffect, useRef, type RefObject } from "react";
import { useTaskStore } from "../agent/loop/taskStore"; import { pushEscapeHandler } from "../hooks/escapeStack";
import { AgentComposer } from "../ui/AgentComposer"; import { IconClose } from "../ui/icons";
import { AgentDrawer } from "../v2/agent/AgentDrawer"; import { ChangeToast } from "../v2/ChangeToast";

export type LiveMoshiDrawerProps = {
  readonly open: boolean; readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement>;
};

export function LiveMoshiDrawer({ open, onClose, returnFocusRef }: LiveMoshiDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const hasTask = useTaskStore(s => s.current !== null || s.last !== null);
  const setTaskDrawerOpen = useTaskStore(s => s.setDrawerOpen);
  useEffect(() => open ? pushEscapeHandler(onClose) : undefined, [onClose, open]);
  useEffect(() => { if (open && hasTask) setTaskDrawerOpen(true); }, [hasTask, open, setTaskDrawerOpen]);
  useEffect(() => {
    if (!open) return undefined;
    const trigger = returnFocusRef.current;
    drawerRef.current?.querySelector<HTMLInputElement>("[data-testid=agent-input]")?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, [open, returnFocusRef]);
  if (!open) return null;
  return <div ref={drawerRef} id="live-moshi-drawer" className="live-moshi-drawer"
    data-testid="live-moshi-drawer" role="complementary" aria-label="Ask Moshi">
    <div className="live-dock-head live-moshi-head"><span className="live-dock-title">Ask Moshi</span>
      <button type="button" className="live-dock-close" data-testid="live-moshi-close"
        aria-label="Close the Moshi drawer" onClick={onClose}><IconClose size={12} /></button>
    </div>
    <div className="live-moshi-body"><AgentDrawer /><ChangeToast /><AgentComposer /></div>
  </div>;
}
```

- [ ] **Step 6 (3 min): run GREEN and commit.**

```bash
scripts/auto-loop/memory-preflight.sh
(cd ui && npx vitest run src/live/LiveMoshiDrawer.test.tsx \
  src/ui/AgentComposer.skillFoundry.test.tsx \
  src/protools/ProToolsMoshiDrawer.test.ts && npm run typecheck)
git add ui/src/live/LiveMoshiDrawer.tsx ui/src/live/LiveMoshiDrawer.test.tsx \
  ui/src/ui/AgentComposer.tsx ui/src/ui/AgentComposer.skillFoundry.test.tsx
git diff --cached --check
git commit -m "feat(live): add shared Moshi drawer adapter"
```
Expected: all tests/typecheck pass; staged diff contains only the four Task 1 files.

### Task 2: Mount and Skin the Shared Surface

**Files:**
- Modify: `ui/src/live/AppLive.tsx`, `ui/src/live/ControlBar.tsx`, `ui/src/live/ControlBar.protoolsSwitch.test.ts`, `ui/src/live/DetailDock.tsx`, `ui/src/live/live.css`; create `ui/e2e/agent-test-bridge.ts`; modify `ui/e2e/live-shell.spec.ts`.

**Interfaces:** Thread one `RefObject<HTMLButtonElement>` from `AppLive` into `ControlBar` and `DetailDock`. The e2e spec accesses the mock only through typed `readAgentProbe`, `resetAgentTrace`, `execAgentCommand`, and `installDuplicateSerumCatalog` helpers.

- [ ] **Step 1 (5 min): create the typed Playwright bridge.**

```ts
import type { Page } from "@playwright/test";
import type { CommandResult, Snapshot } from "../src/types";
type TraceEntry = { command: string; args?: Record<string, unknown>; ok?: boolean };
type TestState = { snapshot: Snapshot | null; projectEpoch: number; exec:
  (command: string, args?: Record<string, unknown>) => Promise<CommandResult> };
type TestStore = { getState: () => TestState; setState: (patch: Partial<TestState>) => void };
type TestWindow = Window & { __moshStore?: TestStore; __moshCmdTrace?: TraceEntry[] };
export type AgentProbe = { snapshotJson: string; projectEpoch: number; commands: string[] };

export const readAgentProbe = (page: Page): Promise<AgentProbe> => page.evaluate(() => {
  const target = window as unknown as TestWindow;
  const state = target.__moshStore?.getState();
  if (!state) throw new Error("Mosh e2e store is unavailable");
  return { snapshotJson: JSON.stringify(state.snapshot), projectEpoch: state.projectEpoch,
    commands: (target.__moshCmdTrace ?? []).map(entry => entry.command) };
});
export const resetAgentTrace = (page: Page): Promise<void> => page.evaluate(() =>
  { (window as unknown as TestWindow).__moshCmdTrace = []; });
export const execAgentCommand = (page: Page, command: string, args = {}): Promise<CommandResult> =>
  page.evaluate(async input => {
    const store = (window as unknown as TestWindow).__moshStore;
    if (!store) throw new Error("Mosh e2e store is unavailable");
    return store.getState().exec(input.command, input.args); }, { command, args });
export const installDuplicateSerumCatalog = (page: Page): Promise<void> => page.evaluate(() => {
  const store = (window as unknown as TestWindow).__moshStore;
  if (!store) throw new Error("Mosh e2e store is unavailable");
  const originalExec = store.getState().exec;
  store.setState({ exec: async (command, args = {}) => command === "list_plugins" ?
    { ok: true, command, data: { plugins: [
      { id: "serum-au", name: "Serum 2", format: "AudioUnit", manufacturer: "Xfer", isInstrument: true },
      { id: "serum-vst", name: "Serum 2", format: "VST3", manufacturer: "Xfer", isInstrument: true },
    ] } } : originalExec(command, args) });
});
```

No new test may read or write `__moshStore`/`__moshCmdTrace` directly.

- [ ] **Step 2 (5 min): replace the stub e2e test with RED parity tests.**

In `live-shell.spec.ts`, import the typed seam, open `live-moshi`, then assert:

```ts
import { execAgentCommand, installDuplicateSerumCatalog,
  readAgentProbe, resetAgentTrace } from "./agent-test-bridge";

const trigger = page.getByTestId("live-moshi");
await trigger.click(); const drawer = page.getByTestId("live-moshi-drawer");
await expect(drawer).toHaveAttribute("role", "complementary");
await expect(drawer).not.toHaveAttribute("aria-modal");
await expect(page.getByTestId("agent-input")).toBeFocused(); await page.getByTestId("agent-input").fill("mute Drums");
await page.getByTestId("agent-send").click();
await expect.poll(() => storeVal<boolean>(page, "snapshot.tracks.0.mute")).toBe(true);
await expect(page.getByTestId("v2-change-toast")).toBeVisible(); await page.getByTestId("v2-toast-undo").click();
await expect.poll(() => storeVal<boolean>(page, "snapshot.tracks.0.mute")).toBe(false);
await page.keyboard.press("Escape");
await expect(drawer).toHaveCount(0);
await expect(trigger).toBeFocused();
```

```ts
test("a Live pending choice is rejected after project replacement", async ({ page }) => {
  await bootLive(page); await installDuplicateSerumCatalog(page); await resetAgentTrace(page);
  await page.getByTestId("live-moshi").click(); await page.getByTestId("agent-input").fill("load Serum 2");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-outcome")).toHaveAttribute("data-outcome-kind", "needs_choice");
  const before = await readAgentProbe(page);
  await execAgentCommand(page, "new_project", { name: "choice-stale" });
  await expect.poll(async () => (await readAgentProbe(page)).projectEpoch).toBe(before.projectEpoch + 1);
  await expect(page.getByTestId("live-moshi-drawer")).toBeVisible(); await page.getByTestId("agent-input").fill("2");
  await page.getByTestId("agent-send").click();
  const outcome = page.getByTestId("agent-outcome");
  await expect(outcome).toHaveAttribute("data-outcome-kind", "blocked");
  await expect(outcome).toHaveAttribute("data-outcome-code", "stale_context");
  const after = await readAgentProbe(page);
  expect(after.commands.filter(c => c === "load_plugin").length)
    .toBe(before.commands.filter(c => c === "load_plugin").length);
});
```

- [ ] **Step 3 (3 min): run RED.**

```bash
scripts/auto-loop/memory-preflight.sh
(cd ui && MOSH_E2E_PREVIEW=1 npx playwright test live-shell.spec.ts \
  --grep "Live Moshi drawer|Live pending choice")
```

Expected RED: current `live-moshi-panel` lacks shared controls.

- [ ] **Step 4 (5 min): thread the trigger ref and replace only the stub.**

In `AppLive`:

```tsx
const moshiButtonRef = useRef<HTMLButtonElement>(null);
// existing render positions:
<ControlBar snapshot={snapshot} moshiButtonRef={moshiButtonRef} />
<DetailDock moshiButtonRef={moshiButtonRef} />
```

Require that ref in both child prop types. On the existing ControlBar button:

```tsx
<button ref={moshiButtonRef} data-testid="live-moshi"
  aria-label="Toggle the Moshi drawer" aria-pressed={moshiOpen}
  aria-expanded={moshiOpen} aria-controls="live-moshi-drawer"
  data-on={moshiOpen} onClick={toggleMoshi}>
  <IconSpark size={13} />
</button>
```

Replace only DetailDock's stub fragment:

```tsx
{showMoshi && <LiveMoshiDrawer open={showMoshi}
  onClose={() => setMoshiOpen(false)} returnFocusRef={moshiButtonRef} />}
```

Set the section label to `showMoshi ? "Ask Moshi" : showEditor ? "Clip view" : "Detail view"`. Keep splitter/editor/Devices/`DockClose` code byte-for-byte.

- [ ] **Step 5 (3 min): update fixture and Live-scoped CSS.**

In `ControlBar.protoolsSwitch.test.ts` pass `React.createRef<HTMLButtonElement>()` and assert its current element has `data-testid="live-moshi"`.

Remove `.live-dock-stub-*`; add scoped layout/token rules:

```css
.live-moshi-drawer { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
  --v2-accent: var(--live-accent); --v2-text: var(--live-text); --v2-text-dim: var(--live-text-dim);
  --v2-surface: var(--live-bg); --v2-surface-2: var(--live-bg-raise); --v2-surface-sunken: var(--live-bg-inset); --v2-line: var(--live-line); }
.live-moshi-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 9px 10px; overflow: auto; }
.live-moshi-body .agent-composer { margin-top: auto; }
.live-moshi-body .agent-say, .live-moshi-body .v2-toast { position: static; transform: none; }
.live-moshi-body .v2-agent-drawer { display: flex; flex-direction: column; gap: 7px; padding: 8px; border: 1px solid var(--live-line-strong); background: var(--live-bg-raise); }
.live-moshi-body .v2-toast { display: flex; gap: 7px; padding: 7px 8px; color: var(--live-text); background: var(--live-bg-inset); border: 1px solid var(--live-accent); }
```

- [ ] **Step 6 (5 min): run GREEN and commit.**

```bash
scripts/auto-loop/memory-preflight.sh
(cd ui && npx vitest run src/live/LiveMoshiDrawer.test.tsx \
  src/live/ControlBar.protoolsSwitch.test.ts src/protools/ProToolsMoshiDrawer.test.ts \
  && npm run typecheck)
scripts/auto-loop/memory-preflight.sh
(cd ui && MOSH_E2E_PREVIEW=1 npx playwright test live-shell.spec.ts \
  --grep "Live Moshi drawer|Live pending choice")
git add ui/src/live/AppLive.tsx ui/src/live/ControlBar.tsx \
  ui/src/live/ControlBar.protoolsSwitch.test.ts ui/src/live/DetailDock.tsx \
  ui/src/live/live.css ui/e2e/agent-test-bridge.ts ui/e2e/live-shell.spec.ts
git diff --cached --check
git commit -m "feat(live): mount the shared Moshi composer"
```

Expected: component/type/e2e checks pass; focus, Escape, undo, drawer survival, and stale zero-mutation are proven.

### Task 3: Prove the Built-Bundle Refusal Boundary

**Files:** Modify `ui/package.json`, `ui/e2e/live-shell.spec.ts`; consume `ui/e2e/agent-test-bridge.ts`.

**Interfaces:** Preserve D's `teach-moshi` and loop-enabled default e2e. Produce `npm run test:e2e:built-refusal`, which builds e2e mocks with `VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP=0`.

- [ ] **Step 1 (5 min): add the adaptive boundary test.**

```ts
test("the Live composer honors the compile-time free-form boundary", async ({ page }) => {
  const refusal = process.env.MOSH_E2E_PACKAGED_REFUSAL === "1";
  const brain: string[] = [];
  page.on("request", r => { if (new URL(r.url()).pathname === "/api/brain/chat") brain.push(r.url()); });
  await bootLive(page); await page.getByTestId("live-moshi").click(); await resetAgentTrace(page);
  const before = await readAgentProbe(page);
  await page.getByTestId("agent-input").fill("give the whole thing a better vibe"); await page.getByTestId("agent-send").click();
  if (!refusal) {
    await expect(page.getByTestId("agent-drawer")).toContainText("needs you"); await expect.poll(() => brain.length).toBeGreaterThan(0); return;
  }
  const outcome = page.getByTestId("agent-outcome");
  await expect(outcome).toHaveAttribute("data-outcome-kind", "unsupported"); await expect(outcome).toHaveAttribute("data-outcome-code", "unsupported_intent");
  await expect(outcome).not.toHaveText(""); await expect(page.getByTestId("agent-drawer")).toHaveCount(0); expect(brain).toEqual([]);
  const after = await readAgentProbe(page);
  expect(after.snapshotJson).toBe(before.snapshotJson); expect(after.commands).toEqual(["batch_begin", "batch_end"]);
});
```

- [ ] **Step 2 (3 min): capture RED with the intended override.**

```bash
scripts/auto-loop/memory-preflight.sh
(cd ui && MOSH_E2E_PREVIEW=1 MOSH_E2E_PACKAGED_REFUSAL=1 \
  VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP=0 npx playwright test \
  live-shell.spec.ts --grep "compile-time free-form boundary")
```

Expected RED: current `build:e2e` overwrites `0` with `1`; task drawer opens.

- [ ] **Step 3 (2 min): make the build flag overridable.**

Replace/add these `ui/package.json` scripts exactly:

```json
"teach-moshi": "tsx src/skillFoundry/cli.ts",
"build:e2e": "tsc --noEmit && VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP=${VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP:-1} vite build --mode e2e",
"test:e2e:built-refusal": "npm run typecheck && MOSH_E2E_PREVIEW=1 MOSH_E2E_PACKAGED_REFUSAL=1 VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP=0 playwright test live-shell.spec.ts --grep \"compile-time free-form boundary\""
```
Do not alter Playwright, Vite, or bridge configs; existing e2e mode already supplies the mock bridge and `dist-e2e/index.html` single-file build.

- [ ] **Step 4 (5 min): run both sides GREEN and commit.**

```bash
scripts/auto-loop/memory-preflight.sh
(cd ui && MOSH_E2E_PREVIEW=1 npx playwright test live-shell.spec.ts \
  --grep "compile-time free-form boundary")
scripts/auto-loop/memory-preflight.sh
(cd ui && npm run test:e2e:built-refusal)
node -e 'const p=require("./ui/package.json"); if(p.scripts["teach-moshi"]!=="tsx src/skillFoundry/cli.ts") process.exit(1)'
git add ui/package.json ui/e2e/live-shell.spec.ts
git diff --cached --check
git commit -m "test(agent): prove built Live refusal posture"
```

Expected: default opens the dev task path; override exposes `unsupported/unsupported_intent`, sends no brain request, opens no drawer, preserves snapshot, and records only the empty provenance batch. `teach-moshi` remains byte-exact.

### Task 4: Run the Slice Gate and Open the PR

**Files:** Verify every File Map entry at committed `HEAD`; do not modify shared/Pro Tools runtime files.

**Interfaces:** Produce evidence for one clean exact commit. If any audit/gate causes a correction, run its focused test, commit the correction, and restart Task 4 at Step 1; never continue a final gate with dirty or uncommitted fixes.

- [ ] **Step 1 (3 min): lock a clean committed HEAD and audit scope.**

```bash
test -z "$(git status --porcelain)"; verified_head=$(git rev-parse HEAD)
git diff --check origin/main...HEAD; git diff --name-only origin/main...HEAD
if rg -n 'runStudioSkill|StudioSkillRegistry|execute_command|store\.exec|continuationToken' \
  ui/src/live/LiveMoshiDrawer.tsx ui/src/live/DetailDock.tsx; then exit 1; fi
test "$(rg -c 'runStudioSkill\(' ui/src/ui/AgentComposer.tsx)" -eq 1
node -e 'const p=require("./ui/package.json"); if(p.scripts["teach-moshi"]!=="tsx src/skillFoundry/cli.ts") process.exit(1)'
test "$(git rev-parse HEAD)" = "$verified_head"; test -z "$(git status --porcelain)"
```

Expected: only File Map paths changed; new Live drawer/DetailDock contain no execution seam, shared composer retains its single call, D's CLI script is unchanged, and HEAD/worktree stay exact and clean.

- [ ] **Step 2 (5 min): run focused and full UI gates.**

```bash
verified_head=$(git rev-parse HEAD); test -z "$(git status --porcelain)"
scripts/auto-loop/memory-preflight.sh
(cd ui && npx vitest run src/live/LiveMoshiDrawer.test.tsx \
  src/live/ControlBar.protoolsSwitch.test.ts src/protools/ProToolsMoshiDrawer.test.ts \
  src/ui/AgentComposer.skillFoundry.test.tsx \
  src/ui/AgentComposer.namedPlugin.test.ts src/v2/agent/AgentDrawer.test.ts)
scripts/auto-loop/memory-preflight.sh
(cd ui && npm run typecheck && npm test)
test "$(git rev-parse HEAD)" = "$verified_head"; test -z "$(git status --porcelain)"
```

Expected: zero failures; record exact file/test counts.

- [ ] **Step 3 (5 min): run both fresh-build browser postures.**

```bash
verified_head=$(git rev-parse HEAD); test -z "$(git status --porcelain)"
scripts/auto-loop/memory-preflight.sh
(cd ui && MOSH_E2E_PREVIEW=1 npx playwright test live-shell.spec.ts \
  --grep "Live Moshi drawer|Live pending choice|compile-time free-form boundary")
scripts/auto-loop/memory-preflight.sh
(cd ui && npm run test:e2e:built-refusal)
test "$(git rev-parse HEAD)" = "$verified_head"; test -z "$(git status --porcelain)"
```

Expected: normal build proves shared UI/stale handling; loop-disabled build proves refusal.

- [ ] **Step 4 (5 min): run production and native gates.**

```bash
verified_head=$(git rev-parse HEAD); test -z "$(git status --porcelain)"
scripts/auto-loop/memory-preflight.sh
(cd ui && npm run build)
scripts/auto-loop/memory-preflight.sh
scripts/auto-loop/gate.sh native "$PWD" origin/main
test "$(git rev-parse HEAD)" = "$verified_head"; test -z "$(git status --porcelain)"
```

Expected: production build passes; native gate has zero failures/JUCE assertions. Report native evidence separately from browser evidence.

- [ ] **Step 5 (3 min): review, push, and stop before merge.**

```bash
test -z "$(git status --porcelain)"
git log --oneline origin/main..HEAD; git diff origin/main --stat; git rev-parse HEAD
```

Expected: three focused commits; no `dist*`, Playwright artifacts, owner files, or secrets. Push the Slice C branch, open a PR with exact gate output and packaged-surrogate limitation, and never merge.
