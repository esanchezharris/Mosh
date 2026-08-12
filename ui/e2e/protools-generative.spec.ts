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

test("Pro Tools exposes the shared SA3 Re-imagine flow without leaving the Edit Window", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const target = await selectWaveClip(page);

  const trigger = page.getByTestId("pt-open-generative");
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.click();

  const drawer = page.getByTestId("pt-generative-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(target.name);
  await expect(drawer.getByTestId("engine-badge")).toHaveText("SA3");
  await expect(drawer.getByTestId("gen-compile-input")).toBeFocused();

  await drawer.getByTestId("gen-create").click();
  await expect(drawer.getByTestId("gen-render")).toBeVisible();
  await drawer.getByTestId("gen-nl").fill("65");
  await expect(drawer.getByTestId("gen-nl")).toHaveValue("65");
  await drawer.getByTestId("color-add").selectOption("grit");
  await expect(drawer).toContainText("grit");
  await drawer.getByTestId("lora-add").selectOption("ken-sa3");
  await expect(drawer.getByTestId("lora-row-ken-sa3")).toBeVisible();
  await drawer.getByTestId("gen-render").click();
  await expect(drawer.getByTestId("render-status")).toHaveText("ready");
  await expect(drawer.getByTestId("gen-reset")).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("protools-generative-wide.png") });

  await drawer.getByTestId("gen-live").click();
  await expect(drawer.getByTestId("gen-live")).toHaveAttribute("aria-pressed", "true");
  await drawer.getByTestId("gen-bypass").click();
  await expect(drawer.getByTestId("gen-bypass")).toHaveAttribute("aria-pressed", "true");
  await drawer.getByTestId("gen-bypass").click();
  await expect(drawer.getByTestId("gen-bypass")).toHaveAttribute("aria-pressed", "false");
  await drawer.getByTestId("gen-freeze").click();
  await expect(drawer.getByTestId("gen-freeze")).toHaveAttribute("aria-pressed", "true");
  await drawer.getByTestId("gen-reset").click();

  const trace = await page.evaluate(() => (window as GenerativeWindow).__moshCmdTrace ?? []);
  expect(trace).toContainEqual(expect.objectContaining({
    command: "create_render_layer",
    args: {
      clipId: target.clipId,
      adapter: "stable_audio3",
      mode: "reimagine",
      modelVariant: "sa3-medium",
    },
    ok: true,
  }));
  expect(trace).toContainEqual(expect.objectContaining({
    command: "render_layer",
    args: { clipId: target.clipId },
    ok: true,
  }));
  expect(trace).toContainEqual(expect.objectContaining({
    command: "set_render_param",
    args: { clipId: target.clipId, nl: 0.3285, lab: false },
    ok: true,
  }));
  expect(trace).toContainEqual(expect.objectContaining({
    command: "set_render_param",
    args: { clipId: target.clipId, colors: [{ name: "grit", value: 65 }], lab: false },
    ok: true,
  }));
  expect(trace).toContainEqual(expect.objectContaining({
    command: "set_render_param",
    args: { clipId: target.clipId, loras: [{ name: "ken-sa3", value: 70 }] },
    ok: true,
  }));
  for (const [command, args] of [
    ["render_ahead_arm", { clipId: target.clipId, armed: true }],
    ["bypass_layer", { clipId: target.clipId, bypassed: true }],
    ["bypass_layer", { clipId: target.clipId, bypassed: false }],
    ["freeze_layer", { clipId: target.clipId }],
    ["reset_render_layer", { clipId: target.clipId }],
  ] as const) {
    expect(trace).toContainEqual(expect.objectContaining({ command, args, ok: true }));
  }

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
  await expect(drawer.getByTestId("gen-create")).toBeVisible();
  await expect(drawer.getByTestId("pt-generative-close")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("protools-generative-compact.png") });
});
