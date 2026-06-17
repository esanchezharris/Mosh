import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// End-to-end against the REAL MoshOps backend over HTTP (snapshot+command seam),
// driving main's rebuilt WebView UI through the data-testids it actually ships.
//
// The HTTP fixture (/api/snapshot, /api/command, /api/events) is the swappable
// seam and is unchanged. The UI selectors below are the rebuilt shell's: the
// canonical grid (Arrange), the bottom Dock (plugin/neural rack + generative
// drawer), the Topbar transport, and the Toolbar (track ops / tools / undo).
// Controls without a testid are reached by their visible role+text, exactly as a
// user would. See ui/src/ui/*.tsx for the source of every locator used here.

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
    // Rebuilt snapshot plugin shape: chain-indexed, no opaque id; bypass is the
    // inverse of `enabled`; neural inserts carry a `neural` descriptor.
    plugins: Array<{
      index: number;
      name: string;
      type: string;
      enabled: boolean;
      neural?: unknown;
      builtin?: boolean;
      external?: boolean;
    }>;
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

// Loop region is set by a shift-drag across the ruler (Arrange.onRulerDown/Move
// → set_transport{loop,loopStart,loopEnd}); there is no loop button. Drag near
// the left edge so both endpoints stay on-screen regardless of zoom.
async function shiftDragRuler(page: Page, ruler: Locator, fromPx: number, toPx: number) {
  const box = await ruler.boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height / 2;
  await page.keyboard.down("Shift");
  await page.mouse.move(box!.x + fromPx, y);
  await page.mouse.down();
  await delay(60);
  await page.mouse.move(box!.x + toPx, y, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
}

async function saveScreenshot(page: Page, name: string) {
  const dir = process.env.MOSH_E2E_ARTIFACT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name), fullPage: true });
}

test("Mosh drives the real MoshOps backend over HTTP", async ({ page, request }) => {
  // Console errors / page errors are hard failures; warnings are noisy in the
  // WebView (favicon, audio device) and only logged, not asserted.
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleProblems.push(`error: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.message}`));

  await page.goto("/");
  await expect(page).toHaveTitle(/Mosh/i);
  await expect(page.getByTestId("app")).toBeVisible();
  // Shell is up once the cold snapshot renders the topbar transport + arrangement.
  await expect(page.getByTestId("transport")).toBeVisible();
  await expect(page.getByTestId("arrangement")).toBeVisible();

  let snap = await snapshot(request);
  expect(snap.schemaVersion).toBeGreaterThanOrEqual(1);
  expect(typeof snap.session.tempo).toBe("number");

  // Reset to an empty edit: removing every track leaves zero track headers.
  for (const track of snap.tracks) {
    await command(request, "remove_track", { trackId: track.id });
  }
  snap = await waitForSnapshot(request, (s) => s.tracks.length === 0);
  expect(snap.tracks).toHaveLength(0);
  await expect(page.getByTestId("track-header")).toHaveCount(0);

  // Add a track via the Toolbar (create_track).
  await page.getByRole("button", { name: "+ Track", exact: true }).click();
  snap = await waitForSnapshot(request, (s) => s.tracks.length === 1);
  await expect(page.getByTestId("track-header")).toHaveCount(1);
  const trackId = snap.tracks[0].id;

  // Select the track (the +Test Tone button is disabled until a track is current),
  // then drop a test-tone wave clip onto it (add_test_tone_clip).
  await page.getByTestId("track-header").first().locator(".tname").click();
  await page.getByRole("button", { name: "+ Test Tone", exact: true }).click();
  snap = await waitForSnapshot(request, (s) => s.tracks[0]?.clips.length === 1);
  const firstClipId = snap.tracks[0].clips[0].id;
  await expect(page.getByTestId("clip")).toHaveCount(1);

  // Drag the clip body → move_clip.
  const clip = page.getByTestId("clip").first();
  const beforeMove = snap.tracks[0].clips[0].start;
  await dragBy(page, clip, 90);
  snap = await waitForSnapshot(
    request,
    (s) => (s.tracks[0]?.clips[0]?.start ?? beforeMove) > beforeMove + 0.5,
  );

  // Drag the right trim handle inward → trim_clip (shortens).
  const movedLength = snap.tracks[0].clips[0].length;
  await dragClipEdge(page, page.getByTestId("clip").first(), "right", -60);
  snap = await waitForSnapshot(
    request,
    (s) => (s.tracks[0]?.clips[0]?.length ?? movedLength) < movedLength - 0.25,
  );

  // Drag the left trim handle inward → trim_clip (moves start later).
  const movedStart = snap.tracks[0].clips[0].start;
  await dragClipEdge(page, page.getByTestId("clip").first(), "left", 56);
  snap = await waitForSnapshot(
    request,
    (s) => (s.tracks[0]?.clips[0]?.start ?? movedStart) > movedStart + 0.15,
  );

  // Split: pick the Split tool, then a click on the clip splits it (split_clip).
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await page.getByTestId("clip").first().click();
  snap = await waitForSnapshot(request, (s) => s.tracks[0]?.clips.length === 2);
  await expect(page.getByTestId("clip")).toHaveCount(2);
  expect(snap.tracks[0].clips.some((c) => c.id === firstClipId)).toBeTruthy();
  await page.getByRole("button", { name: "Move", exact: true }).click();

  // Transport: play → stop (back to 0).
  await page.getByTestId("transport-play").click();
  snap = await waitForSnapshot(request, (s) => s.transport.playing);
  expect(snap.transport.playing).toBe(true);

  await page.getByTestId("transport-stop").click();
  snap = await waitForSnapshot(request, (s) => !s.transport.playing && s.transport.position === 0);
  expect(snap.transport.position).toBe(0);

  // Ruler click → seek.
  await page.getByTestId("ruler").click({ position: { x: 260, y: 12 } });
  snap = await waitForSnapshot(request, (s) => s.transport.position > 0.5);
  expect(snap.transport.position).toBeGreaterThan(0.5);

  // Ruler shift-drag → loop region.
  await shiftDragRuler(page, page.getByTestId("ruler"), 4, 260);
  snap = await waitForSnapshot(request, (s) => s.transport.looping === true);
  expect(snap.transport.looping).toBe(true);
  expect(snap.transport.loopEnd!).toBeGreaterThan(snap.transport.loopStart!);
  await expect(page.getByTestId("loop-region")).toBeVisible();

  // ── Plugins (bottom Dock rack for the selected track) ──────────────────────
  // Add a built-in effect: + Plugin opens the browser; pick "4-Band EQ"
  // (Tracktion reports its name as "Equaliser") via load_builtin.
  await page.getByRole("button", { name: "+ Plugin", exact: true }).click();
  await expect(page.getByTestId("plugin-browser")).toBeVisible();
  await page.getByTestId("plugin-browser").getByRole("button", { name: /4-Band EQ/ }).click();
  snap = await waitForSnapshot(
    request,
    (s) => s.tracks[0]?.plugins.some((p) => /equal/i.test(p.name)) ?? false,
  );
  const eq = snap.tracks[0].plugins.find((p) => /equal/i.test(p.name));
  expect(eq).toBeTruthy();
  expect(eq!.enabled).toBe(true);

  const eqCard = page.getByTestId("plugin-card").filter({ hasText: /Equaliser/ });
  // Bypass via the card's enable/bypass dot (bypass_plugin → enabled flips false).
  await eqCard.locator(".pdot").click();
  snap = await waitForSnapshot(
    request,
    (s) => s.tracks[0]?.plugins.find((p) => /equal/i.test(p.name))?.enabled === false,
  );

  // Remove via the card's ✕ (remove_plugin).
  await eqCard.locator(".btn.x").click();
  snap = await waitForSnapshot(
    request,
    (s) => !(s.tracks[0]?.plugins.some((p) => /equal/i.test(p.name)) ?? false),
  );

  // Add the Tier-A neural insert directly (+ Neural → add_neural_insert).
  await page.getByRole("button", { name: "+ Neural", exact: true }).click();
  snap = await waitForSnapshot(
    request,
    (s) => s.tracks[0]?.plugins.some((p) => p.neural != null || /neural/i.test(p.type)) ?? false,
  );

  // ── Generative drawer (Stage 5) ────────────────────────────────────────────
  // Create a render layer on the selected track's wave clip, render it, accept.
  const sourceClipCount = snap.tracks[0].clips.length;
  await page.getByTestId("gen-create").click();
  snap = await waitForSnapshot(
    request,
    (s) => s.tracks.find((t) => t.id === trackId)?.clips.some((c) => c.renderLayer) ?? false,
  );
  const sourceClipId = snap.tracks
    .find((t) => t.id === trackId)!
    .clips.find((c) => c.renderLayer)!.id;

  await page.getByTestId("gen-render").click();
  snap = await waitForSnapshot(
    request,
    (s) =>
      s.tracks
        .find((t) => t.id === trackId)
        ?.clips.find((c) => c.id === sourceClipId)?.renderLayer?.status === "ready",
    20_000,
  );
  await expect(page.getByTestId("render-status")).toHaveText(/ready/);

  // Accept lands a new clip on the dedicated "Neural Renders" lane; the source
  // track is left untouched.
  await page.getByTestId("gen-accept").click();
  snap = await waitForSnapshot(
    request,
    (s) =>
      s.tracks.some((t) => t.name === "Neural Renders" && t.clips.length === 1) &&
      s.tracks.find((t) => t.id === trackId)?.clips.length === sourceClipCount,
    20_000,
  );
  expect(snap.tracks.find((t) => t.name === "Neural Renders")?.clips).toHaveLength(1);
  expect(snap.tracks.find((t) => t.id === trackId)?.clips).toHaveLength(sourceClipCount);

  // Cache HIT — re-rendering the accepted layer with identical params reuses the
  // artifact (full-fingerprint cache, 05 §5).
  const cachedRender = await command(request, "render_layer", {
    clipId: sourceClipId,
    wait: true,
  });
  expect(cachedRender.data.cache).toBe("hit");

  // Cache MISS — a new seed changes the fingerprint, so it re-renders.
  await command(request, "set_render_param", { clipId: sourceClipId, seed: 999 });
  const missRender = await command(request, "render_layer", { clipId: sourceClipId, wait: true });
  expect(missRender.data.cache).toBe("miss");
  await waitForSnapshot(
    request,
    (s) =>
      s.tracks
        .find((t) => t.id === trackId)
        ?.clips.find((c) => c.id === sourceClipId)?.renderLayer?.status === "ready",
    20_000,
  );
  await expect(page.getByTestId("render-status")).toHaveText(/ready/);

  // Reject the current render — it does not commit a clip; the Neural Renders
  // lane keeps its single accepted clip.
  await page.getByTestId("generative").getByRole("button", { name: "Reject", exact: true }).click();
  snap = await waitForSnapshot(
    request,
    (s) =>
      s.tracks
        .find((t) => t.id === trackId)
        ?.clips.find((c) => c.id === sourceClipId)?.renderLayer?.status === "dirty",
  );
  expect(snap.tracks.find((t) => t.name === "Neural Renders")?.clips).toHaveLength(1);

  // The events feed always resyncs from a very old cursor.
  const eventResponse = await request.get("/api/events?since=-999999");
  expect(eventResponse.ok()).toBeTruthy();
  const eventBody = await eventResponse.json();
  expect(eventBody.resync).toBe(true);

  // Undo (Toolbar) reverts the reject; redo (keyboard) re-applies it. Both leave
  // the arrangement intact, with the Neural Renders lane still present.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  snap = await waitForSnapshot(request, (s) => s.tracks.some((t) => t.clips.length > 0));
  expect(snap.tracks.length).toBeGreaterThanOrEqual(1);

  await page.keyboard.press("Control+Shift+Z");
  snap = await waitForSnapshot(request, (s) => s.tracks.some((t) => t.name === "Neural Renders"));
  expect(snap.tracks.some((t) => t.name === "Neural Renders")).toBeTruthy();

  await saveScreenshot(page, "pc-build-e2e-final.png");
  expect(consoleProblems).toEqual([]);
});
