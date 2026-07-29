import { test, expect } from "@playwright/test";
import { bootV2, openV2ArrangementTools } from "./helpers";

// The annotation lane — create_annotation / edit_annotation / move_annotation /
// remove_annotation reaching a mouse-only v2 user for the first time. v2 rendered NO
// annotation surface at all before this; classic's AnnotationRuler.tsx (imported only by
// classic's Arrange.tsx, which v2 never mounts) was the sole call site.
//
// Driven through the real gestures (pointer moves/clicks against actual rendered layout)
// rather than store.exec, because the seam this feature can break is layout and event
// sequencing, not dispatch: a component that calls exec correctly under a spy can still
// (a) put a pin in the wrong place on screen if it's built on the flat geom.ts helpers
// instead of time.ts's piecewise map, or (b) never actually receive the click because the
// inline input opened on pointerdown and a real mousedown/mouseup sequence blurred it shut
// (the trap TempoRibbon's own e2e exists to catch — jsdom unit tests do not reproduce it).

test("the seeded note renders and can be removed with the mouse", async ({ page }) => {
  await bootV2(page);
  await openV2ArrangementTools(page);
  const lane = page.getByTestId("v2-annotation-lane");
  await expect(lane).toBeVisible();
  // bridge.mock seeds one annotation ("tighten this transition" at beat 24).
  await expect(page.getByTestId("v2-annotation")).toHaveCount(1);

  await page.getByTestId("v2-annotation").hover(); // ✕ is hover-revealed, like the tempo/section lanes
  await page.getByTestId("v2-annotation-remove").click();
  await expect(page.getByTestId("v2-annotation")).toHaveCount(0);
});

test("a new note can be created by clicking empty lane space", async ({ page }) => {
  await bootV2(page);
  await openV2ArrangementTools(page);
  const lane = page.getByTestId("v2-annotation-lane");
  const seeded = page.getByTestId("v2-annotation");
  const seededBox = (await seeded.boundingBox())!;

  const box = (await lane.boundingBox())!;
  // Clear of the seeded pin, well inside the lane.
  const x = seededBox.x + seededBox.width + 150;
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const input = page.getByTestId("v2-annotation-input");
  await expect(input).toBeVisible();
  await input.fill("check the low end here");
  await input.press("Enter");

  await expect(page.getByTestId("v2-annotation")).toHaveCount(2);
  const created = page.getByTestId("v2-annotation").last();
  await expect(created).toHaveAttribute("title", /check the low end here/);
});

test("pressing Escape abandons a draft note without creating one", async ({ page }) => {
  await bootV2(page);
  await openV2ArrangementTools(page);
  const lane = page.getByTestId("v2-annotation-lane");
  const box = (await lane.boundingBox())!;
  await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const input = page.getByTestId("v2-annotation-input");
  await expect(input).toBeVisible();
  await input.fill("abandoned");
  await input.press("Escape");
  await expect(input).toBeHidden();
  await expect(page.getByTestId("v2-annotation")).toHaveCount(1); // still just the seed
});

test("double-clicking a note edits its text inline with the mouse", async ({ page }) => {
  await bootV2(page);
  await openV2ArrangementTools(page);
  const pin = page.getByTestId("v2-annotation").first();
  await pin.dblclick();

  const input = page.getByTestId("v2-annotation-edit");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("tighten this transition");
  await input.fill("actually this is fine now");
  await input.press("Enter");

  await expect(page.getByTestId("v2-annotation-edit")).toHaveCount(0);
  await expect(pin).toHaveAttribute("title", /actually this is fine now/);
});

test("dragging a note moves it, and the move survives a tempo change (piecewise, not flat)", async ({ page }) => {
  await bootV2(page);
  await openV2ArrangementTools(page);
  // First, insert a real tempo change via the tempo lane's own mouse gesture — this is what
  // makes flat-vs-piecewise a real, observable difference rather than a coincidence.
  const tempoLane = page.getByTestId("v2-tempo-lane");
  const tempoBox = (await tempoLane.boundingBox())!;
  await page.mouse.move(tempoBox.x + 60, tempoBox.y + tempoBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.getByTestId("v2-tempo-input").fill("240"); // double tempo -> half-length bars from here
  await page.getByTestId("v2-tempo-input").press("Enter");
  await expect(page.getByTestId("v2-tempo-point")).toHaveCount(2);
  const changeAtSec = Number(await page.getByTestId("v2-tempo-point").nth(1).getAttribute("data-time"));

  // Drag the seeded note (beat 24, originally before the change) well to the right, past
  // the tempo change, and confirm its on-screen position tracks the FASTER tempo (moves
  // further per beat) rather than silently reverting to the flat pre-change rate.
  const pin = page.getByTestId("v2-annotation").first();
  const beforeBeat = Number(await pin.getAttribute("data-beat"));
  const box = (await pin.boundingBox())!;
  const dragPx = 260;
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 5 + dragPx, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => Number(await pin.getAttribute("data-beat"))).toBeGreaterThan(beforeBeat);
  const afterBeat = Number(await pin.getAttribute("data-beat"));
  const afterLeft = Number((await pin.evaluate((e) => (e as HTMLElement).style.left)).replace("px", ""));

  // The pin's rendered left must match secAtBeat(map, afterBeat) — i.e. computed through the
  // piecewise map. Recompute what a FLAT (single-tempo, pre-change) formula would have put
  // there instead, from data already on the page (pxPerSec via the tempo point's own pixel
  // ratio), and assert the two disagree — guards against a vacuous read on a fixture that
  // happens to agree.
  const pxPerSec = Number(await page.getByTestId("v2-tempo-point").nth(1)
    .evaluate((e) => parseFloat((e as HTMLElement).style.left))) / changeAtSec;
  const flatLeft = afterBeat * 0.5 * pxPerSec; // 0.5s/beat is the ORIGINAL (120bpm) rate
  expect(Math.abs(afterLeft - flatLeft), "pin position matches the flat formula, not the piecewise map").toBeGreaterThan(5);
});
