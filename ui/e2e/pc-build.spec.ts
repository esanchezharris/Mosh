import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

type Snapshot = {
  schemaVersion: number;
  session: { tempo: number; sampleRate?: number; editFile?: string };
  tracks: Array<{
    id: string;
    name: string;
    clips: Array<{
      id: string;
      start: number;
      length: number;
      offset: number;
      renderLayer?: { id: string; status: string };
    }>;
    plugins: Array<{ id: string; type: string; name: string; bypassed: boolean }>;
  }>;
  transport: {
    position: number;
    playing: boolean;
    recording?: boolean;
    looping?: boolean;
    loopStart?: number;
    loopEnd?: number;
  };
};

type MoshResult = {
  ok: boolean;
  command: string;
  error?: string;
  data: Record<string, unknown>;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get("/api/snapshot");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Snapshot;
}

async function command(
  request: APIRequestContext,
  commandName: string,
  args: Record<string, unknown> = {},
): Promise<MoshResult> {
  const response = await request.post("/api/command", {
    data: { command: commandName, args },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as MoshResult;
  expect(body.command).toBe(commandName);
  expect(body.ok, `${commandName}: ${body.error ?? JSON.stringify(body)}`).toBeTruthy();
  return body;
}

async function waitForSnapshot(
  request: APIRequestContext,
  predicate: (snapshot: Snapshot) => boolean,
  timeoutMs = 15_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  let last = await snapshot(request);
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await delay(150);
    last = await snapshot(request);
  }
  expect(predicate(last), JSON.stringify(last, null, 2)).toBeTruthy();
  return last;
}

async function dragBy(page: Page, locator: Locator, dx: number, dy = 0) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await delay(60);
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
}

async function dragClipEdge(page: Page, clip: Locator, edge: "left" | "right", dx: number) {
  const box = await clip.boundingBox();
  expect(box).not.toBeNull();
  const startX = edge === "right" ? box!.x + box!.width - 7 : box!.x + 7;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await delay(60);
  await page.mouse.move(startX + dx, startY, { steps: 10 });
  await page.mouse.up();
}

async function saveScreenshot(page: Page, name: string) {
  const dir = process.env.MOSH_E2E_ARTIFACT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name), fullPage: true });
}

test("Mosh drives the real MoshOps backend over HTTP", async ({ page, request }) => {
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.message}`));

  await page.goto("/");
  await expect(page).toHaveTitle(/Mosh/i);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("backend-badge")).toContainText("backend: juce");
  await expect(page.getByTestId("status-state")).toContainText("state ready");

  let snap = await snapshot(request);
  expect(snap.schemaVersion).toBeGreaterThanOrEqual(1);
  expect(typeof snap.session.tempo).toBe("number");
  for (const track of snap.tracks) {
    await command(request, "remove_track", { trackId: track.id });
  }
  snap = await waitForSnapshot(request, (s) => s.tracks.length === 0);
  expect(snap.tracks).toHaveLength(0);
  await expect(page.getByTestId("status-tracks")).toContainText("tracks 0");

  await page.getByTestId("add-track").click();
  snap = await waitForSnapshot(request, (s) => s.tracks.length === 1);
  await expect(page.getByTestId("track-header")).toHaveCount(1);

  const lane = page.getByTestId("lane").first();
  await lane.click({ position: { x: 220, y: 42 } });
  snap = await waitForSnapshot(request, (s) => s.tracks[0]?.clips.length === 1);
  const trackId = snap.tracks[0].id;
  const firstClipId = snap.tracks[0].clips[0].id;
  await expect(page.getByTestId("clip")).toHaveCount(1);

  const clip = page.getByTestId("clip").first();
  const beforeMove = snap.tracks[0].clips[0].start;
  await dragBy(page, clip, 90);
  snap = await waitForSnapshot(
    request,
    (s) => (s.tracks[0]?.clips[0]?.start ?? beforeMove) > beforeMove + 0.5,
  );

  const movedLength = snap.tracks[0].clips[0].length;
  await dragClipEdge(page, page.getByTestId("clip").first(), "right", -60);
  snap = await waitForSnapshot(
    request,
    (s) => (s.tracks[0]?.clips[0]?.length ?? movedLength) < movedLength - 0.25,
  );

  const movedStart = snap.tracks[0].clips[0].start;
  await dragClipEdge(page, page.getByTestId("clip").first(), "left", 56);
  snap = await waitForSnapshot(
    request,
    (s) => (s.tracks[0]?.clips[0]?.start ?? movedStart) > movedStart + 0.15,
  );

  await clip.dblclick();
  snap = await waitForSnapshot(request, (s) => s.tracks[0]?.clips.length === 2);
  await expect(page.getByTestId("clip")).toHaveCount(2);
  expect(snap.tracks[0].clips.some((c) => c.id === firstClipId)).toBeTruthy();

  await page.getByTestId("transport-play").click();
  snap = await waitForSnapshot(request, (s) => s.transport.playing);
  expect(snap.transport.playing).toBe(true);

  await page.getByTestId("transport-stop").click();
  snap = await waitForSnapshot(request, (s) => !s.transport.playing && s.transport.position === 0);
  expect(snap.transport.position).toBe(0);

  await page.getByTestId("ruler").click({ position: { x: 260, y: 12 } });
  snap = await waitForSnapshot(request, (s) => s.transport.position > 0.5);
  expect(snap.transport.position).toBeGreaterThan(0.5);

  await page.getByTestId("transport-loop").click();
  snap = await waitForSnapshot(request, (s) => s.transport.looping === true);
  expect(snap.transport.loopStart).toBe(0);
  expect(snap.transport.loopEnd).toBe(8);

  const basePluginIds = new Set(snap.tracks[0].plugins.map((p) => p.id));
  await page.getByTestId("plugin-add").first().click();
  await page.getByTestId("plugin-add-effect").filter({ hasText: "EQ" }).click();
  snap = await waitForSnapshot(
    request,
    (s) => s.tracks[0]?.plugins.some((p) => !basePluginIds.has(p.id) && /equal/i.test(p.name)) ?? false,
  );
  const eq = snap.tracks[0].plugins.find((p) => !basePluginIds.has(p.id) && /equal/i.test(p.name));
  expect(eq).toBeTruthy();
  const eqId = eq!.id;
  expect(eq!.bypassed).toBe(false);

  const eqChip = page.getByTestId("plugin-chip").filter({ hasText: /Equaliser/ }).first();
  await eqChip.getByTestId("plugin-name").click();
  snap = await waitForSnapshot(
    request,
    (s) => s.tracks[0]?.plugins.find((p) => p.id === eqId)?.bypassed === true,
  );

  await eqChip.getByTestId("plugin-remove").click();
  snap = await waitForSnapshot(
    request,
    (s) => s.tracks[0]?.plugins.every((p) => basePluginIds.has(p.id)) ?? false,
  );

  await page.getByTestId("plugin-add").first().click();
  await page.getByTestId("plugin-add-neural").click();
  snap = await waitForSnapshot(
    request,
    (s) => s.tracks[0]?.plugins.some((p) => /neural/i.test(`${p.type} ${p.name}`)) ?? false,
  );

  const sourceClipId = snap.tracks[0].clips[0].id;
  const sourceClipCount = snap.tracks[0].clips.length;
  await page.getByTestId("clip").first().getByTestId("clip-generate").click();
  await expect(page.getByTestId("color-rack")).toBeVisible();
  await page.getByTestId("color-rack-render").click();
  await expect(page.getByTestId("layer-badge").filter({ hasText: /ready/ }).first()).toBeVisible({
    timeout: 20_000,
  });

  await page.getByTestId("layer-accept").first().click();
  snap = await waitForSnapshot(
    request,
    (s) =>
      s.tracks.some((t) => t.name === "Neural" && t.clips.length === 1) &&
      s.tracks.find((t) => t.id === trackId)?.clips.length === sourceClipCount,
    20_000,
  );
  const neuralTrack = snap.tracks.find((t) => t.name === "Neural");
  expect(neuralTrack?.clips).toHaveLength(1);
  expect(snap.tracks.find((t) => t.id === trackId)?.clips).toHaveLength(sourceClipCount);

  await page.getByTestId("clip").first().getByTestId("clip-generate").click();
  await page.getByTestId("color-rack-render").click();
  await expect(page.getByTestId("layer-badge").filter({ hasText: /ready/ }).last()).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("layer-reject").last().click();
  snap = await waitForSnapshot(
    request,
    (s) => s.tracks.find((t) => t.name === "Neural")?.clips.length === 1,
  );

  const cachedLayer = await command(request, "create_render_layer", {
    clipId: sourceClipId,
    mode: "reimagine",
    prompt: "reimagine",
  });
  const cachedRender = await command(request, "render_layer", {
    layerId: cachedLayer.data.layerId,
  });
  expect(cachedRender.data.fromCache).toBe(true);

  const missLayer = await command(request, "create_render_layer", {
    clipId: sourceClipId,
    mode: "reimagine",
    prompt: "reimagine",
    seed: 999,
  });
  const missRender = await command(request, "render_layer", {
    layerId: missLayer.data.layerId,
  });
  expect(missRender.data.fromCache).not.toBe(true);
  await waitForSnapshot(
    request,
    (s) =>
      s.tracks.some((t) =>
        t.clips.some((c) => c.renderLayer?.id === missLayer.data.layerId && c.renderLayer.status === "ready"),
      ),
    20_000,
  );

  const eventResponse = await request.get("/api/events?since=-999999");
  expect(eventResponse.ok()).toBeTruthy();
  const eventBody = await eventResponse.json();
  expect(eventBody.resync).toBe(true);

  await page.getByTestId("undo-button").click();
  snap = await waitForSnapshot(request, (s) => s.tracks.some((t) => t.clips.length > 0));
  expect(snap.tracks.length).toBeGreaterThanOrEqual(1);

  await page.keyboard.press("Control+Shift+Z");
  snap = await waitForSnapshot(request, (s) => s.tracks.some((t) => t.clips.length > 0));
  expect(snap.tracks.some((t) => t.name === "Neural")).toBeTruthy();

  await saveScreenshot(page, "pc-build-e2e-final.png");
  expect(consoleProblems).toEqual([]);
});
