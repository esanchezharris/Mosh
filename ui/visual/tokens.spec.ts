import { test, expect } from "@playwright/test";

// The token-sheet oracle. Renders the Storybook story in isolation (iframe) per theme
// and pixel-diffs against a committed baseline. This is the no-op gate the color sweeps
// (PR-2.4/2.5/2.6) run before/after: an unintended token-value change fails here.
const STORY = "design-system-tokens--sheet";

for (const theme of ["dark", "light"] as const) {
  test(`token sheet is unchanged — ${theme}`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${STORY}&globals=theme:${theme}&viewMode=story`);
    // The sheet resolves token values in a mount effect; wait for a real value to land.
    await page.getByText("v2 token sheet").waitFor();
    await page.waitForFunction(() => {
      const t = document.body.innerText;
      return /rgba?\(|#[0-9a-fA-F]{3,8}/.test(t); // resolved color values populated
    });
    await expect(page).toHaveScreenshot(`token-sheet-${theme}.png`, { fullPage: true });
  });
}
