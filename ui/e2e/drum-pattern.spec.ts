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
