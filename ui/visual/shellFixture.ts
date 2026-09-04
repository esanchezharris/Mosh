// Deterministic boot of the REAL v2 shell for screenshot capture.
//
// Why this exists rather than a Storybook story: `npm run build-storybook` is a production
// Vite build, and the dev mock is gated on `import.meta.env.DEV || import.meta.env.MODE === "e2e"`
// (bridge.mock.ts). In a production Storybook build both are false, `isNative()` is false, and
// AppV2 renders the "Running outside the engine" fallback. A shell story added to the Storybook
// visual gate would therefore screenshot a placeholder — forever stable, forever green, and
// proving nothing. The Storybook decorator also forces `position: static` on `.v2-shell`, which
// destroys the push-dock geometry that IS the composition under test.
//
// So the shell is captured against an optimized e2e-mode Vite build with the mock explicitly
// enabled in the isolated dist-e2e output, matching the MOSH_E2E_PREVIEW recipe.

import { expect, type Page } from "@playwright/test";

export type Theme = "dark" | "light";

/** A fixed wall-clock instant. SongNav compares Date.now() against an 8-second peer-presence
 *  window, so without pinning the clock the collaborator state is a race and the shot flickers. */
const FROZEN_MS = 1_760_000_000_000;

export async function bootShell(
  page: Page,
  theme: Theme,
  extraSettings: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript(
    ({ t, now, extra }) => {
      window.localStorage.clear();
      window.localStorage.setItem(
        "mosh.settings",
        JSON.stringify({ version: 2, template: null, values: { theme: t, ...extra }, keyOverrides: {} }),
      );
      // Freeze both clocks BEFORE any app code runs.
      const D = Date;
      class FrozenDate extends D {
        constructor(...args: unknown[]) {
          // @ts-expect-error - forwarding a variadic Date ctor
          super(...(args.length ? args : [now]));
        }
        static now() { return now; }
      }
      // @ts-expect-error - deliberate global swap for determinism
      window.Date = FrozenDate;
      try {
        Object.defineProperty(window.performance, "now", { value: () => 0, configurable: true });
      } catch { /* some engines lock performance.now; the Date freeze carries most of it */ }
    },
    { t: theme, now: FROZEN_MS, extra: extraSettings },
  );

  await page.goto("/?shell=v2");

  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();

  // ANTI-VACUITY. Without these a broken mock yields the boot placeholder, and a baseline of the
  // placeholder is perfectly stable and completely meaningless — the exact failure this whole
  // fixture exists to avoid. Assert the real shell is on screen before anything is captured.
  await expect(
    page.getByText("Running outside the engine"),
    "boot fallback rendered — the mock backend is not active, so this shot proves nothing",
  ).toHaveCount(0);
  await expect(page.locator(".v2-lhead"), "seeded tracks are missing").toHaveCount(4); // 3 tracks + add-track
  await expect(page.locator(".v2-clip"), "seeded clips are missing").toHaveCount(3);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Wait until nothing is still moving. */
export async function stillness(page: Page): Promise<void> {
  // TrackLaneList runs a rAF easing each lane's --lvl toward the live meter level. Stopped, the
  // target is 0 and it converges; playing, it never settles — so assert stopped, then wait for
  // convergence rather than sleeping and hoping.
  await page.waitForFunction(
    () => {
      const lanes = [...document.querySelectorAll<HTMLElement>("[data-track-id]")];
      if (!lanes.length) return false;
      return lanes.every((l) => Math.abs(parseFloat(getComputedStyle(l).getPropertyValue("--lvl") || "0")) <= 0.001);
    },
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate(() => document.fonts.ready);
}

// Two elements paint from a rAF loop that `animations: "disabled"` cannot reach — that option
// stops CSS animations, not JavaScript canvas rendering. Left alone they move 128-316px between
// consecutive frames and Playwright never gets two stable screenshots:
//
//   .moshi-mount    the Moshi character (src/ui/Moshi.tsx) — a continuously rendered canvas that
//                   does not honour prefers-reduced-motion
//   .v2-pcard-level the presence meter (src/v2/PresenceMeter.tsx) — driven by a live AnalyserNode,
//                   so its FFT is not reproducible even with a frozen clock
//
// They are MASKED rather than hidden, and masked narrowly: only the canvas host, never the card
// around it. So the Moshi card's surface, its status text, and its accents remain covered — it is
// only the character's own pixels that are excluded.
//
// KNOWN LIMIT, stated so a green run is not over-read: these baselines cannot see a regression in
// the character's rendering. That belongs to the Character Lab, not to a shell screenshot gate.
const MASKED = [".moshi-mount", ".v2-pcard-level"];

/** Capture one shot. `animations: "disabled"` is passed EXPLICITLY — the option configured under
 *  `expect.toHaveScreenshot` in the config does not apply to a bare page.screenshot(), and being
 *  explicit here keeps the two paths from drifting. */
export async function shot(page: Page, name: string, theme: Theme) {
  await stillness(page);
  await expect(page).toHaveScreenshot(`${name}-${theme}.png`, {
    animations: "disabled",
    mask: MASKED.map((sel) => page.locator(sel)),
  });
}
