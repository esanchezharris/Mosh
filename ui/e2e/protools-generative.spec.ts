import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";
import { bootProTools } from "./helpers";

type GenerativeWindow = Window & {
  __moshStore?: {
    getState: () => {
      snapshot: Snapshot | null;
      select: (clipIds: string[]) => void;
      setSelectedTrack: (trackId: string | null) => void;
    };
  };
  __moshCmdTrace?: Array<{
    command: string;
    args: Record<string, unknown>;
    ok: boolean;
  }>;
};

async function selectWaveClip(page: Page): Promise<{ clipId: string; trackId: string; name: string }> {
  return page.evaluate(() => {
    const store = (window as GenerativeWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    const state = store.getState();
    const match = state.snapshot?.tracks.flatMap((track) =>
      track.clips.map((clip) => ({ clip, track })),
    ).find(({ clip }) => clip.type === "wave" && !clip.hidden);
    if (!match) throw new Error("the mock project has no visible wave clip");
    state.select([match.clip.id]);
    state.setSelectedTrack(match.track.id);
    return { clipId: match.clip.id, trackId: match.track.id, name: match.clip.name };
  });
}

test("Pro Tools directly generates and keeps an explicitly labelled deterministic fixture", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const target = await selectWaveClip(page);
  const trigger = page.getByTestId("pt-open-generative");
  await trigger.click();
  const drawer = page.getByTestId("pt-generative-drawer");
  await expect(drawer).toContainText(target.name);
  await expect(drawer.getByTestId("gen-prompt")).toBeFocused();
  await drawer.getByTestId("gen-prompt").fill("A sustained synthesizer tone.");
  await drawer.getByTestId("gen-nl").fill("65");
  await drawer.getByTestId("gen-seed-input").fill("0");
  await drawer.getByTestId("gen-render").click();
  await expect(drawer.getByTestId("gen-accept")).toBeEnabled();
  await expect(drawer.getByTestId("engine-badge")).toHaveText("Test fixture");
  await expect(drawer.getByTestId("gen-result")).toHaveAttribute("aria-pressed", "false");
  await drawer.getByTestId("gen-result").click();
  await expect(drawer.getByTestId("gen-result")).toHaveAttribute("aria-pressed", "true");
  await drawer.getByTestId("gen-source").click();
  await expect(drawer.getByTestId("gen-source")).toHaveAttribute("aria-pressed", "true");
  await drawer.getByTestId("gen-accept").click();
  await expect(drawer.getByTestId("gen-accept")).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("protools-direct-reimagine-wide.png") });

  const trace = await page.evaluate(() => (window as GenerativeWindow).__moshCmdTrace ?? []);
  for (const [command, args] of [
    ["create_render_layer", { clipId: target.clipId, decisionPolicy: "explicit", adapter: "stable_audio3", mode: "reimagine", modelVariant: "sa3-medium" }],
    ["set_render_param", { clipId: target.clipId, prompt: "A sustained synthesizer tone.", nl: 0.3285, seed: 0 }],
    ["render_layer", { clipId: target.clipId }],
    ["bypass_layer", { clipId: target.clipId, audition: "result" }],
    ["bypass_layer", { clipId: target.clipId, audition: "source" }],
    ["accept_render", { clipId: target.clipId }],
  ] as const) {
    expect(trace).toContainEqual(expect.objectContaining({ command, args, ok: true }));
  }
  expect(trace.some((entry) => entry.command === "compile_render")).toBe(false);
  await drawer.getByTestId("pt-generative-close").click();
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("the Re-imagine trigger and drawer remain reachable in compact reduced-motion mode", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await bootProTools(page);
  await selectWaveClip(page);

  const trigger = page.getByTestId("pt-open-generative");
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger).toBeVisible();
  await trigger.click();
  const drawer = page.getByTestId("pt-generative-drawer");
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  if (!box) throw new Error("compact generative drawer has no bounds");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(720);
  await expect(drawer.getByTestId("gen-render")).toBeVisible();
  await expect(drawer.getByTestId("pt-generative-close")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("protools-generative-compact.png") });
});
