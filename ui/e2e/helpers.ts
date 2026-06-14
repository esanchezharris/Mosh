// Shared E2E helpers (extracted from the former monolithic pc-build.spec.ts).
//
// Every spec drives ONE real MoshOps backend over HTTP. That backend is a single
// stateful session (one Edit), so the specs CANNOT run in parallel against it —
// playwright.config.ts pins workers:1 + fullyParallel:false. Each spec instead
// starts from a known state via resetToEmpty(), so any one spec is runnable on its
// own (e.g. `playwright test generative` to iterate the slow render flow alone).
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

export type Snapshot = {
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

export type MoshResult = {
  ok: boolean;
  command: string;
  error?: string;
  data: Record<string, unknown>;
};

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function snapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get("/api/snapshot");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Snapshot;
}

export async function command(
  request: APIRequestContext,
  commandName: string,
  args: Record<string, unknown> = {},
): Promise<MoshResult> {
  const response = await request.post("/api/command", { data: { command: commandName, args } });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as MoshResult;
  expect(body.command).toBe(commandName);
  expect(body.ok, `${commandName}: ${body.error ?? JSON.stringify(body)}`).toBeTruthy();
  return body;
}

export async function waitForSnapshot(
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

export async function dragBy(page: Page, locator: Locator, dx: number, dy = 0) {
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

export async function dragClipEdge(page: Page, clip: Locator, edge: "left" | "right", dx: number) {
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

export async function saveScreenshot(page: Page, name: string) {
  const dir = process.env.MOSH_E2E_ARTIFACT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name), fullPage: true });
}

/** Subscribe a console/page-error collector. Assert it stays empty at spec end. */
export function collectConsoleProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

/** Open the app and assert the shell wired up against the real native backend. */
export async function openApp(page: Page) {
  await page.goto("/");
  await expect(page).toHaveTitle(/Mosh/i);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("backend-badge")).toContainText("backend: juce");
  await expect(page.getByTestId("status-state")).toContainText("state ready");
}

/** Remove every track so a spec starts from a known-empty arrangement. */
export async function resetToEmpty(request: APIRequestContext): Promise<void> {
  const snap = await snapshot(request);
  for (const track of snap.tracks) await command(request, "remove_track", { trackId: track.id });
  await waitForSnapshot(request, (s) => s.tracks.length === 0);
}

/** Ensure exactly one audio track with one clip; returns the ids. */
export async function trackWithClip(page: Page, request: APIRequestContext): Promise<{ trackId: string; clipId: string }> {
  await resetToEmpty(request);
  await page.getByTestId("add-track").click();
  await waitForSnapshot(request, (s) => s.tracks.length === 1);
  await page.getByTestId("lane").first().click({ position: { x: 220, y: 42 } });
  const snap = await waitForSnapshot(request, (s) => s.tracks[0]?.clips.length === 1);
  return { trackId: snap.tracks[0].id, clipId: snap.tracks[0].clips[0].id };
}
