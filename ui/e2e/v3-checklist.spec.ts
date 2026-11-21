import { test, expect, type Page } from "@playwright/test";
import { bootV3, bootV3Start } from "./helpers";

// The friends-first first launch (StartChecklist.tsx + RecordingSetup.tsx): Mosh opens into
// the regular workspace with the recording template already made (Beat, Lead vocal,
// Ad-libs) and a small checklist over it: beat, voice, phone. Against the in-memory mock
// (bridge.mock.ts) on a fresh-install session (?mockSeed=fresh: no tracks, headphones).
// The Booth is never shown. Failure paths live in v3-checklist-failures.spec.

type Snap = {
  session: { tempo: number };
  tracks: { id: string; name: string; armed?: boolean; monitor?: string;
    clips: { id: string; type: string; start: number; length: number }[];
    plugins?: { index: number; type: string; preset?: { id: string } }[] }[];
  transport: { loopStart: number; loopEnd: number; looping: boolean };
  loop?: { engaged: boolean; leadTrackId?: string; takesTrackId?: string; phoneConnected?: boolean };
};
const snap = (page: Page): Promise<Snap> =>
  page.evaluate(() => (window as unknown as { __moshStore: { getState: () => { snapshot: unknown } } }).__moshStore.getState().snapshot) as Promise<Snap>;
const list = (page: Page) => page.getByTestId("v3-checklist");
const item = (page: Page, key: "beat" | "voice" | "phone") => page.getByTestId(`v3-check-item-${key}`);
const presetIds = (t: Snap["tracks"][number] | undefined) => (t?.plugins ?? []).filter((p) => p.preset).map((p) => p.preset!.id);
const named = (s: Snap, name: string) => s.tracks.find((t) => t.name === name);
const noBooth = (page: Page) => expect(page.getByTestId("v3-booth")).toHaveCount(0);

test("a fresh install opens into the workspace with the recording song and the checklist, never the Booth", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await expect(page.getByTestId("v3-shell")).toHaveAttribute("data-posture", "studio");
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await expect(list(page)).toHaveAttribute("data-current", "beat");
  await noBooth(page);

  const s = await snap(page);
  expect(s.tracks.map((t) => t.name)).toEqual(["Beat", "Lead vocal", "Lead vocal · Takes", "Ad-libs"]);
  const lead = named(s, "Lead vocal")!;
  // The Takes lane under the Lead is part of the song from the start: it holds the arm and
  // the mic, and carries the Lead's chain so the live voice is tuned.
  const takes = named(s, "Lead vocal · Takes")!;
  expect(takes.armed).toBe(true);
  expect(takes.monitor).toBe("automatic");
  expect(presetIds(takes)).toEqual(["mosh.tuned-lead", "mosh.tuned-lead", "mosh.tuned-lead"]);
  expect(lead.armed).toBeFalsy();
  expect(presetIds(lead)).toEqual(["mosh.tuned-lead", "mosh.tuned-lead", "mosh.tuned-lead"]);
  expect(lead.plugins?.[0]?.type).toBe("moshAutoTune");
  const adlib = named(s, "Ad-libs")!;
  expect(adlib.armed).toBeFalsy();
  expect(presetIds(adlib)).toEqual(["mosh.clean-lead", "mosh.clean-lead"]);
  expect(named(s, "Beat")!.clips).toHaveLength(0);
  // The phone remote's pair is already in place, so a phone that pairs later adds nothing.
  expect(s.loop).toMatchObject({ engaged: true, leadTrackId: lead.id, takesTrackId: takes.id });

  // It is a panel, not a modal: the workspace behind it still takes clicks.
  await expect(page.locator(".scrim")).toHaveCount(0);
  await page.getByTestId("v3-file-trigger").click();
  await expect(page.getByTestId("v3-file-menu")).toBeVisible();
  await expect(page.getByTestId("v3-file-menu")).not.toContainText("Booth");
  await page.keyboard.press("Escape");
  for (const key of ["beat", "voice", "phone"] as const) await expect(item(page, key)).toHaveAttribute("data-state", "todo");
});

test("beat: chosen, tempo detected and confirmed, on the Beat track at bar 1; then the voice opens", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await page.getByTestId("v3-check-choose").click();
  await expect(page.getByTestId("v3-check-tempo-line")).toContainText("88");
  await page.getByTestId("v3-check-bpm-confirm").click();
  await expect(item(page, "beat")).toHaveAttribute("data-state", "done");
  await expect(list(page)).toHaveAttribute("data-current", "voice");

  const s = await snap(page);
  const beat = named(s, "Beat")!;
  expect(beat.clips).toHaveLength(1);
  expect(beat.clips[0].start).toBe(0);
  expect(s.session.tempo).toBe(88);
  expect(s.transport.loopStart).toBeCloseTo(0, 3);
  expect(s.transport.loopEnd).toBeCloseTo(beat.clips[0].start + beat.clips[0].length, 3);
  // Never on the vocal tracks.
  expect(named(s, "Lead vocal")!.clips).toHaveLength(0);
  expect(named(s, "Ad-libs")!.clips).toHaveLength(0);
  await noBooth(page);
});

test("beat: a second beat replaces the first, and ÷2 and ×2 nudge the proposed tempo", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await page.getByTestId("v3-check-choose").click();
  const bpm = page.getByTestId("v3-check-bpm");
  await expect(bpm).toHaveValue("88");
  await page.getByTestId("v3-check-bpm-half").click();
  await expect(bpm).toHaveValue("44");
  await page.getByTestId("v3-check-bpm-double").click();
  await expect(bpm).toHaveValue("88");
  await page.getByTestId("v3-check-choose").click();
  await expect(page.getByTestId("v3-check-tempo-line")).toContainText("88");
  expect(named(await snap(page), "Beat")!.clips).toHaveLength(1);
});

test("beat: a file dropped anywhere on the workspace lands on the Beat track; a non-audio file is refused in plain words", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "lyrics.txt", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("v3-check-note")).toContainText("isn't an audio file");
  expect(named(await snap(page), "Beat")!.clips).toHaveLength(0);

  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])], "my beat.wav", { type: "audio/wav" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("v3-check-tempo")).toBeVisible();
  const s = await snap(page);
  expect(named(s, "Beat")!.clips).toHaveLength(1);
  expect(named(s, "Beat")!.clips[0].start).toBe(0);
  expect(named(s, "Lead vocal")!.clips).toHaveLength(0);
});

test("beat: the drum-beat fallback needs no file", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await page.getByTestId("v3-check-drum-beat").click();
  await expect(item(page, "beat")).toHaveAttribute("data-state", "done");
  await expect(list(page)).toHaveAttribute("data-current", "voice");
});

test("voice: tuned by default on headphones, Sounds right marks it done; Clean and a keyed Tuned switch the Lead's chain", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await item(page, "voice").click();
  await expect(page.getByTestId("v3-check-tuned")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("v3-check-voice-say")).toContainText("tuned");
  await expect(page.getByTestId("v3-check-monitor")).toHaveText("Hear myself: On");

  await page.getByTestId("v3-check-clean").click();
  await expect(page.getByTestId("v3-check-clean")).toHaveAttribute("aria-checked", "true");
  let lead = named(await snap(page), "Lead vocal");
  expect(presetIds(lead)).toEqual(["mosh.clean-lead", "mosh.clean-lead"]);

  await page.getByTestId("v3-check-tuned").click();
  await page.getByTestId("v3-check-key-root").selectOption("A");
  await page.getByTestId("v3-check-key-scale").selectOption("Minor");
  await page.getByTestId("v3-check-tuned-apply").click();
  await expect(page.getByTestId("v3-check-tuned")).toHaveAttribute("aria-checked", "true");
  lead = named(await snap(page), "Lead vocal");
  expect(presetIds(lead)).toEqual(["mosh.tuned-lead", "mosh.tuned-lead", "mosh.tuned-lead"]);
  expect((lead?.plugins ?? []).filter((p) => p.type === "moshAutoTune")).toHaveLength(1);

  await page.getByTestId("v3-check-voice-ok").click();
  await expect(item(page, "voice")).toHaveAttribute("data-state", "done");
  await noBooth(page);
});

test("phone: the code sets the remote up on the Lead vocal with its tuned chain on the Takes track, and stays in the workspace", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  const tracksBefore = (await snap(page)).tracks.map((t) => t.id);
  await item(page, "phone").click();
  await page.getByTestId("v3-check-show-code").click();
  await expect(page.getByTestId("v3-check-qr")).toBeVisible();
  await expect(page.getByTestId("v3-check-pad-url")).toContainText("/pad#token=");
  await expect(page.getByTestId("v3-check-pair-ttl")).toContainText("Code valid for");

  const s = await snap(page);
  const lead = named(s, "Lead vocal")!;
  expect(s.loop?.engaged).toBe(true);
  expect(s.loop?.leadTrackId).toBe(lead.id);
  const takes = s.tracks.find((t) => t.id === s.loop?.takesTrackId)!;
  expect(takes.name).toBe("Lead vocal · Takes");
  expect(presetIds(takes)).toEqual(["mosh.tuned-lead", "mosh.tuned-lead", "mosh.tuned-lead"]);
  expect(takes.armed).toBe(true);
  // Pairing reuses the Takes lane the song started with: no second one.
  expect(s.tracks.map((t) => t.id)).toEqual(tracksBefore);
  expect(s.tracks.filter((t) => t.name.endsWith("· Takes"))).toHaveLength(1);
  await noBooth(page);
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
});

test("the checklist can be dismissed and reopened from the File menu and the Start button; dismissed survives a reload", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await page.getByTestId("v3-check-skip-beat").click();
  await page.getByTestId("v3-check-dismiss").click();
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await expect(page.getByTestId("v3-start-trigger")).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-open-checklist").click();
  await expect(list(page)).toBeVisible();
  await expect(item(page, "beat")).toHaveAttribute("data-state", "skipped");

  await page.getByTestId("v3-check-dismiss").click();
  await page.reload();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  // The song is still made at launch; the checklist stays away.
  await expect.poll(async () => (await snap(page))?.tracks.map((t) => t.name)).toEqual(["Beat", "Lead vocal", "Lead vocal · Takes", "Ad-libs"]);
  await expect(list(page)).toHaveCount(0);
  await noBooth(page);
  await page.getByTestId("v3-start-trigger").click();
  await expect(list(page)).toBeVisible();
  await expect(page.getByTestId("v3-start-trigger")).toHaveAttribute("aria-pressed", "true");
});

test("skipping all three shows You're set, Close puts it away, and it stays away on the next launch", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await page.getByTestId("v3-check-skip-beat").click();
  await page.getByTestId("v3-check-skip-voice").click();
  await page.getByTestId("v3-check-skip-phone").click();
  await expect(page.getByTestId("v3-check-set")).toBeVisible();
  await page.getByTestId("v3-check-close").click();
  await expect(list(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await expect(list(page)).toHaveCount(0);
});

test("unticking 'Set up a song when Mosh opens' survives a reload: a plain empty workspace, and the Start button still offers the song", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  await page.getByTestId("v3-check-on-launch").uncheck();
  await page.reload();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await expect(list(page)).toHaveCount(0);
  expect((await snap(page)).tracks).toHaveLength(0);
  await page.getByTestId("v3-start-trigger").click();
  await expect(list(page)).toBeVisible();
  await page.getByTestId("v3-check-new-song").first().click();
  await expect.poll(async () => (await snap(page)).tracks.map((t) => t.name)).toEqual(["Beat", "Lead vocal", "Lead vocal · Takes", "Ad-libs"]);
  await noBooth(page);
});

test("a session that already has tracks is left alone, and File › New Recording Song makes the song on request", async ({ page }) => {
  await bootV3(page);
  const before = (await snap(page)).tracks.map((t) => t.name);
  expect(before).not.toContain("Lead vocal");
  await expect(list(page)).toHaveCount(0);   // "set up a song when Mosh opens" is off in workspace specs
  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-new-vocal").click();
  await expect.poll(async () => (await snap(page)).tracks.map((t) => t.name)).toEqual(["Beat", "Lead vocal", "Lead vocal · Takes", "Ad-libs"]);
});

test("Hear myself is one click on the armed track, with the checklist closed, and stays in step with the checklist's switch", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh" });
  const row = (name: string) => page.getByTestId("v3-track").filter({ has: page.getByRole("button", { name: `Select track ${name}`, exact: true }) });
  const mic = "Lead vocal · Takes";   // the lane that holds the arm and the mic
  const hear = row(mic).getByTestId("v3-track-hear");
  await expect(hear).toHaveAttribute("aria-pressed", "true");
  // Only a track that is taking the mic has the switch.
  await expect(row("Beat").getByTestId("v3-track-hear")).toHaveCount(0);
  await expect(row("Lead vocal").getByTestId("v3-track-hear")).toHaveCount(0);
  await expect(row("Ad-libs").getByTestId("v3-track-hear")).toHaveCount(0);

  await page.getByTestId("v3-check-dismiss").click();
  await expect(list(page)).toHaveCount(0);
  await hear.click();
  await expect(hear).toHaveAttribute("aria-pressed", "false");
  expect(named(await snap(page), mic)!.monitor).toBe("off");
  expect(named(await snap(page), mic)!.armed).toBe(true);   // still records, just silently

  await hear.click();
  await expect(hear).toHaveAttribute("aria-pressed", "true");
  expect(named(await snap(page), mic)!.monitor).toBe("automatic");

  // The checklist's own switch reads the same state.
  await hear.click();
  await page.getByTestId("v3-start-trigger").click();
  if ((await item(page, "voice").getAttribute("aria-expanded")) !== "true") await item(page, "voice").click();
  await expect(page.getByTestId("v3-check-monitor")).toHaveText("Hear myself: Off");
});
