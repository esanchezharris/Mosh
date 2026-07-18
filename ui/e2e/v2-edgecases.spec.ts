import { test, expect, type Page } from "@playwright/test";
import { bootV2 } from "./helpers";

// Edge-case regression net for the v2 shell — one describe per sweep lens.
// Born from docs/playtest-prep/EDGECASE_SWEEP_V2_2026-07-18.md; each test cites
// the finding it pins. All state forcing goes through the sanctioned dev-only
// `window.__moshStore` side-channel (same discipline as multiplayer.spec).

type StoreHandle = {
  getState: () => {
    exec: (cmd: string, args?: object) => Promise<unknown>;
    snapshot: { tracks: { id: string; name: string; clips: { id: string; type: string }[] }[] };
    select: (ids: string[]) => void;
    lastError: string | null;
  };
  setState: (s: object) => void;
};

function store(page: Page) {
  return {
    exec: (cmd: string, args: object = {}) =>
      page.evaluate(
        ([c, a]) => (window as unknown as { __moshStore: StoreHandle }).__moshStore.getState().exec(c as string, a as object),
        [cmd, args] as const,
      ),
    setState: (s: object) =>
      page.evaluate((st) => (window as unknown as { __moshStore: StoreHandle }).__moshStore.setState(st), s),
    snapshot: () =>
      page.evaluate(() => (window as unknown as { __moshStore: StoreHandle }).__moshStore.getState().snapshot),
    lastError: () =>
      page.evaluate(() => (window as unknown as { __moshStore: StoreHandle }).__moshStore.getState().lastError),
  };
}

test.describe("L1 · overlay/Escape stacking", () => {
  test("overflow menu dismisses on Escape (#41)", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-overflow").click();
    await expect(page.getByTestId("v2-overflow-tools")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v2-overflow-tools")).not.toBeVisible();
    await expect(page.getByTestId("v2-overflow")).toHaveAttribute("aria-expanded", "false");
  });

  test("Escape closes the overflow menu on top, NOT the modal beneath it (#43)", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-share").click();
    await expect(page.getByTestId("mp-launcher-modal")).toBeVisible();
    // The modal backdrop covers the topbar, so a pointer can't reach ⋯ here; force
    // the menu open via direct DOM click (same component path) to pin the ORDERING
    // property: Escape must pop the most-recently-opened overlay first.
    await page.evaluate(() => (document.querySelector('[data-testid="v2-overflow"]') as HTMLElement).click());
    await expect(page.getByTestId("v2-overflow-tools")).toBeVisible();
    await page.keyboard.press("Escape");
    // topmost only: the menu goes, the MP modal stays
    await expect(page.getByTestId("v2-overflow-tools")).not.toBeVisible();
    await expect(page.getByTestId("mp-launcher-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mp-launcher-modal")).not.toBeVisible();
  });

  test("join with an unknown room code shows INLINE feedback in the panel (#42)", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-share").click();
    await page.getByLabel("Room code to join").fill("JUNK-CODE-999");
    await page.getByTestId("mp-launcher-modal").getByRole("button", { name: "Join", exact: true }).click();
    // 3 tracks in the mock project → the destructive-join confirm gates first
    await page.getByTestId("mp-join-confirm").getByRole("button", { name: "Join anyway" }).click();
    const inline = page.getByTestId("mp-join-error");
    await expect(inline).toBeVisible();
    await expect(inline).toContainText(/no such room/i);
    await expect(page.getByTestId("mp-launcher-modal")).toBeVisible(); // still there to retry
    expect(await store(page).lastError()).toMatch(/no such room/i);    // global surface too
  });

  test("lock-denied errors show the peer's NAME, not the raw UUID (#40)", async ({ page }) => {
    await bootV2(page);
    await store(page).setState({
      peers: { "550e8400-e29b-41d4-a716-446655440000": { name: "Bo", color: "#e0457b", online: true } },
      lastError: "blocked: locked by 550e8400-e29b-41d4-a716-446655440000",
    });
    const bar = page.getByTestId("v2-error");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("locked by Bo");
    await expect(bar).not.toContainText("550e8400");
  });

  test("piano roll still closes on Escape (stack sanity)", async ({ page }) => {
    await bootV2(page);
    const midiClip = page.locator('[data-clip-id]').filter({ has: page.locator(":scope") }).nth(1);
    await midiClip.dblclick();
    await expect(page.getByRole("dialog", { name: /piano roll/i })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /piano roll/i })).not.toBeVisible();
  });
});

// WCAG-ish relative-luminance contrast between two computed rgb() strings — enough
// to catch the "invisible text" class (ratios near 1) without a full a11y audit.
const contrastOf = `(fg, bg) => {
  const lum = (c) => {
    const m = c.match(/\\d+(\\.\\d+)?/g).map(Number);
    const [r, g, b] = m.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, c] = [lum(fg), lum(bg)];
  return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
}`;

test.describe("L2/L9/L12 · modal + error-surface soundness", () => {
  test("classic modals inside the v2 shell keep readable text in the CREAM theme (#44)", async ({ page }) => {
    await bootV2(page); // default = cream/light ground
    await page.getByTestId("v2-share").click();
    const ratio = await page.evaluate((contrastSrc) => {
      const contrast = eval(contrastSrc) as (fg: string, bg: string) => number;
      const modal = document.querySelector('[data-testid="mp-launcher-modal"]')!;
      const head = modal.querySelector(".modal-head strong")!;
      return contrast(getComputedStyle(head).color, getComputedStyle(modal).backgroundColor);
    }, contrastOf);
    expect(ratio).toBeGreaterThan(4);
  });

  test("MP roster rows truncate hostile peer names instead of blowing the modal open (#45/#46)", async ({ page }) => {
    await bootV2(page);
    await store(page).exec("mp_create_session", {});
    await store(page).setState({
      peers: {
        "uuid-long": { name: "x".repeat(220), color: "#ffaa00", online: true },
        "uuid-empty": { name: "", color: "#22dd88", online: true },
      },
    });
    await page.getByTestId("v2-share").click();
    const modal = page.getByTestId("mp-launcher-modal");
    await expect(modal).toBeVisible();
    const geom = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="mp-launcher-modal"]')!;
      return { scrollW: m.scrollWidth, clientW: m.clientWidth };
    });
    expect(geom.scrollW).toBeLessThanOrEqual(geom.clientW + 2);
    await expect(modal.locator(".mp-peer-name").last()).not.toHaveText(""); // unnamed fallback
  });

  test("an unbroken 400-char error wraps inside the bar — the stage must not displace (#53)", async ({ page }) => {
    await bootV2(page);
    const stageXBefore = await page.evaluate(() => document.querySelector('[data-testid="v2-timeline"]')!.getBoundingClientRect().x);
    await store(page).setState({ lastError: "blocked: " + "x".repeat(400) });
    const bar = page.getByTestId("v2-error");
    await expect(bar).toBeVisible();
    const m = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="v2-error"]')!.getBoundingClientRect();
      const s = document.querySelector('[data-testid="v2-timeline"]')!.getBoundingClientRect();
      return { barRight: b.right, stageX: s.x, vw: window.innerWidth };
    });
    expect(m.barRight).toBeLessThanOrEqual(m.vw + 2);
    expect(Math.abs(m.stageX - stageXBefore)).toBeLessThan(8);
  });

  test("the v2 error bar is readable in the CREAM theme (#54)", async ({ page }) => {
    await bootV2(page);
    await store(page).setState({ lastError: "something went wrong" });
    const ratio = await page.evaluate((contrastSrc) => {
      const contrast = eval(contrastSrc) as (fg: string, bg: string) => number;
      const bar = document.querySelector('[data-testid="v2-error"]')!;
      // effective ground behind the translucent wash is the cream shell — composite
      // approximation: compare against the shell bg, the dominant ground.
      const shellBg = getComputedStyle(document.querySelector('[data-testid="v2-shell"]')!).backgroundColor;
      const ground = /rgba?\(0, 0, 0, 0\)/.test(shellBg)
        ? getComputedStyle(document.body).backgroundColor
        : shellBg;
      return contrast(getComputedStyle(bar).color, ground);
    }, contrastOf);
    expect(ratio).toBeGreaterThan(3);
  });
});

test.describe("L4/L5/L10 · degenerate states", () => {
  test("a zero-track project still offers an Add-track affordance (#47)", async ({ page }) => {
    await bootV2(page);
    const snap = await store(page).snapshot();
    for (const t of snap.tracks) await store(page).exec("remove_track", { trackId: t.id });
    await expect(page.getByText(/no tracks yet/i)).toBeVisible();
    const add = page.getByRole("button", { name: /add.*track/i });
    await expect(add).toBeVisible();
    await add.click();
    await expect(page.locator('[data-track-id], .v2-lane').first()).toBeVisible();
  });

  test("selecting a fully-overlapped clip raises it so the pointer can reach it (#48)", async ({ page }) => {
    await bootV2(page);
    const snap = await store(page).snapshot();
    const track = snap.tracks[0];
    await store(page).exec("add_midi_clip", { trackId: track.id, start: 20, length: 0.5 });
    await store(page).exec("add_midi_clip", { trackId: track.id, start: 20, length: 4 });
    const under = await page.evaluate(() => {
      const clips = [...document.querySelectorAll('[data-clip-id]')];
      const tiny = clips.find((c) => c.getBoundingClientRect().width < 30)!;
      return tiny.getAttribute("data-clip-id");
    });
    // select the buried clip (marquee/inspector path = store selection)
    await page.evaluate((id) => {
      (window as unknown as { __moshStore: { getState: () => { select: (ids: string[]) => void } } })
        .__moshStore.getState().select([id!]);
    }, under);
    const onTop = await page.evaluate((id) => {
      const tiny = document.querySelector(`[data-clip-id="${id}"]`)!;
      const r = tiny.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit?.closest("[data-clip-id]")?.getAttribute("data-clip-id");
    }, under);
    expect(onTop).toBe(under);
  });

  test("the Inspector header follows the selected clip's OWN track (#55)", async ({ page }) => {
    await bootV2(page);
    // Drums is the auto-selected track; the wave clip lives on Keys.
    await page.locator('[data-clip-id].wave, .v2-clip.wave').first().click();
    await expect(page.locator(".v2-inspector .v2-card-head")).toContainText("Keys");
  });

  test("the Inspector title truncates a hostile track name to one line (#49)", async ({ page }) => {
    await bootV2(page);
    const snap = await store(page).snapshot();
    await store(page).exec("rename_track", { trackId: snap.tracks[0].id, name: "🔥🎹💀".repeat(80) });
    await page.locator('[data-clip-id]').first().click(); // ensure inspector visible + selection
    const head = page.locator(".v2-inspector .v2-card-head");
    await expect(head).toBeVisible();
    const h = await head.evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeLessThan(40);
  });
});

test.describe("L7 · viewport floor", () => {
  test("below the shell's min width the layout scrolls instead of self-destructing (#52)", async ({ page }) => {
    await bootV2(page);
    await page.setViewportSize({ width: 900, height: 700 });
    const m = await page.evaluate(() => {
      const shell = document.querySelector('[data-testid="v2-shell"]')!;
      const name = document.querySelector(".v2-proj-name")!.getBoundingClientRect();
      const transport = document.querySelector('[class*="transport"]')!.getBoundingClientRect();
      const ox = Math.min(name.right, transport.right) - Math.max(name.x, transport.x);
      const oy = Math.min(name.bottom, transport.bottom) - Math.max(name.y, transport.y);
      return { canScrollX: shell.scrollWidth > shell.clientWidth, overlap: ox > 8 && oy > 8 };
    });
    expect(m.overlap).toBe(false);     // controls never pile on each other…
    expect(m.canScrollX).toBe(true);   // …because the shell keeps a floor and scrolls
  });
});
