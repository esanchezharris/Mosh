import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";
import { bootLive, bootProTools } from "./helpers";

type CommandTrace = { command: string; args: Record<string, unknown> };
type EditorWindow = Window & {
  __moshStore: {
    getState: () => {
      snapshot: Snapshot;
      editingClipId: string | null;
      pianoRollBeatPx: number;
    };
  };
  __moshCmdTrace?: CommandTrace[];
};

async function openLiveEditor(page: Page): Promise<void> {
  await page.locator('.live-shell [data-testid="v2-clip"]').first().dblclick();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
}

async function openProToolsEditor(page: Page): Promise<void> {
  await page.getByTestId("pt-clip-list-item").filter({ hasText: "loop" }).click();
  await expect(page.locator(".pt-midi-editor-main .pr")).toBeVisible();
}

const shells: ReadonlyArray<{
  name: string;
  boot: (page: Page) => Promise<void>;
  open: (page: Page) => Promise<void>;
}> = [
  { name: "Live shell", boot: bootLive, open: openLiveEditor },
  { name: "Pro Tools shell", boot: bootProTools, open: openProToolsEditor },
];

for (const shell of shells) {
  test(`${shell.name}: adaptive snap lines and both resize edges share one interaction surface`, async ({ page }) => {
    await shell.boot(page);
    await shell.open(page);

    const barLine = page.locator('.pr-gl[data-grid-beat="0"]');
    const halfBeatLine = page.locator('.pr-gl[data-grid-beat="0.5"]');
    await expect(barLine).toBeVisible();
    await expect(halfBeatLine).toBeVisible();
    await expect(halfBeatLine).toHaveAttribute("data-grid-kind", "subdivision");

    const [barBox, halfBox, beatPx] = await Promise.all([
      barLine.boundingBox(),
      halfBeatLine.boundingBox(),
      page.evaluate(() => (window as unknown as EditorWindow).__moshStore.getState().pianoRollBeatPx),
    ]);
    if (!barBox || !halfBox) throw new Error("adaptive grid lines have no browser geometry");
    expect(halfBox.x - barBox.x).toBeCloseTo(beatPx / 2, 1);

    const target = await page.evaluate(() => {
      const state = (window as unknown as EditorWindow).__moshStore.getState();
      const clip = state.snapshot.tracks.flatMap((track) => track.clips)
        .find((candidate) => candidate.id === state.editingClipId);
      const notes = clip?.notes ?? [];
      const ordinal = notes.findIndex((note) => note.start >= 0.5);
      const note = ordinal >= 0 ? notes[ordinal] : undefined;
      if (!note) throw new Error("no resizable note starts after beat zero");
      return { ordinal, start: note.start, length: note.length };
    });

    const note = page.getByTestId("pr-note").nth(target.ordinal);
    const startGrip = note.locator(".pr-note-grip-start");
    const endGrip = note.locator(".pr-note-grip-end");
    await expect(startGrip).toBeVisible();
    await expect(endGrip).toBeVisible();
    expect(await startGrip.evaluate((element) => getComputedStyle(element).cursor)).toBe("ew-resize");
    expect(await endGrip.evaluate((element) => getComputedStyle(element).cursor)).toBe("ew-resize");

    const traceStart = await page.evaluate(() => (window as unknown as EditorWindow).__moshCmdTrace?.length ?? 0);
    await startGrip.hover();
    const gripBox = await startGrip.boundingBox();
    if (!gripBox) throw new Error("left resize grip has no browser geometry");
    const x = gripBox.x + Math.min(1.5, gripBox.width / 4);
    const y = gripBox.y + gripBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - beatPx / 2, y, { steps: 6 });
    await page.mouse.up();

    await expect.poll(() => page.evaluate((from) => {
      const trace = (window as unknown as EditorWindow).__moshCmdTrace ?? [];
      return trace.slice(from).find((entry) => entry.command === "set_note")?.args ?? null;
    }, traceStart)).not.toBeNull();
    const args = await page.evaluate((from) => {
      const trace = (window as unknown as EditorWindow).__moshCmdTrace ?? [];
      return trace.slice(from).find((entry) => entry.command === "set_note")?.args;
    }, traceStart);
    expect(Number(args?.start)).toBeCloseTo(target.start - 0.5, 6);
    expect(Number(args?.length)).toBeCloseTo(target.length + 0.5, 6);
  });
}
