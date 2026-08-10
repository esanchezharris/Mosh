import { expect, test } from "@playwright/test";
import { bootProTools } from "./helpers";

test("wide toolbar keeps Record's center free of neighboring controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const record = page.getByTestId("pt-toolbar").getByRole("button", { name: "Record", exact: true });

  const geometry = await record.evaluate((element) => {
    const rect = (target: Element | null) => {
      if (!target) return null;
      const value = target.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom };
    };
    const bounds = element.getBoundingClientRect();
    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    const nudge = document.querySelector<HTMLElement>('[aria-label="Nudge value"]');
    const toolbar = element.closest<HTMLElement>(".pt-toolbar");
    return {
      record: rect(element),
      recordGroup: rect(element.closest(".pt-transport-group")),
      nudge: rect(nudge),
      nudgeGroup: rect(nudge?.closest(".pt-grid-group") ?? null),
      toolbar: toolbar
        ? { clientWidth: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth, scrollLeft: toolbar.scrollLeft }
        : null,
      hitLabel: hit?.getAttribute("aria-label") ?? hit?.textContent?.trim() ?? null,
      hitIsRecord: hit === element || element.contains(hit),
    };
  });

  expect(geometry.hitIsRecord, JSON.stringify(geometry)).toBe(true);
});
