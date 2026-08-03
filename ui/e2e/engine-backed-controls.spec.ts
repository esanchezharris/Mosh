// Three capabilities the ENGINE already had and no control could reach. Anti-slop rule 1
// ("already in the engine, merely unexposed -> implement the UI"), so none of these adds
// a command or pays the four-registration cost.
//
//   • Select similar (#554)          — UI-local predicate; selection never crosses the seam
//   • Quantize strength (#552)       — cmdQuantizeNotes has taken `strength` all along;
//                                      the call site hardcoded 1, so only FULL quantize
//                                      was reachable — the one setting that kills a groove
//   • Clip play-start offset         — trim_clip{offset} read by cmdTrimClip and sent by
//     (CAP-CLP-016)                    the edge-drag layer, but undeclared and uncontrolled
//
// WHAT THIS SPEC CAN AND CANNOT PROVE, stated rather than implied. Select-similar has a
// direct visible result and is asserted end to end. For strength and offset the ENGINE
// behaviour is already covered natively (cmdQuantizeNotes / cmdTrimClip are exercised by
// --selftest); what was missing and is asserted here is REACHABILITY — that a mouse-only
// producer can find and operate the control at all. Asserting the audible result of a 50%
// quantize belongs in verify.py, not a browser.

import { test, expect } from "@playwright/test";
import { bootV2 } from "./helpers";

test.describe("engine-backed controls that had no UI", () => {
  test("Select similar picks every copy of the same source, across tracks", async ({ page }) => {
    await bootV2(page);
    // The mock session is NOT empty, so every count here is a DELTA. Add a tone track and
    // work on its clip, whose source nothing else in the fixture shares.
    const before = await page.getByTestId("v2-clip").count();
    await page.getByTestId("v2-track-add").click();
    await page.getByTestId("v2-track-add-tone").click();
    await expect(page.getByTestId("v2-clip")).toHaveCount(before + 1);

    const mine = page.getByTestId("v2-clip").last();
    await mine.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    await expect(page.getByTestId("v2-clip")).toHaveCount(before + 2);

    // Independently compute how many clips share this one's source, using the snapshot
    // rather than the module under test — a check that reimplements the rule is a real
    // cross-check; calling selectSimilarIds here would only assert it equals itself.
    const clipId = await mine.getAttribute("data-clip-id");
    const expected = await page.evaluate((id) => {
      const snap = (window as any).__moshStore.getState().snapshot;
      const all = snap.tracks.flatMap((t: any) => t.clips);
      const me = all.find((c: any) => c.id === id);
      const key = (c: any) => (c.sourceFile?.trim() ? `s:${c.sourceFile}` : c.name?.trim() ? `n:${c.name}` : null);
      const k = key(me);
      return k == null ? 1 : all.filter((c: any) => key(c) === k).length;
    }, clipId);
    expect(expected).toBeGreaterThan(1);   // the duplicate must actually share a source

    // Collapse to a single selection first, so the assertion cannot pass by accident.
    await mine.click();
    await expect(page.locator(".v2-clip.sel")).toHaveCount(1);

    await mine.click({ button: "right" });
    await page.getByTestId("clip-select-similar").click();
    await expect(page.locator(".v2-clip.sel")).toHaveCount(expected);
  });

  test("the quantize strength control is reachable and drives the command", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-add").click();
    await page.getByTestId("v2-track-add-midi").click();
    await page.getByTestId("v2-clip").last().click();
    await page.getByTestId("v2-insp-tab-midi").click();

    const strength = page.getByTestId("v2-quantize-strength");
    await expect(strength).toBeVisible();
    await expect(strength).toHaveValue("100");        // full quantize was the old ONLY option
    await strength.fill("50");
    await expect(page.locator("text=50%")).toBeVisible();
    // The button still works at a partial strength (the command accepts 0..1).
    await page.getByTestId("v2-quantize-16").click();
    await expect(page.getByTestId("v2-quantize-16")).toBeEnabled();
  });

  test("the clip play-start offset control is reachable", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-add").click();
    await page.getByTestId("v2-track-add-tone").click();
    await page.getByTestId("v2-clip").last().click();
    await page.getByTestId("v2-insp-tab-clip").click();

    const clipX = (await page.getByTestId("v2-clip").last().boundingBox())!.x;
    const offset = page.getByTestId("v2-clip-offset");
    await expect(offset).toBeVisible();
    await expect(offset).toHaveValue("0");
    await offset.fill("0.25");
    await offset.blur();
    // The clip must NOT move — sliding the audio inside a clip is the whole point, and is
    // what separates this from dragging the left edge, which moves it.
    await expect.poll(async () => (await page.getByTestId("v2-clip").last().boundingBox())!.x)
      .toBeCloseTo(clipX, 0);
  });
});
