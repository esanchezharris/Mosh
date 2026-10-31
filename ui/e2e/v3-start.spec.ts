import { test, expect, type Page } from "@playwright/test";
import { bootV3, bootV3Start } from "./helpers";

// The V3 Start page (StartPage.tsx): the friends-first way in. Beat → voice → phone →
// record, against the in-memory mock (bridge.mock.ts) on a fresh-install session
// (?mockSeed=fresh: no tracks, headphones). Failure paths live in v3-start-failures.spec.

type Snap = {
  session: { tempo: number };
  tracks: { id: string; name: string; armed?: boolean; monitor?: string;
    clips: { id: string; type: string; start: number; length: number }[];
    plugins?: { index: number; type: string; preset?: { id: string } }[] }[];
  transport: { loopStart: number; loopEnd: number; looping: boolean };
  loop?: { engaged: boolean; leadTrackId?: string; takesTrackId?: string };
};
const snap = (page: Page): Promise<Snap> =>
  page.evaluate(() => (window as unknown as { __moshStore: { getState: () => { snapshot: unknown } } }).__moshStore.getState().snapshot) as Promise<Snap>;
const step = (page: Page) => page.getByTestId("v3-start");
const presetIds = (t: Snap["tracks"][number] | undefined) => (t?.plugins ?? []).filter((p) => p.preset).map((p) => p.preset!.id);

async function startNewSong(page: Page) {
  await page.getByTestId("v3-start-new").click();
  await expect(step(page)).toHaveAttribute("data-step", "beat");
}

async function chooseBeatAndConfirm(page: Page) {
  await page.getByTestId("v3-start-choose").click();
  await expect(page.getByTestId("v3-start-tempo-line")).toContainText("88");
  await page.getByTestId("v3-start-bpm-confirm").click();
  await expect(page.getByTestId("v3-start-beat-next")).toBeVisible();
}

test("a fresh install opens on the Start page, with nothing to continue", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await expect(step(page)).toHaveAttribute("data-step", "welcome");
  await expect(page.getByTestId("v3-start-new")).toBeEnabled();
  await expect(page.getByTestId("v3-start-continue")).toHaveCount(0);
  // The workspace is not on screen behind it.
  await expect(page.getByTestId("v3-arrangement")).toHaveCount(0);
  await expect(page.getByTestId("v3-start-trigger")).toHaveAttribute("aria-pressed", "true");
});

test("new song → beat at bar 1 on Backing, tempo detected and confirmed → Clean Lead → the Booth", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await startNewSong(page);

  // The song: Backing, Vocal, and its Takes lane, Clean Lead on both vocal lanes.
  let s = await snap(page);
  const names = s.tracks.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["Backing", "Vocal", "Vocal · Takes"]));
  const lead = s.tracks.find((t) => t.id === s.loop?.leadTrackId);
  const takes = s.tracks.find((t) => t.id === s.loop?.takesTrackId);
  expect(s.loop?.engaged).toBe(true);
  expect(lead?.name).toBe("Vocal");
  expect(new Set(presetIds(lead))).toEqual(new Set(["mosh.clean-lead"]));
  expect(new Set(presetIds(takes))).toEqual(new Set(["mosh.clean-lead"]));

  // The beat: chosen, detected (the fixture's name carries no BPM), confirmed.
  await chooseBeatAndConfirm(page);
  s = await snap(page);
  const backing = s.tracks.find((t) => t.name === "Backing")!;
  expect(backing.clips).toHaveLength(1);
  const clip = backing.clips[0];
  expect(clip.start).toBe(0);
  expect(s.session.tempo).toBe(88);
  expect(s.transport.loopStart).toBeCloseTo(0, 3);
  expect(s.transport.loopEnd).toBeCloseTo(clip.start + clip.length, 3);
  // Never on the vocal lanes.
  expect(s.tracks.find((t) => t.name === "Vocal")!.clips).toHaveLength(0);
  await expect(page.getByTestId("v3-start-pip-beat")).toHaveAttribute("data-state", "current");

  // Voice: ready on headphones with Clean Lead.
  await page.getByTestId("v3-start-beat-next").click();
  await expect(step(page)).toHaveAttribute("data-step", "voice");
  await expect(page.getByTestId("v3-start-pip-beat")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("v3-start-clean")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("v3-start-ready")).toHaveText("I'm ready");
  await page.getByTestId("v3-start-ready").click();

  // The ready moment, then the Booth.
  await expect(page.getByTestId("v3-start-ready-card")).toBeVisible();
  await page.getByTestId("v3-start-go-booth").click();
  await expect(page.getByTestId("v3-booth")).toBeVisible();
  await expect(page.getByTestId("v3-loop-record")).toBeEnabled();
  await expect(page.getByTestId("v3-booth-take-count")).toHaveText("No takes yet");
});

test("Tuned Lead with a key replaces Clean Lead on both lanes as one chain each", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await startNewSong(page);
  await page.getByTestId("v3-start-skip-beat").click();
  await expect(step(page)).toHaveAttribute("data-step", "voice");

  await page.getByTestId("v3-start-tuned").click();
  await page.getByTestId("v3-start-key-root").selectOption("A");
  await page.getByTestId("v3-start-key-scale").selectOption("Minor");
  await page.getByTestId("v3-start-tuned-apply").click();
  await expect(page.getByTestId("v3-start-tuned")).toHaveAttribute("aria-checked", "true");

  const s = await snap(page);
  for (const id of [s.loop?.leadTrackId, s.loop?.takesTrackId]) {
    const t = s.tracks.find((x) => x.id === id);
    expect(presetIds(t).every((p) => p === "mosh.tuned-lead")).toBe(true);
    expect(presetIds(t)).toHaveLength(3);
    expect((t?.plugins ?? []).filter((p) => p.type === "moshAutoTune")).toHaveLength(1);
  }
  await expect(page.getByTestId("v3-start-ready")).toHaveText("I'm ready");

  // And back to Clean: the tuned stages go, the clean ones come.
  await page.getByTestId("v3-start-clean").click();
  await expect(page.getByTestId("v3-start-clean")).toHaveAttribute("aria-checked", "true");
  const back = await snap(page);
  const lead = back.tracks.find((x) => x.id === back.loop?.leadTrackId);
  expect(presetIds(lead).every((p) => p === "mosh.clean-lead")).toBe(true);
  expect((lead?.plugins ?? []).some((p) => p.type === "moshAutoTune")).toBe(false);
});

test("a second beat replaces the first instead of stacking on it", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await startNewSong(page);
  await page.getByTestId("v3-start-choose").click();
  await expect(page.getByTestId("v3-start-tempo-line")).toContainText("88");
  await page.getByTestId("v3-start-choose").click();
  await expect(page.getByTestId("v3-start-tempo-line")).toContainText("88");
  const s = await snap(page);
  expect(s.tracks.find((t) => t.name === "Backing")!.clips).toHaveLength(1);
});

test("÷2 and ×2 nudge the proposed tempo", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await startNewSong(page);
  await page.getByTestId("v3-start-choose").click();
  const bpm = page.getByTestId("v3-start-bpm");
  await expect(bpm).toHaveValue("88");
  await page.getByTestId("v3-start-bpm-half").click();
  await expect(bpm).toHaveValue("44");
  await page.getByTestId("v3-start-bpm-double").click();
  await expect(bpm).toHaveValue("88");
});

test("a dropped file that isn't audio is refused with a plain sentence", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await startNewSong(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "lyrics.txt", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("v3-start-note")).toContainText("isn't an audio file");
  const s = await snap(page);
  expect(s.tracks.find((t) => t.name === "Backing")!.clips).toHaveLength(0);
});

test("a dropped audio file lands on Backing at bar 1", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await startNewSong(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])], "my beat.wav", { type: "audio/wav" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("v3-start-tempo")).toBeVisible();
  const s = await snap(page);
  const backing = s.tracks.find((t) => t.name === "Backing")!;
  expect(backing.clips).toHaveLength(1);
  expect(backing.clips[0].start).toBe(0);
  expect(s.tracks.find((t) => t.name === "Vocal")!.clips).toHaveLength(0);
});

test("the drum-beat fallback needs no file", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await startNewSong(page);
  await page.getByTestId("v3-start-drum-beat").click();
  await expect(page.getByTestId("v3-start-beat-next")).toBeVisible();
  await page.getByTestId("v3-start-beat-next").click();
  await expect(step(page)).toHaveAttribute("data-step", "voice");
});

test("unticking 'Show this when Mosh opens' survives a reload and lands on the workspace", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await page.getByTestId("v3-start-on-launch").uncheck();
  await page.reload();
  await expect(page.getByTestId("v3-shell")).toBeVisible();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await expect(page.getByTestId("v3-start")).toHaveCount(0);
  // ...and the Start button still reaches it.
  await page.getByTestId("v3-start-trigger").click();
  await expect(page.getByTestId("v3-start")).toBeVisible();
});

test("the TopBar Start button and File › Templates both reach the page from the workspace", async ({ page }) => {
  await bootV3(page);
  await expect(page.getByTestId("v3-start")).toHaveCount(0);
  await page.getByTestId("v3-start-trigger").click();
  await expect(page.getByTestId("v3-start")).toBeVisible();
  // With tracks in the session it offers to continue.
  await expect(page.getByTestId("v3-start-continue")).toBeVisible();
  await page.getByTestId("v3-start-studio").click();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-templates").hover();
  await page.getByTestId("v3-template-start").click();
  await expect(page.getByTestId("v3-start")).toBeVisible();
});

test("the Booth's ← Start comes back to the song where it stands", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await startNewSong(page);
  await chooseBeatAndConfirm(page);
  await page.getByTestId("v3-start-beat-next").click();
  await page.getByTestId("v3-start-go-anyway").click();
  await expect(page.getByTestId("v3-booth")).toBeVisible();
  await page.getByTestId("v3-booth-start").click();
  await expect(step(page)).toHaveAttribute("data-step", "ready");
});

test("the phone step shows the code, counts down, and Skip goes to the Booth", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await startNewSong(page);
  await page.getByTestId("v3-start-skip-beat").click();
  await page.getByTestId("v3-start-ready").click();
  await page.getByTestId("v3-start-add-phone").click();
  await expect(step(page)).toHaveAttribute("data-step", "phone");
  await page.getByTestId("v3-start-show-code").click();
  await expect(page.getByTestId("v3-start-qr")).toBeVisible();
  await expect(page.getByTestId("v3-start-pad-url")).toContainText("/pad#token=");
  await expect(page.getByTestId("v3-start-pair-ttl")).toContainText("Code valid for");
  await page.getByTestId("v3-start-skip-phone").click();
  await expect(page.getByTestId("v3-booth")).toBeVisible();
});
