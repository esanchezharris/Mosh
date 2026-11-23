import { type Page, type Locator, expect } from "@playwright/test";

// Shared e2e helpers for driving the Mosh WebView UI against the Vite dev server
// (in-memory mock backend). Selectors are the stable data-testid / data-* surface the
// arrangement exposes for structural (non-pixel) reads; gestures use real pointer
// events so the configurable interaction layer (gestures/keymap/feel) is exercised.

/** Boot the V3 workspace (the only shell) on the in-memory mock backend. */
export async function bootV3(page: Page, query = ""): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      // startOnLaunch:false: these specs drive the workspace, not the Start page.
      version: 2, template: null, values: { colorway: "lime", startOnLaunch: false }, keyOverrides: {},
    }));
  });
  await page.goto(`/${query ? `?${query}` : ""}`);
  await expect(page.getByTestId("v3-shell")).toBeVisible();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
}

/** Boot V3 the way a friend's first launch does: the "set up a song when Mosh opens"
 *  setting ON, so an empty session becomes the recording template and the first-run
 *  checklist (StartChecklist.tsx) opens over the workspace. The seed is written ONCE per
 *  test (a sessionStorage marker), not on every navigation like the other boots: a reload
 *  must keep what the checklist itself wrote. `seed` picks a mock session (?mockSeed=),
 *  `fault` the mock's ?mockFault= knobs (bridge.mock.ts), `query` any other knob. */
export async function bootV3Start(page: Page, opts: { seed?: string; fault?: string; colorway?: string; aiToolsOff?: boolean; query?: Record<string, string> } = {}): Promise<void> {
  await page.addInitScript((colorway) => {
    if (window.sessionStorage.getItem("mosh.e2e.seeded")) return;
    window.sessionStorage.setItem("mosh.e2e.seeded", "1");
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: null, values: { colorway, startOnLaunch: true }, keyOverrides: {},
    }));
  }, opts.colorway ?? "lime");
  const q = new URLSearchParams(opts.query ?? {});
  if (opts.seed) q.set("mockSeed", opts.seed);
  if (opts.fault) q.set("mockFault", opts.fault);
  if (opts.aiToolsOff) q.set("mockAiTools", "off");
  await page.goto(`/?${q.toString()}`);
  await expect(page.getByTestId("v3-shell")).toBeVisible();
  // The workspace, never a separate page and never the Booth.
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await expect(page.getByTestId("v3-checklist")).toBeVisible();
  await expect(page.getByTestId("v3-booth")).toHaveCount(0);
}

/** Show the Booth view. It has no menu entry while its redesign is pending (the friends
 *  flow never routes into it), so the Booth's own specs switch to it through the dev
 *  handle shellState.ts exposes. */
export async function enterBooth(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __moshV3: { getState: () => { setPosture: (p: "booth") => void } };
      __moshStore: { getState: () => { setView: (v: "arrange") => void } };
    };
    w.__moshStore.getState().setView("arrange");
    w.__moshV3.getState().setPosture("booth");
  });
  await expect(page.getByTestId("v3-booth")).toBeVisible();
}

/** Switch the mock's output to headphones. The default mock session plays through
 *  "MacBook Pro Speakers", where the Booth's speaker guard (and the Start page's) keeps
 *  Hear myself OFF, exactly as native does; a spec about monitoring itself needs headphones. */
export async function useHeadphones(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = (window as unknown as { __moshStore: { getState: () => {
      exec: (c: string, a?: Record<string, unknown>) => Promise<unknown>; refresh: () => Promise<void>;
    } } }).__moshStore;
    await store.getState().exec("set_audio_device", { outputDevice: "External Headphones" });
    await store.getState().refresh();
  });
}

// ── Command trace ────────────────────────────────────────────────────────────
export type TracedCommand = { command: string; args: Record<string, unknown>; ok: boolean };

/** The commands the UI has dispatched so far, in order: the mock's dev-only
 *  window.__moshCmdTrace (bridge.mock.ts). The mock leaves its READONLY set out of the
 *  trace (list_loras, training_job_status, …), so those cannot be asserted this way. */
export async function commandTrace(page: Page): Promise<TracedCommand[]> {
  return page.evaluate(() =>
    ((window as unknown as { __moshCmdTrace?: TracedCommand[] }).__moshCmdTrace ?? [])
      .map(({ command, args, ok }) => ({ command, args, ok })),
  );
}

/** A real click path proves a control is reachable; this pins WHICH command it sent.
 *  Passes once the trace holds a successful `command` whose args include `args`. */
export async function expectDispatched(page: Page, command: string, args: Record<string, unknown> = {}): Promise<void> {
  await expect
    .poll(() => commandTrace(page), { message: `the UI dispatches ${command}` })
    .toContainEqual(expect.objectContaining({ command, ok: true, args: expect.objectContaining(args) }));
}

// ── Real-pointer gestures ────────────────────────────────────────────────────
const center = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

/** Drag a clip body horizontally by dxPx (engages past the drag threshold). */
export async function dragClipBy(page: Page, clip: Locator, dxPx: number): Promise<void> {
  const b = (await clip.boundingBox())!;
  const c = center(b);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dxPx, c.y, { steps: 12 });
  await page.mouse.up();
}

/** Drag a clip's right edge (within the edge-grab band) by dxPx → trim. */
export async function trimClipRightBy(page: Page, clip: Locator, dxPx: number): Promise<void> {
  const b = (await clip.boundingBox())!;
  const y = b.y + b.height / 2;
  const x = b.x + b.width - 3; // inside the ~7px right edge-grab band
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dxPx, y, { steps: 12 });
  await page.mouse.up();
}

/** Number → from a clip's data-clip-start / -length attribute. */
export async function clipNum(clip: Locator, attr: "data-clip-start" | "data-clip-length"): Promise<number> {
  return Number(await clip.getAttribute(attr));
}
