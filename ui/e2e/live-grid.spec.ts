import { expect, test, type Page } from "@playwright/test";
import { bootLive } from "./helpers";

type GridStore = {
  getState: () => {
    readonly pxPerSec: number;
    readonly snapDivision: SnapDivision;
    readonly snapTriplet: boolean;
    readonly snapAuto: boolean;
    readonly snapshot: {
      readonly session: {
        readonly tempo: number;
        readonly timeSigNumerator?: number;
        readonly timeSigDenominator?: number;
      };
      readonly tracks: readonly {
        readonly id: string;
        readonly name: string;
      }[];
    } | null;
    exec: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    setPxPerSec: (pxPerSec: number) => void;
    setSnapDivision: (division: SnapDivision) => void;
    setSnapAuto: (auto: boolean) => void;
    setSnapTriplet: (triplet: boolean) => void;
    effectiveSnapDivision: () => SnapDivision;
  };
};

type SnapDivision = "bar" | "1/4" | "1/8" | "1/16" | "1/32";

type GridWindow = Window & {
  __moshStore?: GridStore;
};

async function gridSeconds(page: Page, kind: "bar" | "beat" | "subdivision"): Promise<number[]> {
  return page.locator(`[data-testid="live-grid-line"][data-grid-kind="${kind}"]`).evaluateAll((lines) =>
    lines.map((line) => Number(line.getAttribute("data-grid-seconds"))),
  );
}

async function withGridStore(page: Page, operation: "minZoom" | "maxZoom" | "quarter" | "sixteenth" | "triplet" | "auto"): Promise<void> {
  await page.evaluate((next) => {
    const store = (window as GridWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    const state = store.getState();
    const operations: Record<typeof next, () => void> = {
      minZoom: () => state.setPxPerSec(20),
      maxZoom: () => state.setPxPerSec(400),
      quarter: () => state.setSnapDivision("1/4"),
      sixteenth: () => state.setSnapDivision("1/16"),
      triplet: () => state.setSnapTriplet(true),
      auto: () => state.setSnapAuto(true),
    };
    operations[next]();
  }, operation);
}

async function seedTwoTakeRows(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = (window as GridWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    const state = store.getState();
    const keys = state.snapshot?.tracks.find((track) => track.name === "Keys");
    if (!keys) throw new Error("the Live e2e seed has no Keys track");
    await state.exec("arm_track", { trackId: keys.id, armed: true });
    await state.exec("set_transport", { action: "record" });
    await state.exec("stop_recording", {});
    await state.exec("set_transport", { action: "record" });
    await state.exec("stop_recording", {});
  });
}

async function startEmptyProject(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = (window as GridWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    await store.getState().exec("new_project", { name: "live-grid-zero-track" });
  });
}

test("bug: arrangement grid vanishes across normal lanes, take rows, filler, and the zero-track viewport", async ({ page }) => {
  await bootLive(page);

  const timeline = page.getByTestId("live-timeline");
  const normalLanes = page.getByTestId("live-lane");
  await expect(normalLanes).toHaveCount(3);

  // Given the stock three-track session, the grid is one continuous, positioned
  // paint primitive rather than three per-lane CSS backgrounds.
  const grid = page.getByTestId("live-arrangement-grid");
  await expect(grid).toHaveCount(1);
  await expect(grid).toHaveAttribute("aria-hidden", "true");

  // When the map says 120 BPM / 4-4 at 80 px/s, Then bar 3 (4 seconds) lands at
  // exactly 320 px in the grid's own coordinate space and spans its whole height.
  const pxPerSec = await page.evaluate(() => {
    const store = (window as GridWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    return store.getState().pxPerSec;
  });
  const barAtFourSeconds = grid.locator('[data-testid="live-grid-line"][data-grid-kind="bar"][data-grid-seconds="4"]');
  await expect(barAtFourSeconds).toHaveCount(1);
  const gridBox = await grid.boundingBox();
  const barBox = await barAtFourSeconds.boundingBox();
  expect(gridBox, "the grid primitive must have visible geometry").not.toBeNull();
  expect(barBox, "the mapped bar line must have visible geometry").not.toBeNull();
  if (!gridBox || !barBox) throw new Error("the positioned grid geometry is unavailable");
  expect(barBox.x - gridBox.x).toBeCloseTo(4 * pxPerSec, 1);
  expect(barBox.y).toBeCloseTo(gridBox.y, 1);
  expect(barBox.height).toBeCloseTo(gridBox.height, 1);

  // Given two recorded takes, When take rows expand, Then the same primitive reaches
  // below them and through the remaining viewport filler.
  await seedTwoTakeRows(page);
  const takeRows = page.getByTestId("live-takerow");
  await expect(takeRows).toHaveCount(2);
  const takeRowsBox = await takeRows.last().boundingBox();
  const timelineViewport = await timeline.evaluate((element) => ({
    height: element.clientHeight,
  }));
  const expandedGridBox = await grid.boundingBox();
  expect(takeRowsBox).not.toBeNull();
  expect(expandedGridBox).not.toBeNull();
  if (!takeRowsBox || !expandedGridBox) throw new Error("the expanded grid geometry is unavailable");
  expect(expandedGridBox.y + expandedGridBox.height).toBeGreaterThanOrEqual(takeRowsBox.y + takeRowsBox.height);
  expect(expandedGridBox.height).toBeGreaterThanOrEqual(timelineViewport.height);

  // Given a fresh project, When no tracks remain, Then the grid still covers the
  // entire empty timeline rather than disappearing with the final lane.
  await startEmptyProject(page);
  await expect(normalLanes).toHaveCount(0);
  await expect(page.getByText("No tracks yet — add one to start.")).toBeVisible();
  const emptyGridBox = await grid.boundingBox();
  const emptyTimelineBox = await timeline.boundingBox();
  const emptyTimelineViewport = await timeline.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
  }));
  expect(emptyGridBox).not.toBeNull();
  expect(emptyTimelineBox).not.toBeNull();
  if (!emptyGridBox || !emptyTimelineBox) throw new Error("the zero-track grid geometry is unavailable");
  expect(emptyGridBox.x).toBeCloseTo(emptyTimelineBox.x, 1);
  expect(emptyGridBox.y).toBeCloseTo(emptyTimelineBox.y, 1);
  expect(emptyGridBox.width).toBeGreaterThanOrEqual(emptyTimelineViewport.width);
  expect(emptyGridBox.height).toBeGreaterThanOrEqual(emptyTimelineViewport.height);
});

test("mapped bars stay aligned with the ruler across fractional tempo, meter, and tempo-map changes", async ({ page }) => {
  await bootLive(page);
  const grid = page.getByTestId("live-arrangement-grid");
  const rulerBars = page.getByTestId("live-ruler").locator(".v2-ruler-bar");

  // Given the stock map, Then the same four-second bar is aligned in both layers.
  const stockGridBar = grid.locator('[data-grid-kind="bar"][data-grid-seconds="4"]');
  const stockGridBox = await stockGridBar.boundingBox();
  const stockRulerBox = await rulerBars.nth(2).boundingBox();
  expect(stockGridBox).not.toBeNull();
  expect(stockRulerBox).not.toBeNull();
  if (!stockGridBox || !stockRulerBox) throw new Error("stock mapped geometry is unavailable");
  expect(Math.abs(stockGridBox.x - stockRulerBox.x)).toBeLessThanOrEqual(1);

  // When tempo is fractional and meter changes through mock MoshOps, Then exact map bars replace CSS repeats.
  await page.evaluate(async () => {
    const store = (window as GridWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    await store.getState().exec("set_tempo", { bpm: 123.456 });
    await store.getState().exec("set_time_signature", { numerator: 5, denominator: 4 });
  });
  const fractionalBar = 5 * 60 / 123.456;
  await expect.poll(async () => Math.min(...(await gridSeconds(page, "bar")).map((sec) => Math.abs(sec - fractionalBar)))).toBeLessThanOrEqual(1e-9);
  const fractionalGridBox = await grid.locator('[data-grid-kind="bar"]').nth(1).boundingBox();
  const fractionalRulerBox = await rulerBars.nth(1).boundingBox();
  expect(fractionalGridBox).not.toBeNull();
  expect(fractionalRulerBox).not.toBeNull();
  if (!fractionalGridBox || !fractionalRulerBox) throw new Error("fractional mapped geometry is unavailable");
  expect(Math.abs(fractionalGridBox.x - fractionalRulerBox.x)).toBeLessThanOrEqual(1);

  // When a 120→240 BPM point lands at four seconds, Then later bars become one second apart.
  await page.evaluate(async () => {
    const store = (window as GridWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    await store.getState().exec("set_time_signature", { numerator: 4, denominator: 4 });
    await store.getState().exec("set_tempo", { bpm: 120 });
    await store.getState().exec("insert_tempo_change", { time: 4, bpm: 240, curve: 1 });
  });
  await expect.poll(async () => (await gridSeconds(page, "bar")).slice(0, 6)).toEqual([0, 2, 4, 5, 6, 7]);
});

test("fixed, adaptive, triplet, zoom, far-scroll, and pointer states repaint the virtual grid", async ({ page }) => {
  await bootLive(page);
  const timeline = page.getByTestId("live-timeline");
  const grid = page.getByTestId("live-arrangement-grid");

  // Given fixed straight divisions, When resolution changes, Then subdivision DOM density changes.
  await withGridStore(page, "quarter");
  await expect.poll(async () => (await gridSeconds(page, "subdivision")).length).toBe(0);
  await withGridStore(page, "sixteenth");
  await expect.poll(async () => (await gridSeconds(page, "subdivision")).length).toBeGreaterThan(0);
  const straight = await gridSeconds(page, "subdivision");
  await withGridStore(page, "triplet");
  await expect.poll(async () => (await gridSeconds(page, "subdivision")).join(",")).not.toBe(straight.join(","));

  // Given adaptive mode, When zoom hits both clamps, Then the resolved division and DOM follow it.
  await withGridStore(page, "auto");
  await withGridStore(page, "minZoom");
  await expect.poll(() => page.evaluate(() => (window as GridWindow).__moshStore?.getState().effectiveSnapDivision())).toBe("bar");
  await expect.poll(async () => (await gridSeconds(page, "subdivision")).length).toBe(0);
  await withGridStore(page, "maxZoom");
  await expect.poll(() => page.evaluate(() => (window as GridWindow).__moshStore?.getState().effectiveSnapDivision())).toBe("1/32");
  await expect.poll(async () => (await gridSeconds(page, "subdivision")).length).toBeGreaterThan(0);

  // When the owner scroller jumps to the far right, Then virtualization covers the visible viewport.
  await timeline.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => {
    const timelineBox = await timeline.boundingBox();
    const lineBoxes = await grid.locator('[data-grid-kind="bar"], [data-grid-kind="beat"], [data-grid-kind="subdivision"]').evaluateAll((lines) =>
      lines.map((line) => line.getBoundingClientRect().x),
    );
    return !!timelineBox && lineBoxes.some((x) => x >= timelineBox.x && x <= timelineBox.x + timelineBox.width);
  }).toBe(true);

  // Then the visual layer and its children remain pointer-transparent.
  const pointerState = await grid.evaluate((element) => {
    const line = element.querySelector<HTMLElement>('[data-testid="live-grid-line"]');
    return {
      grid: getComputedStyle(element).pointerEvents,
      line: line ? getComputedStyle(line).pointerEvents : "missing",
      focusable: element.querySelectorAll("button, a, input, [tabindex]").length,
    };
  });
  expect(pointerState).toEqual({ grid: "none", line: "none", focusable: 0 });
});
