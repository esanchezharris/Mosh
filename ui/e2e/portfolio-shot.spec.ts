import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The portfolio screenshot — the V3 shell on the Song A showcase session (?mockSeed=portfolio),
 * framed exactly as emiliosanchezharris.com serves it: 1512×817 CSS px at 2× (3024×1634).
 *
 * Opt-in only (MOSH_PORTFOLIO_SHOT=1): it is a capture, not a regression test, though every
 * step asserts the state it needs (real peaks loaded, the splat live, the receipt present) so
 * a stale or half-rendered frame cannot pass as the deliverable.
 *
 *   MOSH_PORTFOLIO_SHOT=1 npx playwright test e2e/portfolio-shot.spec.ts --project chromium
 *
 * MOSH_PORTFOLIO_OUT overrides the output directory. The PNG is then converted with cwebp.
 */
const ENABLED = process.env.MOSH_PORTFOLIO_SHOT === "1";
const OUT = process.env.MOSH_PORTFOLIO_OUT ?? join(homedir(), "Library", "Mosh", "task-evidence", "2026-09-21-portfolio-shot");
/** Which colorways to frame (comma-separated); one PNG each: mosh-shell-<colorway>.png. */
const COLORWAYS = (process.env.MOSH_PORTFOLIO_COLORWAYS ?? "lime").split(",").map((c) => c.trim()).filter(Boolean);
const BAR_SEC = 240 / 145;
const barSec = (bar: number) => (bar - 1) * BAR_SEC;

type StoreWindow = Window & { __moshStore?: { getState: () => {
  pxPerSec: number; setPxPerSec: (v: number) => void;
  peaks: Record<string, unknown>; selectedTrackId: string | null; selection: Set<string>;
  transport: { position: number; playing: boolean };
  snapshot?: { tracks: { id: string; name: string; isReturn?: boolean; clips: { id: string; name: string; type: string }[] }[] };
  exec: (c: string, a?: Record<string, unknown>) => Promise<unknown>;
} } };
const state = <T,>(page: Page, fn: (s: ReturnType<NonNullable<StoreWindow["__moshStore"]>["getState"]>) => T) =>
  page.evaluate((src) => {
    const st = (window as unknown as StoreWindow).__moshStore!.getState();
    // eslint-disable-next-line no-new-func
    return (new Function("s", `return (${src})(s)`) as (s: unknown) => T)(st);
  }, fn.toString());

test.describe("portfolio screenshot", () => {
  test.skip(!ENABLED, "set MOSH_PORTFOLIO_SHOT=1 to capture");
  test.use({ viewport: { width: 1512, height: 817 }, deviceScaleFactor: 2 });

  for (const colorway of COLORWAYS) test(`V3 shell on the Song A session at 1512×817 @2x — ${colorway}`, async ({ page }) => {
    test.setTimeout(90_000);
    mkdirSync(OUT, { recursive: true });
    await page.addInitScript((cw) => {
      window.localStorage.clear();
      window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { colorway: cw }, keyOverrides: {} }));
    }, colorway);
    await page.goto("/?shell=v3&mockSeed=portfolio");
    await expect(page.getByTestId("v3-shell")).toHaveAttribute("data-colorway", colorway);
    await expect(page.getByTestId("v3-arrangement")).toBeVisible();
    await expect(page.getByTestId("v3-track")).toHaveCount(7);
    await expect(page.getByTestId("v3-section")).toHaveCount(7);

    // The dock's Moshi is the live splat with painted pixels, not a placeholder.
    const face = page.getByTestId("v3-moshi-face");
    await expect(face).toHaveAttribute("data-live", "true");
    await expect.poll(() => face.locator("canvas").evaluate((c) => {
      const el = c as HTMLCanvasElement; const ctx = el.getContext("2d"); if (!ctx) return -1;
      const d = ctx.getImageData(0, 0, el.width, el.height).data; let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
      return n;
    })).toBeGreaterThan(400);

    // Every wave clip has its REAL peaks in the store (SilhouetteWave draws a placeholder until then).
    const waveClips = await state(page, (s) => s.snapshot!.tracks.flatMap((t) => t.clips).filter((c) => c.type === "wave").length);
    expect(waveClips).toBeGreaterThan(10);
    await expect.poll(() => state(page, (s) => Object.keys(s.peaks).length)).toBeGreaterThanOrEqual(waveClips);

    // Zoom: a bar ≈ 66 px (16.5 px per beat, so the ruler shows bar numbers only); bars ~4–19 in view.
    await state(page, (s) => s.setPxPerSec(40));
    await expect(page.getByTestId("v3-arrangement")).toHaveAttribute("data-px-per-sec", "40");
    await expect(page.getByTestId("v3-ruler")).toHaveAttribute("data-beat-labels", "0");

    // Select the Lead track through its hook clip — the inspector shows its chain and sends.
    const lead = page.locator('[data-testid="v3-track"]').filter({ hasText: "Lead" });
    await lead.getByTestId("v3-clip").filter({ hasText: /^hook$/ }).first().click();
    await expect(lead).toHaveClass(/\bsel\b/);
    await expect(page.getByTestId("v3-inspector")).toHaveAttribute("data-track-id", "pf-lead");
    await expect(page.getByTestId("v3-plugin")).toHaveCount(3);
    await expect(page.getByTestId("v3-send")).toHaveCount(2);
    // Every slider in the inspector follows the colorway (the Sends rows used to render the
    // browser's default blue): accent-color resolves to a colour, never "auto".
    const accents = await page.locator('[data-testid="v3-inspector"] input[type="range"]').evaluateAll((els) => els.map((el) => getComputedStyle(el).accentColor));
    expect(accents.length).toBeGreaterThan(4);
    for (const a of accents) expect(a).not.toBe("auto");
    expect(new Set(accents).size).toBe(1);

    // Ask Moshi for something real: a relative send move on the selected track. The studio
    // skill runs set_send_level in the mock (−12 → −9 dB) and the dock says what it did.
    const field = page.getByTestId("v3-moshi-field");
    await field.fill("more reverb on lead");
    await field.press("Enter");
    const reply = page.locator('.v3-shell .prompt [role="status"]');
    await expect(reply).toContainText("Reverb send", { timeout: 10_000 });
    await expect(page.getByTestId("v3-send").first()).toHaveAttribute("data-send-db", "-9");
    console.log(`moshi: ${(await reply.innerText()).replace(/\s+/g, " ").trim()}`);
    await expect(field).toBeEnabled();
    await field.blur();

    // Playhead mid-hook (bar 13.5), lanes scrolled so bars ~4–19 are in view, then play.
    await state(page, (s) => s.exec("set_transport", { position: 12.5 * (240 / 145) }));
    await expect.poll(() => state(page, (s) => s.transport.position)).toBeCloseTo(barSec(13.5), 3);
    await page.locator(".v3-shell .tracks").evaluate((el) => { el.scrollLeft = 180; });
    await page.getByTestId("v3-play").click();
    await expect.poll(() => state(page, (s) => s.transport.playing)).toBe(true);
    await page.waitForTimeout(160);

    // Nothing is clipped: the last row's bottom sits above the tracks scroller's bottom edge.
    const rows = await page.locator('[data-testid="v3-track"]').last().boundingBox();
    const scroller = await page.locator(".v3-shell .tracks").boundingBox();
    expect(rows!.y + rows!.height).toBeLessThanOrEqual(scroller!.y + scroller!.height + 0.5);

    const path = join(OUT, `mosh-shell-${colorway}.png`);
    await page.screenshot({ path, fullPage: false });
    console.log(`wrote ${path}`);
  });
});
