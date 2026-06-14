import { expect, test } from "@playwright/test";
import { collectConsoleProblems, command, openApp, trackWithClip, waitForSnapshot } from "./helpers";

// Tier-B generative loop: render → audition → accept (lands on a Neural lane) →
// render → reject, plus a self-contained cache HIT/MISS proof over the full
// fingerprint (identical params HIT; changed seed MISS).
test("generative render → accept → reject", async ({ page, request }) => {
  const problems = collectConsoleProblems(page);
  await openApp(page);
  const { trackId } = await trackWithClip(page, request);
  let snap = await waitForSnapshot(request, (s) => s.tracks.length === 1);
  const sourceClipCount = snap.tracks[0].clips.length;

  // Generate + accept → a new clip on a "Neural" lane, source untouched.
  await page.getByTestId("clip").first().getByTestId("clip-generate").click();
  await expect(page.getByTestId("color-rack")).toBeVisible();
  await page.getByTestId("color-rack-render").click();
  await expect(page.getByTestId("layer-badge").filter({ hasText: /ready/ }).first()).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("layer-accept").first().click();
  snap = await waitForSnapshot(
    request,
    (s) =>
      s.tracks.some((t) => t.name === "Neural" && t.clips.length === 1) &&
      s.tracks.find((t) => t.id === trackId)?.clips.length === sourceClipCount,
    20_000,
  );
  expect(snap.tracks.find((t) => t.name === "Neural")?.clips).toHaveLength(1);
  expect(snap.tracks.find((t) => t.id === trackId)?.clips).toHaveLength(sourceClipCount);

  // Generate again + reject → Neural lane unchanged (still one clip).
  await page.getByTestId("clip").first().getByTestId("clip-generate").click();
  await page.getByTestId("color-rack-render").click();
  await expect(page.getByTestId("layer-badge").filter({ hasText: /ready/ }).last()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("layer-reject").last().click();
  await waitForSnapshot(request, (s) => s.tracks.find((t) => t.name === "Neural")?.clips.length === 1);

  expect(problems).toEqual([]);
});

// Cache is keyed by the full fingerprint: identical (clip, params) re-renders HIT;
// a changed seed MISSES. Driven straight through the command surface so it does not
// depend on prior UI render history.
test("render cache HIT on identical params, MISS on changed seed", async ({ page, request }) => {
  await openApp(page);
  const { clipId } = await trackWithClip(page, request);

  // First render of (clip, reimagine, prompt) — populates the cache.
  const first = await command(request, "create_render_layer", { clipId, mode: "reimagine", prompt: "reimagine" });
  await command(request, "render_layer", { layerId: first.data.layerId });
  await waitForSnapshot(
    request,
    (s) => s.tracks.some((t) => t.clips.some((c) => c.renderLayer?.id === first.data.layerId && c.renderLayer.status === "ready")),
    20_000,
  );

  // Identical params → HIT.
  const hitLayer = await command(request, "create_render_layer", { clipId, mode: "reimagine", prompt: "reimagine" });
  const hit = await command(request, "render_layer", { layerId: hitLayer.data.layerId });
  expect(hit.data.fromCache).toBe(true);

  // Changed seed → MISS.
  const missLayer = await command(request, "create_render_layer", { clipId, mode: "reimagine", prompt: "reimagine", seed: 999 });
  const miss = await command(request, "render_layer", { layerId: missLayer.data.layerId });
  expect(miss.data.fromCache).not.toBe(true);
});
