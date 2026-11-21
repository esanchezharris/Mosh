import { test, expect, type Page } from "@playwright/test";
import { bootV3 } from "./helpers";

// Ported from drum-pattern / pattern-library / uireach-drum-kit-reset (old v2 shell) to V3.
// V3 reaches the drum grid the same way a producer does: double-click a MIDI clip (opens the
// shared PianoRoll modal), pick Drums. Command-level cases go through the store's exec — the
// same seam the "+ Drum beat" button and the agent use.
//
// NO-V3-UI (kept alive through the bridge): "Save pattern to memory" lived on the v2 clip
// context menu and the memory panel in the classic top bar; V3 has neither (and lyric
// "Save flow" goes with the lyrics removal). agent_memory_write/read/delete stay covered here.

type Res = { ok: boolean; error?: string; data?: Record<string, unknown> };
type StoreHandle = { getState: () => { exec: (c: string, a?: Record<string, unknown>) => Promise<Res> } };

const execInPage = (page: Page, command: string, args: Record<string, unknown> = {}) =>
  page.evaluate(([c, a]) => {
    const store = (window as unknown as { __moshStore?: StoreHandle }).__moshStore;
    if (!store) throw new Error("__moshStore not exposed");
    return store.getState().exec(c as string, a as Record<string, unknown>);
  }, [command, args] as const);

const tracks = (page: Page) => page.getByTestId("v3-track");

/** Count of notes at `pitch` in the clip the piano roll is editing. */
const laneCount = (page: Page, pitch: number) => page.evaluate((p) => {
  const st = (window as any).__moshStore.getState();
  const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
  return clip.notes.filter((n: any) => n.pitch === p).length;
}, pitch);

async function openDrumGrid(page: Page) {
  // The seed's Drums track carries a real drum clip (kick/snare/hat).
  await page.getByTestId("v3-clip").first().dblclick();
  await expect(page.getByTestId("piano-roll")).toBeVisible();
  await page.getByRole("button", { name: "Drums", exact: true }).click();
  await expect(page.getByTestId("drum-sequencer")).toBeVisible();
}

test("add_drum_pattern lays a whole grid on a new Drums track in one command, and one undo removes it", async ({ page }) => {
  await bootV3(page);
  await expect(tracks(page).first()).toBeVisible();
  const before = await tracks(page).count();

  const res = await execInPage(page, "add_drum_pattern", {
    pattern: "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x.",
  });
  expect(res.ok).toBe(true);
  expect(res.data).toMatchObject({ noteCount: 14, steps: 16 });
  expect(res.data!.clipId).toBeTruthy();
  await expect(tracks(page)).toHaveCount(before + 1);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(tracks(page)).toHaveCount(before);
});

test("a pattern error surfaces the parser's message and lands nothing", async ({ page }) => {
  await bootV3(page);
  await expect(tracks(page).first()).toBeVisible();
  const before = await tracks(page).count();

  const res = await execInPage(page, "add_drum_pattern", { pattern: "cowbell: x..." });
  expect(res.ok).toBe(false);
  expect(String(res.error)).toContain("cowbell");
  await expect(tracks(page)).toHaveCount(before);
});

test("a mouse-only user can lay a lane from the Pattern field, in one undo step", async ({ page }) => {
  await bootV3(page);
  await openDrumGrid(page);

  await page.getByTestId("dr-pattern-toggle").click();
  const field = page.getByTestId("dr-pattern-input");
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(/kick:/);      // seeded from the live clip

  const kickBefore = await laneCount(page, 36);
  const hatsBefore = await laneCount(page, 42);
  expect(hatsBefore, "fixture has no hats to replace").toBeGreaterThan(4);

  // Invalid input is refused with the PARSER's own message, and Apply stays disabled.
  await field.fill("kick: x...; boguslane: x...");
  await expect(page.getByTestId("dr-pattern-apply")).toBeDisabled();
  await expect(page.getByTestId("dr-pattern-status")).toContainText("boguslane");

  // Naming only the hat lane replaces ONLY that lane — an edit, not a wipe.
  await field.fill("hat: x...x...x...x...");
  await page.getByTestId("dr-pattern-apply").click();
  await expect.poll(() => laneCount(page, 42)).toBe(4);
  expect(await laneCount(page, 36), "the kick lane was wiped — per-lane replace is broken").toBe(kickBefore);

  // The whole grid change is ONE undo step (the reason the command exists).
  await execInPage(page, "undo");
  await expect.poll(() => laneCount(page, 42)).toBe(hatsBefore);
});

test("load_drum_kit — Reset kit in the drum sequencer toolbar dispatches a real reload", async ({ page }) => {
  await bootV3(page);
  await openDrumGrid(page);

  const resetBtn = page.getByTestId("dr-reset-kit");
  await expect(resetBtn).toBeVisible();          // the seed track is already type:"drum"
  await resetBtn.click();

  // Observe the mock's command log after the real click (reads are never themselves logged).
  const last = await execInPage(page, "get_command_log", { limit: 1 });
  expect((last.data as { entries: { command: string; ok: boolean }[] }).entries[0])
    .toMatchObject({ command: "load_drum_kit", ok: true });
});

test("NO-V3-UI: a drum pattern card round-trips through agent_memory_write / agent_memory_read / agent_memory_delete", async ({ page }) => {
  await bootV3(page);
  await expect(tracks(page).first()).toBeVisible();
  const card = { name: "loop", pattern: "kick: x...x...x...x...", source: "saved" };

  const w = await execInPage(page, "agent_memory_write", { scope: "global", kind: "drum_pattern", explicit: true, item: card });
  expect(w.ok).toBe(true);
  const r = await execInPage(page, "agent_memory_read", { scope: "global", kind: "drum_pattern", limit: 5 });
  const items = (r.data as { items: { ts: number; item?: { name?: string } }[] }).items;
  expect(items.length).toBeGreaterThan(0);
  expect(JSON.stringify(items[0])).toContain("kick:");

  const d = await execInPage(page, "agent_memory_delete", { scope: "global", kind: "drum_pattern", ts: items[0].ts });
  expect(d.ok).toBe(true);
  const after = await execInPage(page, "agent_memory_read", { scope: "global", kind: "drum_pattern", limit: 5 });
  expect((after.data as { items: unknown[] }).items).toHaveLength(items.length - 1);
});
