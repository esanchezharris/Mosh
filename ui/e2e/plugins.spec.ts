import { expect, test } from "@playwright/test";
import { collectConsoleProblems, openApp, trackWithClip, waitForSnapshot } from "./helpers";

// VST3 effect lifecycle + Tier-A neural insert, all via the plugin rack UI.
test("add EQ effect → bypass → remove → add neural insert", async ({ page, request }) => {
  const problems = collectConsoleProblems(page);
  await openApp(page);
  await trackWithClip(page, request);

  let snap = await waitForSnapshot(request, (s) => s.tracks.length === 1);
  const basePluginIds = new Set(snap.tracks[0].plugins.map((p) => p.id));

  // Add an EQ effect.
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

  // Bypass it.
  const eqChip = page.getByTestId("plugin-chip").filter({ hasText: /Equaliser/ }).first();
  await eqChip.getByTestId("plugin-name").click();
  await waitForSnapshot(request, (s) => s.tracks[0]?.plugins.find((p) => p.id === eqId)?.bypassed === true);

  // Remove it.
  await eqChip.getByTestId("plugin-remove").click();
  await waitForSnapshot(request, (s) => s.tracks[0]?.plugins.every((p) => basePluginIds.has(p.id)) ?? false);

  // Add a Tier-A neural insert.
  await page.getByTestId("plugin-add").first().click();
  await page.getByTestId("plugin-add-neural").click();
  await waitForSnapshot(
    request,
    (s) => s.tracks[0]?.plugins.some((p) => /neural/i.test(`${p.type} ${p.name}`)) ?? false,
  );

  expect(problems).toEqual([]);
});
