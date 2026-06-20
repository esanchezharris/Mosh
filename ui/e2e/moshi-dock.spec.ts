import { test, expect } from "@playwright/test";
import { boot } from "./helpers";

// Regression guard for the Moshi dock cap row. The centered moshi column (cap + 132px
// creature mount + mood + composer + gaps) is taller than the default 196px detail
// dock, so `justify-content: center` used to push the cap UP into the band that
// `dock-host { overflow: hidden }` clips — exactly where the resize divider sits. A
// center-click on a cap button then landed on the divider, and the "Ask Moshi"
// composer was simultaneously clipped off the bottom. The fix lets the creature mount
// flex-shrink (mosh.css .moshi-mount) so the column fits with no overflow. These pin
// both ends. (On the hands-free branch the same row also carries the 👂 toggle; the
// fix is what lets that branch's capClick use a plain center click.)

test("the Moshi cap sits below the dock divider and is clickable at its center", async ({ page }) => {
  await boot(page);
  const mute = page.getByTestId("moshi-mute");
  const divider = page.getByTestId("dock-divider");
  await expect(mute).toBeVisible();
  await expect(divider).toBeVisible();

  const m = (await mute.boundingBox())!;
  const d = (await divider.boundingBox())!;

  // the cap button must start at or below the divider's bottom edge (no overlap)
  expect(m.y, "the mute button must sit below the resize divider").toBeGreaterThanOrEqual(d.y + d.height - 0.5);

  // a real hit-test at the button's center must resolve to the button, not the divider
  const cx = m.x + m.width / 2;
  const cy = m.y + m.height / 2;
  const hitsButton = await page.evaluate(
    ({ cx, cy }) => !!document.elementFromPoint(cx, cy)?.closest('[data-testid="moshi-mute"]'),
    { cx, cy },
  );
  expect(hitsButton, "center hit-test must land on the mute button, not the divider").toBe(true);

  // and a plain center click (no { position } workaround) toggles it
  const before = (await mute.getAttribute("aria-pressed"))!;
  await mute.click();
  await expect(mute).not.toHaveAttribute("aria-pressed", before);
});

test("the Ask-Moshi composer is not clipped off the bottom of the dock", async ({ page }) => {
  await boot(page);
  const comp = (await page.locator(".agent-composer").boundingBox())!;
  const host = (await page.locator(".dock-host").boundingBox())!;
  expect(comp.y + comp.height, "composer bottom must stay within the dock host").toBeLessThanOrEqual(
    host.y + host.height + 0.5,
  );
});
