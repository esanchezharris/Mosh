// DRM-002 — add_drum_pattern smoke: ONE command lays a whole drum grid. Drives the
// real UI bundle against the mock bridge via the store's exec (the same seam the
// agent uses); asserts the result envelope and the arrangement reflecting the new
// track after snapshot_invalidated.
import { test, expect } from "@playwright/test";
import { boot, tracks } from "./helpers";

type StoreHandle = {
  getState: () => { exec: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
};

const execInPage = (page: import("@playwright/test").Page, command: string, args: Record<string, unknown>) =>
  page.evaluate(
    ([c, a]) => {
      const store = (window as unknown as { __moshStore?: StoreHandle }).__moshStore;
      if (!store) throw new Error("__moshStore not exposed");
      return store.getState().exec(c as string, a as Record<string, unknown>);
    },
    [command, args] as const,
  );

test("add_drum_pattern lays a whole grid on a new Drums track in one command", async ({ page }) => {
  await boot(page);
  const before = await tracks(page).count();

  const res = (await execInPage(page, "add_drum_pattern", {
    pattern: "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x.",
  })) as { ok: boolean; data: { clipId: string; trackId: string; noteCount: number; steps: number; bars: number } };

  expect(res.ok).toBe(true);
  expect(res.data.noteCount).toBe(14);
  expect(res.data.steps).toBe(16);
  expect(res.data.clipId).toBeTruthy();

  await expect(tracks(page)).toHaveCount(before + 1);
});

test("a pattern error surfaces and lands nothing", async ({ page }) => {
  await boot(page);
  const before = await tracks(page).count();

  const res = (await execInPage(page, "add_drum_pattern", { pattern: "cowbell: x..." })) as {
    ok: boolean;
    error?: string;
  };

  expect(res.ok).toBe(false);
  expect(String(res.error)).toContain("cowbell");
  await expect(tracks(page)).toHaveCount(before);
});

// DRM-002 UI — the command shipped agent-only: backend, twin parsers and goldens all
// complete, but no control called it, so a mouse-only user built beats one cell at a time
// and got one undo step per cell. This drives the real gesture (the test above drives
// store.exec, which is exactly the seam that made it *look* reachable).
test("a mouse-only user can lay a whole grid from the Pattern field, in one undo step", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: {}, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-timeline")).toBeVisible();

  // Open the drum grid the way a producer would: double-click the MIDI clip, pick Drums.
  await page.locator(".v2-clip.drum, .v2-clip.midi").first().dblclick();
  await expect(page.getByTestId("piano-roll")).toBeVisible();
  await page.getByRole("button", { name: "Drums", exact: true }).click();
  await expect(page.getByTestId("drum-sequencer")).toBeVisible();

  const hatCount = () => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
    return clip.notes.filter((n: any) => n.pitch === 42).length;
  });
  const kickCount = () => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
    return clip.notes.filter((n: any) => n.pitch === 36).length;
  });

  await page.getByTestId("dr-pattern-toggle").click();
  const field = page.getByTestId("dr-pattern-input");
  await expect(field).toBeVisible();
  // Seeded from the live clip, so the field is an editable picture of the grid.
  await expect(field).toHaveValue(/kick:/);

  const kickBefore = await kickCount();
  const hatsBefore = await hatCount();
  expect(hatsBefore, "fixture has no hats to replace").toBeGreaterThan(4);

  // Invalid input is refused with the PARSER's own message, and Apply stays disabled.
  await field.fill("kick: x...; boguslane: x...");
  await expect(page.getByTestId("dr-pattern-apply")).toBeDisabled();
  await expect(page.getByTestId("dr-pattern-status")).toContainText("boguslane");

  // Naming only the hat lane replaces ONLY that lane — this is an edit, not a wipe.
  await field.fill("hat: x...x...x...x...");
  await page.getByTestId("dr-pattern-apply").click();
  await expect.poll(hatCount).toBe(4);
  expect(await kickCount(), "the kick lane was wiped — per-lane replace is broken").toBe(kickBefore);

  // …and the whole grid change is ONE undo step, which is why the command exists.
  await page.evaluate(() => (window as any).__moshStore.getState().exec("undo"));
  await expect.poll(hatCount).toBe(hatsBefore);
});
