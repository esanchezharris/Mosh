import { test, expect, type Locator, type Page } from "@playwright/test";
import { bootV3 } from "./helpers";

// Round-2 review (U4): the Booth's "Hear myself: On" was unreadable — lime text on a lime fill.
// mosh.css paints every pressed .btn (`.btn.on`, `.btn[aria-pressed=true]`) with a --lime fill,
// and the V3 rule on top of it only recoloured the TEXT to the accent. Turning it Off then left
// the pointer on a button whose hover ink came from mosh.css too: `.btn:hover` sets --bone,
// which the default LIGHT theme makes near-black — on V3's dark button (1.2:1). This reads the
// real computed colours, composites them the way the browser does, and holds the V3 .btn states
// to WCAG AA (4.5:1 — these are 10–11 px labels) in every colorway.

const COLORWAYS = ["lime", "bone", "violet", "coral"] as const;
const AA = 4.5;

type Rgb = [number, number, number];

const luminance = ([r, g, b]: Rgb) => {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** The element's text colour and the ground it sits on, as sRGB bytes. Chromium reports
 *  color-mix results in oklab, so each colour is painted onto a 1×1 canvas and read back; the
 *  ground is every ancestor's background composited in order, so a translucent fill counts. */
async function inkAndGround(el: Locator): Promise<{ ink: Rgb; ground: Rgb }> {
  return el.evaluate((node) => {
    const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    const read = (): [number, number, number] => { const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!]; };
    const chain: Element[] = [];
    for (let n: Element | null = node; n; n = n.parentElement) chain.unshift(n);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 1, 1);
    for (const n of chain) { ctx.fillStyle = getComputedStyle(n).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
    const ground = read();
    ctx.fillStyle = getComputedStyle(node).color; ctx.fillRect(0, 0, 1, 1);
    return { ink: read(), ground };
  });
}

async function hearMyselfOn(page: Page): Promise<Locator> {
  type BoothWindow = Window & { __moshStore?: { getState: () => {
    exec: (command: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown }>;
    refresh: () => Promise<void>;
    setSelectedTrack: (id: string | null) => void;
  } } };
  await page.evaluate(async () => {
    const store = (window as unknown as BoothWindow).__moshStore!;
    await store.getState().exec("new_project", {});
    const drums = await store.getState().exec("create_track", { name: "Drums", type: "drum" });
    await store.getState().refresh();
    store.getState().setSelectedTrack((drums.data as { trackId: string }).trackId);
  });
  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-templates").hover();
  await page.getByTestId("v3-template-booth").click();
  await page.getByTestId("v3-booth-setup").click();
  const hear = page.getByTestId("v3-booth-monitor");
  await expect(hear).toHaveText("Hear myself: On");
  await expect(hear).toHaveAttribute("aria-pressed", "true");
  return hear;
}

test("Hear myself: On is readable in every colorway", async ({ page }) => {
  await bootV3(page);
  const hear = await hearMyselfOn(page);
  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-open-settings").click();
  await expect(page.getByTestId("v3-settings")).toBeVisible();

  const seen: string[] = [];
  for (const colorway of COLORWAYS) {
    await page.locator(`[data-testid="v3-colorway"][data-colorway="${colorway}"]`).click();
    await expect(page.getByTestId("v3-shell")).toHaveAttribute("data-colorway", colorway);
    const { ink, ground } = await inkAndGround(hear);
    seen.push(JSON.stringify(ink));
    expect(contrast(ink, ground), `${colorway}: ink ${ink} on ${ground}`).toBeGreaterThanOrEqual(AA);
  }
  // Anti-vacuity: the pressed state still follows the colorway rather than one fixed colour.
  expect(new Set(seen).size).toBe(COLORWAYS.length);

  // …and "Off" is the quiet, unpressed button — readable under the pointer that just turned it
  // off (the hover state) and at rest.
  await page.keyboard.press("Escape");
  await hear.click();
  await expect(hear).toHaveText("Hear myself: Off");
  const hovered = await inkAndGround(hear);
  expect(contrast(hovered.ink, hovered.ground), `off, hovered: ink ${hovered.ink} on ${hovered.ground}`).toBeGreaterThanOrEqual(AA);
  await page.mouse.move(1, 1);
  const resting = await inkAndGround(hear);
  expect(contrast(resting.ink, resting.ground), `off, at rest: ink ${resting.ink} on ${resting.ground}`).toBeGreaterThanOrEqual(AA);
});

// Round-3 review (Q1): the V3 hover rule recoloured the ink of EVERY .btn inside .v3-shell, and
// mosh's filled .btn.primary keeps its --lime-glow fill on hover — so "Create session" in the V3
// Invite dialog went near-white on lime (about 1:1) under the pointer. The real button, in every
// colorway, at rest and hovered.
test("Create session (a mosh .btn.primary) in the V3 Invite dialog is readable at rest and hovered", async ({ page }) => {
  await bootV3(page);
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("light");
  await page.getByTestId("v3-mp-trigger").click();
  const modal = page.getByTestId("mp-launcher-modal");
  await expect(modal).toBeVisible();
  const create = modal.getByRole("button", { name: "Create session" });
  await expect(create).toHaveClass(/\bprimary\b/);
  // Anti-vacuity: it really renders inside the V3 shell, where the V3 hover rule applies.
  expect(await create.evaluate((el) => el.closest(".v3-shell") !== null)).toBe(true);
  const shell = page.getByTestId("v3-shell");
  for (const colorway of COLORWAYS) {
    await shell.evaluate((el, c) => el.setAttribute("data-colorway", c), colorway);
    for (const state of ["at rest", "hovered"] as const) {
      if (state === "hovered") await create.hover();
      else await page.mouse.move(1, 1);
      const { ink, ground } = await inkAndGround(create);
      expect(contrast(ink, ground), `${colorway} · Create session · ${state}: ink ${ink} on ${ground}`)
        .toBeGreaterThanOrEqual(AA);
    }
  }
});

// Every other pressed .btn variant V3 styles, probed outside React in a standalone shell, so
// the fix holds for the class and not just for the one button that was reported. The filled
// mosh variants V3 renders in shared dialogs (.primary, .danger) ride along (Q1): V3's hover
// must leave their ink alone. (.danger is mosh's own white on --rec, 3.5:1 at rest in every
// shell — below AA, but a shared-palette question outside this rule, so it is held only to
// "hover does not recolour it".)
test("every pressed V3 .btn variant is readable in every colorway", async ({ page }) => {
  await bootV3(page);
  await page.evaluate(() => {
    const shell = document.createElement("div");
    shell.className = "v3-shell";
    shell.dataset.testid = "pressed-probe";
    shell.innerHTML = `
      <button class="btn on" data-variant="btn.on">A</button>
      <button class="btn" aria-pressed="true" data-variant="btn[aria-pressed]">B</button>
      <div class="booth-monitor-row"><button class="btn on" aria-pressed="true" data-variant="booth monitor">C</button></div>
      <div class="direct-reimagine"><button class="btn" aria-pressed="true" data-variant="Re-Imagine audition">D</button></div>
      <div class="booth-pads"><button class="btn pri on" data-variant="booth record pad (recording)">E</button></div>
      <button class="btn sm on" data-variant="btn.sm.on">F</button>
      <button class="btn" data-variant="unpressed btn">G</button>
      <button class="btn primary" data-filled data-variant="mosh .btn.primary (Create session, Capture, Confirm)">H</button>
      <button class="btn danger" data-filled data-aa-exempt data-variant="mosh .btn.danger (a destructive Confirm)">I</button>`;
    document.body.appendChild(shell);
  });
  const probe = page.getByTestId("pressed-probe");
  const variants = probe.locator("button:not([data-aa-exempt])");
  const count = 8;
  await expect(variants).toHaveCount(count);
  const filled = probe.locator("button[data-filled]");
  await expect(filled).toHaveCount(2);
  // The app's default theme is light (settings schema), which is what makes mosh.css's hover
  // ink dark; pin it so this check cannot pass by running under the dark theme.
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("light");
  for (const colorway of COLORWAYS) {
    await probe.evaluate((el, c) => el.setAttribute("data-colorway", c), colorway);
    for (let i = 0; i < count; i++) {
      const button = variants.nth(i);
      const name = await button.getAttribute("data-variant");
      for (const state of ["at rest", "hovered"] as const) {
        if (state === "hovered") await button.hover();
        else await page.mouse.move(1, 1);
        const { ink, ground } = await inkAndGround(button);
        expect(contrast(ink, ground), `${colorway} · ${name} · ${state}: ink ${ink} on ${ground}`).toBeGreaterThanOrEqual(AA);
      }
    }
    // A filled mosh button keeps its own ink under the pointer (mosh's :hover rules keep it).
    for (let i = 0; i < 2; i++) {
      const button = filled.nth(i);
      const name = await button.getAttribute("data-variant");
      await page.mouse.move(1, 1);
      const rest = await inkAndGround(button);
      await button.hover();
      const hovered = await inkAndGround(button);
      expect(hovered.ink, `${colorway} · ${name}: hover recoloured the ink ${rest.ink} → ${hovered.ink}`).toEqual(rest.ink);
    }
  }
});
