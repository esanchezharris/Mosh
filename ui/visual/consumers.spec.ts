import { test, expect } from "@playwright/test";

// Renders the actual drifted consumers (real shell.css classes) and screenshots them
// per theme, with the :focus-within and :hover states forced, so the PR-2.5 sweep is
// gated at the CONSUMER level (the token sheet only covers token values).
const STORY = "design-system-consumers--drifted";

for (const theme of ["dark", "light"] as const) {
  test(`consumers unchanged — ${theme}`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${STORY}&globals=theme:${theme}&viewMode=story`);
    await page.getByText("Drifted consumers").waitFor();
    await page.getByTestId("pbinput").focus(); // .v2-pb-search:focus-within (lime border)
    await page.getByTestId("danger").hover();   // .v2-clipmenu button.danger:hover
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot(`consumers-${theme}.png`, { fullPage: true });
  });
}
