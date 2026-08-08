import { type Page, type Locator, expect } from "@playwright/test";

// Shared e2e helpers for driving the Mosh WebView UI against the Vite dev server
// (in-memory mock backend). Selectors are the stable data-testid / data-* surface the
// arrangement exposes for structural (non-pixel) reads; gestures use real pointer
// events so the configurable interaction layer (gestures/keymap/feel) is exercised.

export const TEMPLATES = ["mosh", "ableton", "fl", "protools", "logic"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export const TEMPLATE_SKIN: Record<TemplateName, { skin: string; theme: string; label: string }> = {
  mosh: { skin: "mosh", theme: "dark", label: "Mosh" },
  ableton: { skin: "ableton", theme: "light", label: "Ableton" },
  fl: { skin: "fl", theme: "dark", label: "FL" },
  protools: { skin: "protools", theme: "dark", label: "Pro Tools" },
  logic: { skin: "logic", theme: "dark", label: "Logic" },
};

/** Load the app in the CLASSIC shell (Mosh/dark template) and wait for the cold snapshot.
 *  The v2 shell is the shipping default (uiShell defaults to "v2" in settings/schema.ts),
 *  and within classic the agent-first redesign also defaults on (redesignShell true) — so
 *  these core/template/producer specs, which drive the topbar File/Export menus the
 *  redesign relocates into the "+" control, explicitly seed uiShell:"classic" +
 *  redesignShell:false to keep exercising the classic layout (the supported fallback).
 *  The v2 default is covered by the v2 specs (bootV2 below); the redesign variant by
 *  redesign-shell.spec. addInitScript runs before the page's scripts, so the settings
 *  store hydrates from this seed → deterministic every test. */
export async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 1, template: null, values: { redesignShell: false, uiShell: "classic" } }));
  });
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("arrangement")).toBeVisible();
}

/** Boot the agent-first REDESIGN variant of the classic shell (redesignShell:true — the
 *  classic-side default, though the shipping default shell overall is v2) so the right
 *  Session/Inspector rail is present — needed to observe the PT/Logic right-rail
 *  restructure. (redesign-shell.spec has its own local copy; this is the shared one.) */
export async function bootRedesign(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 1, template: null, values: { redesignShell: true, uiShell: "classic" } }));
  });
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("arrangement")).toBeVisible();
}

/** Boot the v2 shell via the dev `?shell=v2` override (promoted from v2-shell.spec's
 *  local copy). `theme` defaults to the shipping default (cream/light ground); pass
 *  "dark" to pin the dark ground — edge-case specs assert against BOTH. */
export async function bootV2(page: Page, opts: { theme?: "dark" | "light" } = {}): Promise<void> {
  const values = opts.theme ? { theme: opts.theme } : {};
  await page.addInitScript((vals) => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: vals, keyOverrides: {} }));
  }, values);
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

/** Boot the LIVE clone shell (ui/src/live — the Live 12 Arrangement-View clone) via
 *  the dev `?shell=live` override. Pins the ableton gesture table + keymap, the same
 *  interaction bundle the "Live (clone)" template materialises — the clone's clip
 *  gestures (header-drag moves, body-drag time-selects) only read as Live under it.
 *  `opts.values` layers extra setting overrides (e.g. a fixed editor grid for the
 *  docked piano roll's draw tests) into the same seed. */
export async function bootLive(page: Page, opts: { values?: Record<string, unknown>; query?: string } = {}): Promise<void> {
  const values = { gestureTable: "ableton", keymap: "ableton", ...opts.values };
  await page.addInitScript((vals) => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: null, values: vals, keyOverrides: {},
    }));
  }, values);
  await page.goto(`/?shell=live${opts.query ?? ""}`);
  await expect(page.getByTestId("live-shell")).toBeVisible();
  await expect(page.getByTestId("live-timeline")).toBeVisible();
}

/** File → <action> through the in-WebView File menu (same runAction dispatch the native
 *  menu + keyboard use). */
export async function fileMenu(page: Page, action: string): Promise<void> {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.locator(`[data-testid="file-menu"] [data-action="${action}"]`).click();
}

export async function newProject(page: Page): Promise<void> {
  // The switch is ASYNC by design (runAction writes the outgoing project's session
  // summary before the store.exec lands), so clicking File → New is not enough —
  // the next steps must only run once the blank edit is actually showing, or their
  // tracks get wiped when the late application lands (the walkthrough/templates
  // 5-headers-then-0 race).
  const before = await page.evaluate(
    () => (window as any).__moshStore.getState().snapshot.session.editFile,
  );
  await fileMenu(page, "new_project");
  await expect
    .poll(() => page.evaluate(
      () => (window as any).__moshStore.getState().snapshot.session.editFile,
    ))
    .not.toBe(before);
  await expect.poll(() =>
    page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks.length),
  ).toBe(0);
}

export function tracks(page: Page): Locator {
  return page.getByTestId("track-header");
}
export function clips(page: Page): Locator {
  return page.getByTestId("clip");
}
/** Clips on a single track's lane (lane is keyed by data-track-id). */
export function clipsOnTrack(page: Page, trackId: string): Locator {
  return page.locator(`[data-testid="lane"][data-track-id="${trackId}"] [data-testid="clip"]`);
}

export async function addAudioTrack(page: Page): Promise<void> {
  await page.getByRole("button", { name: "+ Track", exact: true }).click();
}
export async function addDrumTrack(page: Page): Promise<void> {
  await page.getByTestId("add-drum-track").click();
}

/** Select a track by clicking its header; returns its trackId. */
export async function selectTrack(page: Page, index = 0): Promise<string> {
  const header = tracks(page).nth(index);
  await header.click();
  await expect(header).toHaveAttribute("data-selected", "true");
  return (await header.getAttribute("data-track-id"))!;
}

/** Add an (empty) MIDI clip to the currently selected track. */
export async function addMidiClip(page: Page): Promise<void> {
  await page.getByRole("button", { name: "+ MIDI", exact: true }).click();
}

export async function setTool(page: Page, tool: "Move" | "Split" | "Range"): Promise<void> {
  await page.getByRole("group", { name: "Tool" }).getByRole("button", { name: tool, exact: true }).click();
}

// ── Settings / templates ─────────────────────────────────────────────────────
export async function openSettings(page: Page): Promise<void> {
  await page.locator('button[title="Settings"]').click();
  await expect(page.getByTestId("template-picker")).toBeVisible();
}
export async function pickTemplate(page: Page, name: TemplateName): Promise<void> {
  await openSettings(page);
  await page.getByTestId("template-picker").getByRole("button", { name: TEMPLATE_SKIN[name].label, exact: true }).click();
  // Close the popover so it doesn't overlay later interactions.
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-skin", TEMPLATE_SKIN[name].skin);
}

// ── Real-pointer gestures ────────────────────────────────────────────────────
const center = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

/** Drag a clip body horizontally by dxPx (engages past the drag threshold). The
 *  vertical target stays in the body band; for Mosh/FL the whole clip moves. */
export async function dragClipBy(page: Page, clip: Locator, dxPx: number): Promise<void> {
  const b = (await clip.boundingBox())!;
  const c = center(b);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dxPx, c.y, { steps: 12 });
  await page.mouse.up();
}

/** Drag a clip's HEADER strip (the top ~18px) by dxPx. Under Ableton this is the
 *  move zone (the body time-selects instead); under Mosh/FL the whole clip moves. */
export async function dragClipHeaderBy(page: Page, clip: Locator, dxPx: number): Promise<void> {
  const b = (await clip.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + 9; // inside the 18px header band, clear of the edge-grab zones
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dxPx, y, { steps: 12 });
  await page.mouse.up();
}

/** Drag a clip's right edge (within the edge-grab band) by dxPx → trim. Requires the
 *  Move tool active (default) under Mosh; Ableton/FL trim the edge in any tool. */
export async function trimClipRightBy(page: Page, clip: Locator, dxPx: number): Promise<void> {
  const b = (await clip.boundingBox())!;
  const y = b.y + b.height / 2;
  const x = b.x + b.width - 3; // inside the ~7px right edge-grab band
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dxPx, y, { steps: 12 });
  await page.mouse.up();
}

/** With the Split tool active, click a clip at a fractional x to split it there. */
export async function splitClipAt(page: Page, clip: Locator, frac = 0.5): Promise<void> {
  const b = (await clip.boundingBox())!;
  await page.mouse.click(b.x + b.width * frac, b.y + b.height / 2);
}

/** Number → from a clip's data-clip-start / -length attribute. */
export async function clipNum(clip: Locator, attr: "data-clip-start" | "data-clip-length"): Promise<number> {
  return Number(await clip.getAttribute(attr));
}
