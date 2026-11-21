import { test, expect, type Page } from "@playwright/test";
import { bootV3, expectDispatched, commandTrace } from "./helpers";

// Ported from session-lifecycle.spec.ts and export-dialog.spec.ts (v2 shell, retired).
//
// Session lifecycle: V3 reaches it from the File menu (New Session / Open… / Save / Save As…)
// and the first-run Start flow (covered by v3-checklist / v3-start specs). The browser mock's
// file pickers answer deterministically (bridge.mock + bridge.pickers.test.ts), so the menu
// items dispatch real commands here.
//
// Export: V3's only export surface is File ▸ Export audio… (a save-file pick, then
// export_audio at the file's format / 24-bit). The v2 dialog's range / tail / loop / stems /
// bit-depth controls (ui/src/ui/ExportControls.tsx) are not mounted anywhere in V3, so those
// behaviours are kept by driving the same commands through the store (the path the UI uses),
// marked NO-V3-UI in the tests below.
//
// Not ported: the v2 launch picker (Continue / Start empty / Recent rows, ?picker=1). V3 has
// no such screen; launch is the Start flow (v3-checklist.spec.ts, bootV3Start).

type Snap = { tracks: unknown[]; session: { editFile: string; recentProjects?: { path: string; name: string }[] } };
type Res = { ok: boolean; error?: string; data?: Record<string, unknown> };
type MoshWindow = Window & { __moshStore: { getState: () => { snapshot: Snap; exec: (c: string, a?: object) => Promise<Res> } } };

const snap = (page: Page) => page.evaluate(() => (window as unknown as MoshWindow).__moshStore.getState().snapshot);
const exec = (page: Page, command: string, args: object = {}) =>
  page.evaluate(([c, a]) => (window as unknown as MoshWindow).__moshStore.getState().exec(c as string, a as object), [command, args] as const);

// Item names carry their shortcut ("Save ⌘S"), so match the label up to its shortcut glyph.
const item = (page: Page, name: string) =>
  page.getByTestId("v3-file-menu").getByRole("menuitem", { name: new RegExp(`^${name.replace(/[.…]/g, "\\$&")}(\\s*[⌘⇧]|$)`) });
async function menu(page: Page, name: string) {
  await page.getByTestId("v3-file-trigger").click();
  await item(page, name).click();
}

test("the File menu carries the project actions", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-file-trigger").click();
  for (const name of ["New Session", "Open…", "Save", "Save As…", "Export audio…"]) {
    await expect(item(page, name)).toBeVisible();
  }
});

test("new_project: New Session gives a genuinely empty arrangement, and the session you left stays in Recent", async ({ page }) => {
  await bootV3(page);
  await expect(page.getByTestId("v3-track")).toHaveCount(3);               // anti-vacuity: the seed has tracks
  const left = (await snap(page)).session.editFile;
  await menu(page, "New Session");
  await expectDispatched(page, "new_project");
  await expect(page.getByTestId("v3-track")).toHaveCount(0);
  expect((await snap(page)).tracks).toHaveLength(0);
  // Mirrors native rememberProject(editPath): New must not be a one-way door.
  const recents = (await snap(page)).session.recentProjects ?? [];
  expect(recents.map((p) => p.path), "the session we left is gone from Recent").toContain(left);
});

test("open_recent reopens the session you left, with its tracks", async ({ page }) => {
  await bootV3(page);
  const left = (await snap(page)).session.editFile;
  await menu(page, "New Session");
  await expect(page.getByTestId("v3-track")).toHaveCount(0);
  const idx = ((await snap(page)).session.recentProjects ?? []).findIndex((p) => p.path === left);
  expect(idx).toBeGreaterThanOrEqual(0);
  // NO-V3-UI: V3 has no Recent list; open_recent is driven through the store.
  expect((await exec(page, "open_recent", { index: idx })).ok).toBe(true);
  await expect(page.getByTestId("v3-track")).toHaveCount(3);
  expect((await snap(page)).session.editFile).toBe(left);
  // An index past the end is an error result, not a silent no-op.
  const bad = await exec(page, "open_recent", { index: 99 });
  expect(bad.ok).toBe(false);
});

test("open_project: Open… opens the picked project", async ({ page }) => {
  await bootV3(page);
  await menu(page, "Open…");
  await expectDispatched(page, "open_project", { file: "/mock/sessions/protools-tonight.mosh" });
  await expect.poll(async () => (await snap(page)).session.editFile).toBe("/mock/sessions/protools-tonight.mosh");
});

test("save and save_as: the menu dispatches both, and Save As renames the open project", async ({ page }) => {
  await bootV3(page);
  await menu(page, "Save");
  await expectDispatched(page, "save");
  await menu(page, "Save As…");
  await expectDispatched(page, "save_as", { file: "/mock/sessions/protools-tonight.mosh" });
  await expect.poll(async () => (await snap(page)).session.editFile).toBe("/mock/sessions/protools-tonight.mosh");
  await expect(page.getByTestId("v3-file-trigger")).toContainText("protools-tonight");
});

test("export_audio: File ▸ Export audio… renders the mix at the picked file's format", async ({ page }) => {
  await bootV3(page);
  await menu(page, "Export audio…");
  await expectDispatched(page, "export_audio", { file: "/mock/exports/mix.wav", format: "wav", bitDepth: 24 });
});

// NO-V3-UI — v3 has no export dialog; these keep the range / tail / depth / stems commands
// covered through the same store path the v2 ExportControls used.
test("export_audio range, tail and bit depth through the store (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const full = await exec(page, "export_audio", { format: "wav", bitDepth: 24 });
  expect(full.ok).toBe(true);

  const custom = await exec(page, "export_audio", { format: "wav", bitDepth: 24, range: "custom", start: 0.5, end: 2, tail: "include", tailSeconds: 2 });
  expect(custom.ok).toBe(true);
  expect(custom.data).toMatchObject({ range: "custom", rangeStart: 0.5, rangeEnd: 2, seconds: 1.5, tail: "include", endAllowance: 2 });
  expect(String(custom.data?.file)).toContain(".wav");

  const loop = await exec(page, "export_audio", { format: "wav", bitDepth: 24, range: "loop" });
  expect(loop.data).toMatchObject({ range: "loop" });

  const sixteen = await exec(page, "export_audio", { format: "wav", bitDepth: 16 });
  expect(sixteen.ok).toBe(true);
  expect(sixteen.data).toMatchObject({ bitDepth: 16 });
});

test("export_stems writes one file per non-empty track (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const r = await exec(page, "export_stems", { format: "wav", bitDepth: 24 });
  expect(r.ok).toBe(true);
  const d = r.data as { dir?: string; count?: number; stems?: { file: string }[] };
  expect(d.dir).toBeTruthy();
  expect(d.count).toBe(d.stems?.length);
  expect(d.count).toBeGreaterThan(0);
  // The commands really went through the same trace the UI's clicks do.
  const names = (await commandTrace(page)).map((c) => c.command);
  expect(names).toContain("export_stems");
});
