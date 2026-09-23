import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// A20 (demo readiness): "+ Chords" gives the Presets moment notes to play. From an EMPTY session
// (the demo opens on ⌘N), one click lands a Keys track holding ONE four-bar MIDI clip of twelve
// chord notes, selects it and opens Browser › Presets on it; one ⌘Z removes the lot. Nothing here
// uses the Browser's MIDI tab (the mock's fake .mid rows do not exist natively).

type MoshWindow = Window & { __moshStore?: { getState: () => {
  selectedTrackId: string | null;
  snapshot?: { session: { tempo: number }; tracks: { id: string; name: string; plugins?: { isInstrument: boolean }[];
    clips: { id: string; type: string; start: number; length: number; notes?: { pitch: number; start: number }[] }[] }[] };
} } };
const snap = (page: Parameters<typeof bootV3>[0]) =>
  page.evaluate(() => {
    const s = (window as unknown as MoshWindow).__moshStore!.getState();
    return { selected: s.selectedTrackId, tempo: s.snapshot!.session.tempo, tracks: s.snapshot!.tracks };
  });

test("+ Chords from an empty session: a Keys track with 12 notes over 4 bars, Presets open on it, one undo removes it", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-file-trigger").click();
  await page.getByRole("menuitem", { name: "New Session" }).click();
  const tracks = page.getByTestId("v3-track");
  await expect(tracks).toHaveCount(0);
  await expect(page.getByTestId("v3-browser")).toHaveCount(0);

  await page.getByTestId("v3-add-chords").click();
  await expect(tracks).toHaveCount(1);
  await expect(tracks.first().getByRole("button", { name: "Select track Keys" })).toBeVisible();
  const clip = tracks.first().getByTestId("v3-clip");
  await expect(clip).toHaveCount(1);
  const s = await snap(page);
  const keys = s.tracks[0]!;
  expect(keys.name).toBe("Keys");
  expect(keys.clips).toHaveLength(1);
  expect(keys.clips[0]!.type).toBe("midi");
  expect(keys.clips[0]!.start).toBe(0);
  expect(keys.clips[0]!.length).toBeCloseTo((4 * 4 * 60) / s.tempo, 6);        // four bars (8 s at 120 BPM)
  expect(keys.clips[0]!.notes).toHaveLength(12);
  expect(new Set(keys.clips[0]!.notes!.map((n) => n.start))).toEqual(new Set([0, 4, 8, 12]));   // a chord on every bar
  expect(s.selected).toBe(keys.id);

  // the Browser opened on its Presets tab, showing the new track's instrument and its picker
  const browser = page.getByTestId("v3-browser");
  await expect(browser).toBeVisible();
  await expect(page.getByTestId("v3-browser-presets")).toHaveClass(/\bon\b/);
  await expect(page.getByTestId("v3-preset-row")).toHaveCount(1);
  await expect(page.getByTestId("v3-presets").getByTestId("preset-pick")).toBeVisible();
  await expect(page.getByTestId("v3-preset-current")).toHaveText(/keys/i);   // the Keys patch is on
  await expect(page.getByTestId("v3-inspector")).toHaveAttribute("data-track-id", keys.id);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(tracks).toHaveCount(0);
  expect((await snap(page)).tracks).toHaveLength(0);
});

test("+ Chords is disabled while a Moshi task runs, and enabled again once it ends", async ({ page }) => {
  await bootV3(page);
  const chords = page.getByTestId("v3-add-chords");
  await expect(chords).toBeEnabled();
  // The mock's deterministic task finishes in ~100 ms — faster than a polling matcher can
  // sample — so record every flip of the button's `disabled` in the page itself.
  await page.evaluate(() => {
    const w = window as unknown as { __chordsFlips: boolean[] };
    w.__chordsFlips = [];
    const b = document.querySelector<HTMLButtonElement>('[data-testid="v3-add-chords"]')!;
    new MutationObserver(() => { const last = w.__chordsFlips.at(-1); if (last !== b.disabled) w.__chordsFlips.push(b.disabled); })
      .observe(b, { attributes: true, attributeFilter: ["disabled"] });
  });
  const tracksBefore = await page.getByTestId("v3-track").count();
  await page.getByTestId("v3-moshi-field").fill("build me a lofi sketch");
  await page.getByTestId("v3-moshi-send").click();
  await expect(page.getByTestId("v3-track")).toHaveCount(tracksBefore + 1, { timeout: 15_000 });   // the task really ran
  await expect(page.getByTestId("v3-moshi-field")).toBeEnabled({ timeout: 15_000 });
  await expect(chords).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { __chordsFlips: boolean[] }).__chordsFlips)).toEqual([true, false]);
});
