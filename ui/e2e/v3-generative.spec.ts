import { test, expect, type Page } from "@playwright/test";
import { bootV3, expectDispatched } from "./helpers";

// Ports of the generative / AI specs that booted the classic or v2 shell (compile, freeze-layer,
// lora-lab, lora-rack, moshi-dock, producer-loop, rave-insert, reimagine-midi, transform,
// sustain-toggle, training-sources). V3's Re-Imagine is the *direct* drawer (Open Re-Imagine ->
// prompt / amount / seed / LoRAs / Generate, covered by v3-reimagine.spec.ts and v3-lora.spec.ts):
// it has no freeze, transform, describe-it compile box, sustain toggle, MIDI re-imagine or RAVE
// insert. Where V3 has no UI the command still has to stay tested, so those tests drive MoshOps
// through the same store.exec the UI uses and read the result back from the snapshot. Each such
// test is marked NO-V3-UI so the owner can decide whether V3 should grow the control.
//
// Not duplicated here:
//   producer-loop  -> v3-session.spec.ts (File menu, new/save/export, undo), v3-tracks.spec.ts,
//                     v3-drums.spec.ts, v3-plugins.spec.ts, v3-mix.spec.ts, v3-piano-roll.spec.ts
//   lora-lab "Train / Stop" and the Lab opening -> v3-lora.spec.ts
//   lora-rack (kept-LoRA menu, 70 default, 0-200 slider, typed overflow) -> v3-lora.spec.ts

type Layer = {
  id: string; status: string; mode: string; reactive?: boolean; appliedInPlace?: boolean;
  reimagineActive?: boolean; hasOriginal?: boolean; target?: string; strength?: number;
  colors?: { name: string; value: number }[]; loras?: { name: string; value: number }[];
};
type Clip = { id: string; type: string; mute?: boolean; renderLayer?: Layer };
type Plugin = { index: number; rave?: { modelName: string; modelLoaded: boolean } };
type Track = { id: string; clips: Clip[]; plugins?: Plugin[] };
type Result = { ok: boolean; data?: Record<string, unknown>; error?: string };

const exec = (page: Page, command: string, args: Record<string, unknown> = {}) =>
  page.evaluate(({ command, args }) =>
    (window as unknown as { __moshStore: { getState: () => { exec: (c: string, a: Record<string, unknown>) => Promise<unknown> } } })
      .__moshStore.getState().exec(command, args), { command, args }) as Promise<Result>;

const tracksOf = (page: Page) =>
  page.evaluate(() => JSON.parse(JSON.stringify(
    (window as unknown as { __moshStore: { getState: () => { snapshot: { tracks: Track[] } } } }).__moshStore.getState().snapshot.tracks))) as Promise<Track[]>;

async function clipOf(page: Page, id: string): Promise<Clip> {
  for (const t of await tracksOf(page)) { const c = t.clips.find((x) => x.id === id); if (c) return c; }
  throw new Error(`no clip ${id}`);
}
async function waveClipId(page: Page): Promise<string> {
  for (const t of await tracksOf(page)) { const c = t.clips.find((x) => x.type === "wave"); if (c) return c.id; }
  throw new Error("the V3 fixture has no audio clip");
}
async function layerOf(page: Page, clipId: string): Promise<Layer> {
  const rl = (await clipOf(page, clipId)).renderLayer;
  if (!rl) throw new Error("no render layer");
  return rl;
}
async function newReimagineLayer(page: Page, mode = "reimagine"): Promise<string> {
  const clipId = await waveClipId(page);
  expect((await exec(page, "create_render_layer", { clipId, adapter: mode === "transform" ? "transform" : "fake", mode })).ok).toBe(true);
  return clipId;
}

test.beforeEach(async ({ page }) => { await bootV3(page); });

// NO-V3-UI (freeze-layer.spec): the freeze toggle lived in the old GenDrawer's non-direct body.
test("freeze_layer keeps the loop stopped across an edit; unfreeze_layer re-arms it as dirty", async ({ page }) => {
  const clipId = await newReimagineLayer(page);
  // Nothing rendered: there is no loop to stop, so there is nothing to freeze.
  expect((await exec(page, "unfreeze_layer", { clipId })).ok).toBe(false);

  expect((await exec(page, "render_layer", { clipId })).ok).toBe(true);
  expect((await layerOf(page, clipId)).status).toBe("ready");

  expect((await exec(page, "freeze_layer", { clipId })).ok).toBe(true);
  let rl = await layerOf(page, clipId);
  expect(rl.status).toBe("frozen");
  expect(rl.reactive).toBe(false);

  // A param edit moves status to dirty while the layer stays frozen: `reactive` is the truth.
  expect((await exec(page, "set_render_param", { clipId, seed: 7 })).ok).toBe(true);
  rl = await layerOf(page, clipId);
  expect(rl.status).toBe("dirty");
  expect(rl.reactive, "the freeze must survive an edit that overwrote status").toBe(false);

  expect((await exec(page, "unfreeze_layer", { clipId })).ok).toBe(true);
  rl = await layerOf(page, clipId);
  expect(rl.reactive).toBe(true);
  expect(rl.status, "edits made while frozen skipped their re-render: dirty, not ready").toBe("dirty");
  // Thawing an already-live layer is refused.
  expect((await exec(page, "unfreeze_layer", { clipId })).ok).toBe(false);
  await expectDispatched(page, "freeze_layer", { clipId });
  await expectDispatched(page, "unfreeze_layer", { clipId });
});

// NO-V3-UI (reimagine-midi.spec): V3's Re-Imagine opens on a single AUDIO clip only.
test("a MIDI clip re-imagines beneath itself: muted MIDI, marker, Reset restores it", async ({ page }) => {
  const track = (await tracksOf(page)).find((t) => !t.clips.some((c) => c.type === "wave"))!;
  const made = await exec(page, "add_midi_clip", { trackId: track.id });
  expect(made.ok).toBe(true);
  const clipId = String(made.data?.clipId ?? (await tracksOf(page)).flatMap((t) => t.clips).filter((c) => c.type === "midi").at(-1)!.id);

  expect((await exec(page, "create_render_layer", { clipId, adapter: "fake", mode: "reimagine" })).ok).toBe(true);
  expect((await exec(page, "render_layer", { clipId })).ok).toBe(true);
  let clip = await clipOf(page, clipId);
  expect(clip.renderLayer?.status).toBe("ready");
  expect(clip.renderLayer?.reimagineActive).toBe(true);
  expect(clip.mute, "the MIDI is muted under its re-imagined audio").toBe(true);

  expect((await exec(page, "reset_render_layer", { clipId })).ok).toBe(true);
  clip = await clipOf(page, clipId);
  expect(clip.renderLayer?.status).toBe("dirty");
  expect(clip.renderLayer?.reimagineActive).toBe(false);
  expect(clip.mute).toBe(false);
});

// NO-V3-UI (transform.spec): no "+ Transform" in the direct drawer.
test("transform: list_transform_targets, pick a target and strength, render in place, reset", async ({ page }) => {
  const clipId = await newReimagineLayer(page, "transform");
  const listed = await exec(page, "list_transform_targets");
  expect(listed.ok).toBe(true);
  const targets = listed.data?.targets as string[];
  expect(targets.length).toBeGreaterThan(1);

  expect((await exec(page, "set_render_param", { clipId, target: targets[1], strength: 80 })).ok).toBe(true);
  let rl = await layerOf(page, clipId);
  expect(rl.mode).toBe("transform");
  expect(rl.target).toBe(targets[1]);
  expect(rl.strength).toBe(80);

  expect((await exec(page, "render_layer", { clipId })).ok).toBe(true);
  rl = await layerOf(page, clipId);
  expect(rl.status).toBe("ready");
  expect(rl.appliedInPlace, "a wave clip auto-applies in place; there is no Accept step").toBe(true);
  expect((await exec(page, "reset_render_layer", { clipId })).ok).toBe(true);
  expect((await layerOf(page, clipId)).appliedInPlace).toBe(false);
});

// NO-V3-UI (compile.spec): V3 has no "describe it" box on the clip.
test("compile_render: a corrective instruction is declined and routes to the tool; a descriptive one fills a layer", async ({ page }) => {
  const clipId = await waveClipId(page);
  // The honest boundary comes first, on a clip with no layer: the compiler must mutate nothing.
  const fix = await exec(page, "compile_render", { clipId, instruction: "fix the tuning, it's pitchy", wait: true });
  expect(fix.ok).toBe(true);
  expect(String(fix.data?.say)).toMatch(/AutoTune/i);
  expect(fix.data?.tool).toBe("moshAutoTune");
  expect((await clipOf(page, clipId)).renderLayer, "a corrective request creates no layer").toBeUndefined();

  const vague = await exec(page, "compile_render", { clipId, instruction: "fix my guitar", wait: true });
  expect(String(vague.data?.say)).toMatch(/AutoTune/i);
  expect(vague.data?.tool ?? null, "ambiguous: no single action").toBeNull();
  expect((await clipOf(page, clipId)).renderLayer).toBeUndefined();

  const track = (await tracksOf(page)).find((t) => t.clips.some((c) => c.id === clipId))!;
  expect((await exec(page, "load_builtin", { trackId: track.id, type: "moshAutoTune" })).ok).toBe(true);

  const made = await exec(page, "compile_render", { clipId, instruction: "make it lo-fi and gritty", wait: true });
  expect(made.ok).toBe(true);
  expect(made.data?.mode).toBe("reimagine");
  const rl = await layerOf(page, clipId);
  expect(rl.status).toBe("dirty");
  expect(rl.colors?.map((c) => c.name)).toContain("grit");
  expect((await exec(page, "render_layer", { clipId })).ok).toBe(true);
  expect((await layerOf(page, clipId)).status).toBe("ready");
});

// NO-V3-UI (sustain-toggle.spec): the colour rack is not in the direct drawer.
test("sustain is one colour with two vectors: Gentle by default, Swell swaps in, never both", async ({ page }) => {
  const colors = (await exec(page, "list_colors")).data?.colors as { name: string; group?: string; mode?: string; no_stack_with: string[] }[];
  const gentle = colors.find((c) => c.name === "sustain")!;
  const swell = colors.find((c) => c.name === "sustain_swell")!;
  expect([gentle.group, gentle.mode]).toEqual(["sustain", "Gentle"]);
  expect([swell.group, swell.mode]).toEqual(["sustain", "Swell"]);
  expect(gentle.no_stack_with).toContain("sustain_swell");

  const clipId = await newReimagineLayer(page);
  await exec(page, "set_render_param", { clipId, colors: [{ name: "sustain", value: 60 }] });
  expect((await layerOf(page, clipId)).colors).toEqual([{ name: "sustain", value: 60 }]);
  await exec(page, "set_render_param", { clipId, colors: [{ name: "sustain_swell", value: 60 }] });
  expect((await layerOf(page, clipId)).colors).toEqual([{ name: "sustain_swell", value: 60 }]);
});

// NO-V3-UI (lora-rack.spec): V3's picker is covered in v3-lora.spec.ts; the stack is unbounded.
test("a LoRA stack of three is kept whole, and a render with the rack armed still lands", async ({ page }) => {
  const listed = (await exec(page, "list_loras")).data?.loras as { name: string; valid?: boolean; family?: string }[];
  expect(listed.some((l) => l.family === "lab")).toBe(true);
  const usable = listed.filter((l) => (l.valid ?? true) && l.family !== "lab").map((l) => l.name);
  expect(usable.length).toBeGreaterThanOrEqual(3);

  const clipId = await newReimagineLayer(page);
  const loras = usable.slice(0, 3).map((name, i) => ({ name, value: [70, 200, 40][i] }));
  expect((await exec(page, "set_render_param", { clipId, loras })).ok).toBe(true);
  expect((await layerOf(page, clipId)).loras).toEqual(loras);
  expect((await exec(page, "render_layer", { clipId })).ok).toBe(true);
  expect((await layerOf(page, clipId)).status).toBe("ready");
  await exec(page, "set_render_param", { clipId, loras: loras.slice(0, 2) });
  expect((await layerOf(page, clipId)).loras).toHaveLength(2);
});

// NO-V3-UI (rave-insert.spec): the "+ RAVE" rack affordance is not mounted in V3.
test("RAVE insert: add_rave_insert, then load_rave_model by library name and by path", async ({ page }) => {
  const trackId = (await tracksOf(page))[0].id;
  const added = await exec(page, "add_rave_insert", { trackId });
  expect(added.ok).toBe(true);
  const pluginIndex = Number(added.data?.index);
  const rave = async () => (await tracksOf(page)).find((t) => t.id === trackId)!.plugins!.find((p) => p.index === pluginIndex)!.rave!;
  expect((await rave()).modelLoaded).toBe(false);

  const models = (await exec(page, "list_rave_models")).data?.models as { name: string }[];
  expect(models.map((m) => m.name)).toContain("guitar");

  expect((await exec(page, "load_rave_model", { trackId, pluginIndex, target: "guitar" })).ok).toBe(true);
  expect(await rave()).toMatchObject({ modelName: "guitar", modelLoaded: true });
  await expectDispatched(page, "load_rave_model", { target: "guitar" });

  // A custom .ts goes out as a file `path`.
  expect((await exec(page, "load_rave_model", { trackId, pluginIndex, path: "/models/flute.ts" })).ok).toBe(true);
  expect((await rave()).modelName).toBe("flute");
  // A target that is not a RAVE insert is refused.
  expect((await exec(page, "load_rave_model", { trackId, pluginIndex: 99, target: "guitar" })).ok).toBe(false);
  // One undo takes the model load back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await rave()).modelName).toBe("guitar");
});

// NO-V3-UI for the status read: the Lab polls it, but the mock keeps it out of the command trace,
// so the run it reports is pinned here through the bridge. Train / Stop by mouse: v3-lora.spec.ts.
test("training_job_status walks a submitted run queued -> running -> ready; cancel_training_job stops a live one", async ({ page }) => {
  const submit = async () => {
    const r = await exec(page, "submit_training_job", { corpusBundle: "/mock/bundle-e2e" });
    expect(r.ok).toBe(true);
    return String(r.data?.jobId);
  };
  const status = async (jobId: string) => {
    const r = await exec(page, "training_job_status", { jobId });
    expect(r.ok).toBe(true);
    return String(r.data?.status);
  };

  const run = await submit();
  expect(await status(run)).toBe("running");
  expect(await status(run)).toBe("ready");
  // A finished run has nothing left to stop and keeps its status.
  const late = await exec(page, "cancel_training_job", { jobId: run });
  expect(late.data).toMatchObject({ status: "ready", cancelRequested: false });
  expect(await status(run)).toBe("ready");

  const live = await submit();
  const stop = await exec(page, "cancel_training_job", { jobId: live });
  expect(stop.data).toMatchObject({ jobId: live, cancelRequested: true });
  expect(await status(live)).toBe("cancelled");
  await expectDispatched(page, "cancel_training_job", { jobId: live });

  // An id nobody knows is refused, not recorded.
  expect((await exec(page, "training_job_status", { jobId: "job-nope" })).ok).toBe(false);
  expect((await exec(page, "cancel_training_job", { jobId: "job-nope" })).ok).toBe(false);
});

async function openLab(page: Page) {
  await page.getByTestId("v3-training-trigger").click();
  await page.getByTestId("v3-training-modal").getByTestId("open-lora-lab").click();
  const lab = page.getByTestId("lora-lab");
  await expect(lab).toBeVisible();
  return lab;
}

// PORT (lora-lab.spec, 1 of 3): the Lab component is shared; V3 reaches it from the LoRA dialog.
test("Lab: the prompt gates the audition, and a take can be played once written", async ({ page }) => {
  const lab = await openLab(page);
  const baseRow = lab.getByTestId("lab-take-base");
  await expect(baseRow).toBeVisible();
  await expect(lab.getByTestId("lab-hint-prompt")).toBeVisible();
  const play = baseRow.getByRole("button", { name: /Audition/i });
  await expect(play).toBeDisabled();
  await lab.getByTestId("lab-prompt").fill("rage trap instrumental, distorted 808, 152 bpm");
  await expect(play).toBeEnabled();
  await play.click();
  await expect(baseRow.getByTestId("lab-wave")).toBeVisible();
});

// PORT (lora-lab.spec, 2 of 3)
test("Lab: a take can be hidden and brought back; dismissal is never a delete", async ({ page }) => {
  const lab = await openLab(page);
  await page.evaluate(() => {
    (window as unknown as { __moshStore: { setState: (s: unknown) => void } }).__moshStore.setState({
      labTakes: [{ name: "e2e-run@600", step: 600, isFinal: false, landedAt: Date.now() }],
    });
  });
  const row = lab.getByTestId("lab-take-e2e-run@600");
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /Hide/i }).click();
  await expect(row).toHaveCount(0);
  await lab.getByTestId("lab-restore").click();
  await expect(lab.getByTestId("lab-take-e2e-run@600")).toBeVisible();
});

// PORT (training-sources.spec): the wording of a blocked source, in both places V3 shows it.
test("a new source says it needs approval, and approving it clears the block", async ({ page }) => {
  await page.getByTestId("v3-training-trigger").click();
  const dialog = page.getByTestId("v3-training-modal");
  await dialog.getByPlaceholder("Track/beat name").fill("Night Drive");
  await dialog.getByPlaceholder("Creator/artist name").fill("e2e");
  await dialog.getByPlaceholder("Local file path").fill("/Users/you/night-drive.wav");
  await dialog.getByPlaceholder("Paste your rights claim text").fill("my own work");
  await dialog.getByPlaceholder("link + proof note").fill("session files");
  await dialog.getByRole("button", { name: "Add source", exact: true }).click();
  await expectDispatched(page, "import_training_source", { title: "Night Drive", localPath: "/Users/you/night-drive.wav" });

  const sources = dialog.getByTestId("training-sources");
  await expect(sources.getByRole("listitem")).toHaveText(["beat-001: Needs approval"]);
  await expect(sources.getByRole("status")).toHaveText("1 source needs review");
  await expect(sources.locator(".cmdlog-badge")).toHaveText("Needs approval");

  await dialog.getByRole("button", { name: "Approve" }).click();
  await expectDispatched(page, "approve_training_source", { sourceId: "beat-001", approved: true });
  await expect(sources.locator(".cmdlog-badge")).toHaveText("Ready for training");
  await expect(sources.getByRole("status")).toHaveText("All sources ready for training");
  await expect(sources.getByRole("listitem")).toHaveCount(0);
});

// PORT (moshi-dock.spec, 2 of 2): V3's dock has no resize divider or mute cap, but its Ask field
// must not be clipped off the bottom of the dock.
test("the Ask Moshi field stays inside the dock", async ({ page }) => {
  const field = (await page.getByTestId("v3-moshi-field").boundingBox())!;
  const dock = (await page.getByTestId("v3-moshi-dock").boundingBox())!;
  expect(field.y).toBeGreaterThanOrEqual(dock.y - 0.5);
  expect(field.y + field.height).toBeLessThanOrEqual(dock.y + dock.height + 0.5);
  expect(field.x + field.width).toBeLessThanOrEqual(dock.x + dock.width + 0.5);
});
