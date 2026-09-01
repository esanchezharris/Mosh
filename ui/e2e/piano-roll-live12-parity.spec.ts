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
  test(`${shell.name}: marquee selection is visible and Shift+Right lengthens notes`, async ({ page }) => {
    await shell.boot(page);
    await shell.open(page);

    const ordinal = 2;
    const note = page.getByTestId("pr-note").nth(ordinal);
    const before = await note.boundingBox();
    if (!before) throw new Error("marquee target has no browser geometry");
    const normalBackground = await note.evaluate((element) => getComputedStyle(element).backgroundColor);
    const original = await page.evaluate((noteOrdinal) => {
      const state = (window as unknown as EditorWindow).__moshStore.getState();
      const clip = state.snapshot.tracks.flatMap((track) => track.clips)
        .find((candidate) => candidate.id === state.editingClipId);
      const target = clip?.notes?.[noteOrdinal];
      if (!target) throw new Error("marquee target has no MIDI note");
      return { start: target.start, length: target.length };
    }, ordinal);

    await page.mouse.move(before.x - 3, before.y - 3);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width + 3, before.y + before.height + 3, { steps: 6 });
    await page.mouse.up();

    await expect(note).toHaveClass(/\bsel\b/);
    await expect(note).toHaveAttribute("aria-pressed", "true");
    const selectedCue = await note.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    const normalChannels = normalBackground.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    const selectedChannels = selectedCue.backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    const colorDistance = selectedChannels.reduce(
      (total, channel, index) => total + Math.abs(channel - (normalChannels[index] ?? channel)),
      0,
    );
    expect(colorDistance).toBeGreaterThan(80);
    expect(selectedCue).toMatchObject({ outlineStyle: "solid", outlineWidth: "2px" });

    const traceStart = await page.evaluate(() => (window as unknown as EditorWindow).__moshCmdTrace?.length ?? 0);
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => page.evaluate((from) => {
      const trace = (window as unknown as EditorWindow).__moshCmdTrace ?? [];
      return trace.slice(from).find((entry) => entry.command === "set_note")?.args ?? null;
    }, traceStart)).not.toBeNull();
    const command = await page.evaluate((from) => {
      const trace = (window as unknown as EditorWindow).__moshCmdTrace ?? [];
      return trace.slice(from).find((entry) => entry.command === "set_note")?.args;
    }, traceStart);
    expect(Number(command?.start ?? original.start)).toBe(original.start);
    expect(Number(command?.length)).toBeGreaterThan(original.length);
  });

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
    const grid = page.locator(".pr-grid");
    await expect(startGrip).toBeVisible();
    await expect(endGrip).toBeVisible();

    await note.hover();
    await expect(grid).toHaveCSS("cursor", "grab");
    await startGrip.hover();
    await expect(grid).toHaveCSS("cursor", "ew-resize");
    expect(await startGrip.evaluate((element) => getComputedStyle(element).cursor)).toBe("ew-resize");
    await endGrip.hover();
    await expect(grid).toHaveCSS("cursor", "ew-resize");
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

  test(`${shell.name}: active note gestures stay under the pointer while the editor scrolls`, async ({ page }) => {
    await shell.boot(page);
    await shell.open(page);

    const target = await page.evaluate(() => {
      const state = (window as unknown as EditorWindow).__moshStore.getState();
      const clip = state.snapshot.tracks.flatMap((track) => track.clips)
        .find((candidate) => candidate.id === state.editingClipId);
      const notes = clip?.notes ?? [];
      const boxes = [...document.querySelectorAll<HTMLElement>('[data-testid="pr-note"]')]
        .map((element, ordinal) => ({ ordinal, width: element.getBoundingClientRect().width }));
      const ordinal = boxes.sort((a, b) => b.width - a.width)[0]?.ordinal ?? -1;
      const note = notes[ordinal];
      if (!note) throw new Error("no note is available for drag-scroll testing");
      return { ordinal, pitch: note.pitch };
    });

    const note = page.getByTestId("pr-note").nth(target.ordinal);
    await note.scrollIntoViewIfNeeded();
    const before = await note.boundingBox();
    if (!before) throw new Error("drag target has no browser geometry");
    const pointer = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    const hitClass = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className ?? "", pointer);
    expect(hitClass).toContain("pr-note");
    expect(hitClass).not.toContain("pr-note-grip");
    const traceStart = await page.evaluate(() => (window as unknown as EditorWindow).__moshCmdTrace?.length ?? 0);

    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    const scrollDelta = await page.locator(".pr-scroll").evaluate((element) => {
      const scroller = element as HTMLElement;
      const down = Math.min(30, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
      const delta = down >= 15 ? down : -Math.min(30, scroller.scrollTop);
      scroller.scrollTop += delta;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      return delta;
    });
    expect(Math.abs(scrollDelta)).toBeGreaterThanOrEqual(15);

    await expect.poll(async () => (await note.boundingBox())?.y ?? Number.NaN)
      .toBeCloseTo(before.y, 0);
    await page.mouse.up();

    await expect.poll(() => page.evaluate((from) => {
      const trace = (window as unknown as EditorWindow).__moshCmdTrace ?? [];
      return trace.slice(from).find((entry) => entry.command === "set_note")?.args ?? null;
    }, traceStart)).not.toBeNull();
    const args = await page.evaluate((from) => {
      const trace = (window as unknown as EditorWindow).__moshCmdTrace ?? [];
      return trace.slice(from).find((entry) => entry.command === "set_note")?.args;
    }, traceStart);
    expect(Number(args?.pitch)).toBe(target.pitch - Math.round(scrollDelta / 15));
  });

  test(`${shell.name}: selection follows one note across backend reindexing and Undo`, async ({ page }) => {
    await shell.boot(page);
    await shell.open(page);

    const original = await page.evaluate(() => {
      const state = (window as unknown as EditorWindow).__moshStore.getState();
      const clip = state.snapshot.tracks.flatMap((track) => track.clips)
        .find((candidate) => candidate.id === state.editingClipId);
      const notes = (clip?.notes ?? []).map((note) => ({ ...note }));
      if (notes.length < 3) throw new Error("reindex regression needs three MIDI notes");
      let targetOrdinal = -1;
      let destination = -1;
      for (let ordinal = 0; ordinal < notes.length && targetOrdinal < 0; ordinal += 1) {
        const target = notes[ordinal];
        for (let start = Math.ceil(target.start + 1); start <= 7; start += 1) {
          const crossesBoundary = notes.some((candidate) =>
            candidate.start > target.start && candidate.start < start);
          const samePitchCollision = notes.some((candidate, index) => index !== ordinal
            && candidate.pitch === target.pitch
            && candidate.start < start + target.length
            && candidate.start + candidate.length > start);
          if (crossesBoundary && !samePitchCollision) {
            targetOrdinal = ordinal;
            destination = start;
            break;
          }
        }
      }
      if (targetOrdinal < 0) throw new Error("reindex regression needs a collision-free sorting move");
      const companions = notes.map((_, ordinal) => ordinal)
        .filter((ordinal) => ordinal !== targetOrdinal).slice(0, 2);
      return { notes, targetOrdinal, companions, destination };
    });
    const notes = page.getByTestId("pr-note");
    await notes.nth(original.targetOrdinal).click();
    await notes.nth(original.companions[0]).click({ modifiers: ["Shift"] });
    await notes.nth(original.companions[1]).click({ modifiers: ["Shift"] });
    await expect(page.locator(".pr-note.sel")).toHaveCount(3);

    await notes.nth(original.targetOrdinal).click();
    await expect(page.locator(".pr-note.sel")).toHaveCount(1);
    const before = await notes.nth(original.targetOrdinal).boundingBox();
    if (!before) throw new Error("reindex drag target has no browser geometry");
    const beatPx = await page.evaluate(() =>
      (window as unknown as EditorWindow).__moshStore.getState().pianoRollBeatPx);
    const target = original.notes[original.targetOrdinal];
    const deltaBeats = original.destination - target.start;
    const x = before.x + before.width / 2;
    const y = before.y + before.height / 2;
    const traceStart = await page.evaluate(() =>
      (window as unknown as EditorWindow).__moshCmdTrace?.length ?? 0);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + deltaBeats * beatPx, y, { steps: 10 });
    await page.mouse.up();

    await expect.poll(() => page.evaluate((from) => {
      const trace = (window as unknown as EditorWindow).__moshCmdTrace ?? [];
      return trace.slice(from).filter((entry) => entry.command === "set_note").length;
    }, traceStart)).toBe(1);
    const moved = await page.evaluate(() => {
      const state = (window as unknown as EditorWindow).__moshStore.getState();
      const clip = state.snapshot.tracks.flatMap((track) => track.clips)
        .find((candidate) => candidate.id === state.editingClipId);
      return clip?.notes ?? [];
    });
    const signature = (note: typeof target) =>
      `${note.pitch}|${note.start}|${note.length}|${note.velocity}|${Boolean(note.mute)}`;
    const expectedMoved = { ...target, start: original.destination };
    expect(moved.map(signature)).toContain(signature(expectedMoved));
    const withoutOne = (values: string[], value: string) => {
      const remaining = [...values];
      const index = remaining.indexOf(value);
      if (index < 0) throw new Error(`missing note identity ${value}`);
      remaining.splice(index, 1);
      return remaining.sort();
    };
    const untouchedBefore = withoutOne(original.notes.map(signature), signature(target));
    const untouchedAfter = withoutOne(moved.map(signature), signature(expectedMoved));
    expect(untouchedAfter).toEqual(untouchedBefore);
    await expect(page.locator(".pr-note.sel")).toHaveCount(1);
    await expect(page.locator(".pr-note.sel")).toHaveAttribute(
      "aria-label",
      new RegExp(`note start ${original.destination.toFixed(2)}`),
    );
    await expect(page.locator(".pr-note.sel")).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Meta+z");
    await expect.poll(() => page.evaluate(({ pitch, start }) => {
      const state = (window as unknown as EditorWindow).__moshStore.getState();
      const clip = state.snapshot.tracks.flatMap((track) => track.clips)
        .find((candidate) => candidate.id === state.editingClipId);
      return clip?.notes?.find((note) => note.pitch === pitch)?.start === start;
    }, { pitch: target.pitch, start: target.start })).toBe(true);
  });
}
