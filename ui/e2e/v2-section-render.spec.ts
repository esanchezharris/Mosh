import { test, expect, type Page } from "@playwright/test";
import { bootV2 } from "./helpers";

// UIREACH-BOUNCE — the section-scoped render, end to end through real gestures.
//
// bounce_layer_to_clip was the last unreachable command, and NOT because a button was
// missing: it is a pure relabel on every path a producer could reach. It does real work only
// for a render scoped to PART of a clip, and no shell could create one — create_render_layer
// has accepted regionStart/regionEnd since it was written and nothing ever sent them.
//
// So this walks the whole chain the way a producer would: shift-drag a span over a clip,
// "Re-imagine section", render, Bounce — and asserts a clip actually appears on the Neural
// Renders lane spanning exactly the selected region. A spy on exec would prove the dispatch
// and none of the thing that was missing.
//
// Seeded fixture (bridge.mock.ts seedSnapshot, 120bpm 4/4 → 2s bars): Drums [0,8],
// Bass [0,8], Keys [2,8] (the wave clip). A [4,6] span cuts Keys strictly inside its bounds.

type MoshWindow = Window & {
  __moshStore?: {
    getState: () => {
      snapshot?: { tracks: { id: string; name: string; clips: { id: string; start: number; length: number }[] }[] };
    };
    setState: (s: Record<string, unknown>) => void;
  };
};

async function laneClips(page: Page): Promise<[number, number][]> {
  return page.evaluate(() => {
    const t = (window as MoshWindow).__moshStore?.getState().snapshot?.tracks
      .find((x) => x.name === "Neural Renders");
    return (t?.clips ?? []).map((c) => [c.start, c.start + c.length] as [number, number]);
  });
}

async function pxPerSecOf(page: Page): Promise<number> {
  const lefts = await page.locator(".v2-ruler-bar").evaluateAll((els) =>
    els.slice(0, 2).map((e) => parseFloat((e as HTMLElement).style.left)));
  return (lefts[1] - lefts[0]) / 2;
}

async function dragRange(page: Page, secStart: number, secEnd: number): Promise<void> {
  const ruler = page.getByTestId("v2-ruler");
  const box = (await ruler.boundingBox())!;
  const pxPerSec = await pxPerSecOf(page);
  const y = box.y + box.height / 2;
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + secStart * pxPerSec, y);
  await page.mouse.down();
  await page.mouse.move(box.x + secEnd * pxPerSec, y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
}

/** Select the track holding the seeded wave clip (Keys), which is what the section target
 *  resolves against — a range selection crosses every lane, so the selection disambiguates. */
async function selectKeys(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Select track Keys" }).click();
}

/** In v2 the generative drawer is a tab of the right-hand Inspector, not a bottom dock —
 *  a producer opens it the same way. */
async function openGenTab(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Gen" }).click();
}

test("a span inside a clip offers Re-imagine section; one covering the whole clip does not", async ({ page }) => {
  await bootV2(page);
  await selectKeys(page);

  // Keys spans [2,8]. A [4,6] span is strictly inside it.
  await dragRange(page, 4, 6);
  await expect(page.getByTestId("v2-timerange-reimagine"),
    "no section control for a span that cuts into the selected clip").toBeVisible();

  await page.getByTestId("v2-timerange-clear").click();

  // A span covering the whole clip is not a section — the engine would apply it in place,
  // and the drawer's own Re-imagine is the control for that.
  await dragRange(page, 2, 8);
  await expect(page.getByTestId("v2-timerange-reimagine"),
    "offered a 'section' that covers the entire clip").toHaveCount(0);
  // The band itself is still there, so the absence above is the gate and not a missing band.
  await expect(page.getByTestId("v2-timerange-band")).toBeVisible();
});

test("section render → Bounce lands a clip on the Neural Renders lane spanning the region", async ({ page }) => {
  await bootV2(page);
  await selectKeys(page);
  expect(await laneClips(page)).toHaveLength(0);

  await dragRange(page, 4, 6);
  await page.getByTestId("v2-timerange-reimagine").click();
  // The span has done its job and clears — leaving it up invites a second create on a clip
  // that now carries a layer.
  await expect(page.getByTestId("v2-timerange-band")).toHaveCount(0);

  await openGenTab(page);
  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();

  // Before rendering there is nothing to bounce, and the control says so rather than hiding.
  const bounce = gen.getByTestId("gen-bounce");
  await expect(bounce).toBeVisible();
  await expect(bounce).toBeDisabled();

  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");
  await expect(bounce).toBeEnabled();

  await bounce.click();
  await expect(gen.getByTestId("render-status")).toHaveText("bounced");

  // The actual proof: real audio landed, spanning exactly the region that was selected.
  expect(await laneClips(page)).toEqual([[4, 6]]);
  await expect(page.getByTestId("error")).toHaveCount(0);
});

test("a section render withholds Live / A-B / Reset — they describe a render it never becomes", async ({ page }) => {
  await bootV2(page);
  await selectKeys(page);
  await dragRange(page, 4, 6);
  await page.getByTestId("v2-timerange-reimagine").click();

  await openGenTab(page);
  const gen = page.getByTestId("generative");
  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");

  await expect(gen.getByTestId("gen-live")).toHaveCount(0);
  await expect(gen.getByTestId("gen-bypass")).toHaveCount(0);
  await expect(gen.getByTestId("gen-reset")).toHaveCount(0);
  await expect(gen.getByTestId("gen-bounce")).toBeVisible();
});
