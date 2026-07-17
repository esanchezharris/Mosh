import { test, expect, type Page } from "@playwright/test";

// E2E for the v2 shell (the from-scratch Mosh interface), driven via the dev `?shell=v2`
// override against the in-memory mock backend — the same contract the native engine
// exposes. Covers the focused producer loop: boot, transport, inspector disclosure,
// clip move/split, the agent toast, and the collaborator camera affordance.

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

// Drive multiplayer presence directly (the in-memory mock has no relay) via the dev-only
// store handle, so we can exercise the "collaborators present" layout mode.
async function enterPeersMode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __moshStore?: { setState: (s: object) => void } }).__moshStore;
    store?.setState({
      mp: { active: true, roomCode: "TEST", selfPeer: "me", connected: true },
      peers: { ava: { name: "Ava", color: "#c2f53f", online: true } },
    });
  });
}

test("defaults to the cream (light) theme when nothing is persisted", async ({ page }) => {
  // No theme override here (bootV2 pins dark) — exercise the shipped default.
  await page.addInitScript(() => { window.localStorage.clear(); });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("left browser drawer: pull-tab opens it, tabs switch, close dismisses", async ({ page }) => {
  await bootV2(page);
  // parked: only the pull-tab is present, no tab buttons mounted
  await expect(page.getByTestId("v2-browser-pull")).toBeVisible();
  await expect(page.getByTestId("v2-browser-tab-sounds")).toHaveCount(0);
  // open → Sounds tab shows the sample browser list
  await page.getByTestId("v2-browser-pull").click();
  await expect(page.getByTestId("v2-browser-tab-sounds")).toBeVisible();
  await expect(page.getByTestId("v2-browser-drawer").getByTestId("content-browser")).toBeVisible();
  // switch to Plugins → the compact plugin dock appears (the shared picker; sample browser unmounts)
  await page.getByTestId("v2-browser-tab-plugins").click();
  const dock = page.getByTestId("v2-plugin-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId("v2-pb-search")).toBeVisible();
  await expect(dock.getByTestId("v2-pb-collection").first()).toBeVisible(); // collection chips
  await expect(dock.getByTestId("v2-pb-row").first()).toBeVisible();        // plugin rows
  await expect(page.getByTestId("v2-browser-drawer").getByTestId("content-browser")).toHaveCount(0);
  // close
  await page.getByTestId("v2-browser-close").click();
  await expect(page.getByTestId("v2-browser-tab-sounds")).toHaveCount(0);
});

// FIT-003 — v2 previously had NO rescan control and no progress UI at all (the classic
// modal already did). This proves the dock's new Rescan control round-trips cleanly.
test("plugins dock: rescan control exists and completes without error", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-browser-pull").click();
  await page.getByTestId("v2-browser-tab-plugins").click();
  const dock = page.getByTestId("v2-plugin-dock");
  const rescanBtn = dock.getByTestId("v2-pb-rescan");
  await expect(rescanBtn).toBeVisible();
  await expect(rescanBtn).toHaveText("Rescan");

  await rescanBtn.click();

  // The dev mock's rescan_plugins always completes synchronously (there is no dev-mock
  // AU sweep to sample), so the button settles back to "Rescan" and the live status line
  // (rendered only while scanProgress is set) is gone; the catalog is still populated.
  await expect(rescanBtn).toHaveText("Rescan");
  await expect(dock.getByTestId("v2-pb-scan-status")).toHaveCount(0);
  await expect(dock.getByTestId("v2-pb-row").first()).toBeVisible();
});

test("right agent dock: collapses to a Moshi pull-tab and re-expands", async ({ page }) => {
  await bootV2(page);
  // open by default → the agent rail (the live WebGL Moshi) is mounted
  await expect(page.getByTestId("v2-rail")).toBeVisible();
  await expect(page.locator('[data-testid="v2-mosh-card"] canvas')).toBeVisible();
  // collapse → the rail unmounts, a pull-tab carrying the minimized Moshi mark takes its place
  await page.getByTestId("v2-rail-collapse").click();
  await expect(page.getByTestId("v2-rail")).toHaveCount(0);
  const pull = page.getByTestId("v2-right-pull");
  await expect(pull).toBeVisible();
  await expect(pull.locator("svg.v2-mark")).toBeVisible(); // the minimized Moshi stays present
  // re-expand → the maximized agent (canvas) is back
  await pull.click();
  await expect(page.getByTestId("v2-rail")).toBeVisible();
  await expect(page.locator('[data-testid="v2-mosh-card"] canvas')).toBeVisible();
});

test("boots the v2 shell with topbar, tracks, composer and the always-on rail", async ({ page }) => {
  await bootV2(page);
  await expect(page.getByTestId("v2-topbar")).toBeVisible();
  await expect(page.getByTestId("v2-track-header")).toHaveCount(3);
  await expect(page.getByTestId("v2-composer")).toBeVisible();
  // the agent lives "maximized" in the right dock — the live WebGL Moshi
  await expect(page.getByTestId("v2-rail")).toBeVisible();
  await expect(page.locator('[data-testid="v2-mosh-card"] canvas')).toBeVisible();
});

test("the decorative glyph in the Mosh status live region is aria-hidden", async ({ page }) => {
  await bootV2(page);
  // role=status/aria-live=polite re-announces on every status change — the leading ⩘ is
  // purely decorative, so it must be hidden from screen readers (matches ChangeToast).
  await expect(page.locator('[data-testid="v2-mosh-status"] .wave')).toHaveAttribute("aria-hidden", "true");
});

test("the topbar overflow menu exposes its items as role=menuitem (a11y)", async ({ page }) => {
  await bootV2(page);
  // The menu declares role="menu"; its children must carry role="menuitem" or the menu
  // announces zero operable items (matches the ClipView clip menu precedent).
  await expect(page.getByRole("menuitem")).toHaveCount(0); // closed → nothing mounted
  await page.getByTestId("v2-overflow").click();
  // Undo/Redo + Mute-Moshi + Hands-free + theme + Switch-to-Classic = at least 6 items.
  await expect(page.getByRole("menuitem")).toHaveCount(6);
});

test("top-right primary controls stay visible and secondary tools move into overflow", async ({ page }) => {
  for (const width of [1440, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await bootV2(page);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("missing viewport");

    const controls = [
      page.locator(".v2-pill").first(),
      page.getByTestId("v2-share"),
      page.getByTestId("v2-overflow"),
    ];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      if (!box) throw new Error("missing control bounds");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
  }

  await expect(page.getByTestId("v2-tools")).toHaveCount(0);
  await page.getByTestId("v2-overflow").click();
  await expect(page.getByTestId("v2-overflow-tools")).toBeVisible();
  await expect(page.getByTestId("v2-tool-multiplayer")).toBeVisible();
  await expect(page.getByTestId("v2-tool-training")).toBeVisible();
  await expect(page.getByTestId("v2-tool-command-log")).toBeVisible();
  await expect(page.getByTestId("v2-tool-remote")).toBeVisible();
  await expect(page.getByTestId("v2-tool-help")).toBeVisible();
});

test("transport play toggles", async ({ page }) => {
  await bootV2(page);
  const transport = page.getByTestId("v2-transport");
  await expect(transport).toHaveAttribute("data-playing", "false");
  await page.getByTestId("v2-play").click();
  await expect(transport).toHaveAttribute("data-playing", "true");
  await page.getByTestId("v2-stop").click();
  await expect(transport).toHaveAttribute("data-playing", "false");
});

test("keyboard focus shows a visible focus ring (:focus-visible)", async ({ page }) => {
  await bootV2(page);
  await page.locator("body").click();           // pointer baseline, then switch to keyboard modality
  let outline = "none";
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");           // keyboard focus → :focus-visible matches
    outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el && el !== document.body ? getComputedStyle(el).outlineStyle : "none";
    });
    if (outline === "solid") break;
  }
  expect(outline).toBe("solid");                // a control received the lime focus ring
});

test("hover-only plugin-dock favorite star reveals on keyboard focus (a11y)", async ({ page }) => {
  await bootV2(page);
  // open the plugin dock (same path the drawer test uses)
  await page.getByTestId("v2-browser-pull").click();
  await page.getByTestId("v2-browser-tab-plugins").click();
  await expect(page.getByTestId("v2-plugin-dock")).toBeVisible();
  // an unfavorited star is opacity:0 (revealed only on row hover) — focusing it must reveal it,
  // else the global :focus-visible ring lands on an invisible glyph.
  const star = page.locator(".v2-pb-star:not(.on)").first();
  await expect(star).toHaveCount(1);
  await star.focus();
  await expect(star).toBeFocused();
  await expect
    .poll(() => star.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
});

test("sample browser keeps import actions keyboard reachable", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-browser-pull").click();
  const row = page.getByTestId("sample-row").first();
  await expect(row).toBeVisible();
  const importButton = row.getByRole("button", { name: "Import" });
  await importButton.focus();
  await expect(importButton).toBeFocused();
  await expect.poll(() => importButton.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
});

test("the track header is keyboard-focusable and Enter selects it (a11y)", async ({ page }) => {
  await bootV2(page);
  const head = page.getByTestId("v2-track-header").first();
  await expect(head).toHaveAttribute("role", "button");
  await expect(head).toHaveAttribute("tabindex", "0");
  const name = (await head.locator(".v2-lname").textContent())?.trim();
  await expect(head).toHaveAttribute("aria-label", `Select track ${name}`);
  // Focus via keyboard modality → the existing [tabindex]:focus-visible lime ring applies.
  await head.focus();
  await expect(head).toBeFocused();
  await expect
    .poll(() => head.evaluate((el) => getComputedStyle(el).outlineStyle))
    .toBe("solid");
  // Enter activates selection (no mouse) → the always-on inspector binds to that track.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("v2-inspector")).toContainText(`Inspector · ${name}`);
});

test("the rail inspector reveals Mix/FX/Gen for the selected track", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").first().click();
  await expect(page.getByTestId("v2-inspector")).toBeVisible(); // always-on rail
  await page.getByTestId("v2-insp-tab-fx").click();
  await expect(page.locator('[data-testid="v2-insp-body"] [data-testid="rack"]')).toBeVisible();
  await page.getByTestId("v2-insp-tab-gen").click();
  await expect(page.locator('[data-testid="v2-insp-body"] [data-testid="generative"]')).toBeVisible();
});

test("the inspector tablist carries an accessible name (a11y, matches sibling v2 tablists)", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").first().click(); // bind the always-on inspector
  await expect(page.getByTestId("v2-inspector")).toBeVisible();
  await expect(page.locator('[data-testid="v2-inspector"] [role="tablist"]')).toHaveAttribute("aria-label", "Inspector tabs");
});

test("inspector Mix tab: Mute/Solo are toggles (aria-pressed reflects state)", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").first().click();
  const inspector = page.getByTestId("v2-inspector");
  await expect(inspector).toBeVisible(); // always-on rail; Mix is the default tab
  // Matches the track-header M/S toggles: each carries aria-pressed against the same
  // set_track_mute/set_track_solo command, off to start.
  const mute = inspector.getByRole("button", { name: "Mute" });
  const solo = inspector.getByRole("button", { name: "Solo" });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await expect(solo).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await solo.click();
  await expect(solo).toHaveAttribute("aria-pressed", "true");
});

test("generative runs on a MIDI/drum track (auto-bounce → hidden audio beneath, Phase 2)", async ({ page }) => {
  await bootV2(page);
  // The seeded Drums track is a MIDI drum clip (no wave clip) — generative still offers
  // create/render (the native backend auto-bounces it to audio first), and the result lands
  // as HIDDEN audio beneath the muted MIDI: Reset, never Accept.
  await page.getByTestId("v2-track-header").first().click();
  await expect(page.getByTestId("v2-inspector")).toBeVisible(); // always-on rail
  await page.getByTestId("v2-insp-tab-gen").click();
  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();
  await expect(gen.getByTestId("gen-create")).toBeVisible(); // create offered on a non-wave clip
  await gen.getByTestId("gen-create").click();
  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");
  // MIDI/drum uses the beneath-model: Reset enabled, no Accept.
  await expect(gen.getByTestId("gen-accept")).toHaveCount(0);
  const reset = gen.getByTestId("gen-reset");
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(gen.getByTestId("render-status")).toHaveText("dirty");
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

test("a clip drags to a new position", async ({ page }) => {
  await bootV2(page);
  const clip = page.getByTestId("v2-clip").first();
  const before = await clip.boundingBox();
  if (!before) throw new Error("no clip");
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 160, before.y + before.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => {
    const b = await page.getByTestId("v2-clip").first().boundingBox();
    return b ? Math.round(b.x - before.x) : 0;
  }).toBeGreaterThan(40);
});

test("right-click → split increases the clip count", async ({ page }) => {
  await bootV2(page);
  const before = await page.getByTestId("v2-clip").count();
  await page.getByTestId("v2-clip").first().click({ button: "right" });
  await expect(page.getByTestId("v2-clip-menu")).toBeVisible();
  await page.getByTestId("v2-clip-menu").getByText("Split here").click();
  await expect(page.getByTestId("v2-clip")).toHaveCount(before + 1);
});

test("the arrangement shrink-wraps to its tracks; the add-track row creates a track", async ({ page }) => {
  await bootV2(page);
  // sparse session: the stage is content-sized (shorter than the body) so cream shows below it
  const sb = await page.locator(".v2-stage").boundingBox();
  const bb = await page.locator(".v2-body").boundingBox();
  if (!sb || !bb) throw new Error("no bounds");
  expect(sb.height).toBeLessThan(bb.height - 100);
  // the trailing "+ New track" row adds a track (and the panel grows by a lane)
  const before = await page.getByTestId("v2-track-header").count();
  const h0 = sb.height;
  await page.getByTestId("v2-track-add").click();
  await expect(page.getByTestId("v2-track-header")).toHaveCount(before + 1);
  await expect.poll(async () => (await page.locator(".v2-stage").boundingBox())?.height ?? 0).toBeGreaterThan(h0);
});

test("the agent toast appears on a command and self-dismisses", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("agent-input").fill("play");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("v2-change-toast")).toBeVisible();
  await expect(page.getByTestId("v2-change-toast")).toHaveCount(0, { timeout: 12_000 });
});

test("plugin picker: + Plugin opens the dock — collections, vendor filter, search, add", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").first().click();
  await expect(page.getByTestId("v2-inspector")).toBeVisible(); // always-on rail
  await page.getByTestId("v2-insp-tab-fx").click();
  // No plugin modal in v2: "+ Plugin" opens the LEFT browser drawer on the Plugins tab.
  await page.locator('[data-testid="v2-insp-body"]').getByRole("button", { name: "+ Plugin" }).click();

  const dock = page.getByTestId("v2-plugin-dock");
  await expect(dock).toBeVisible();
  await expect(page.getByTestId("v2-browser-tab-plugins")).toHaveAttribute("aria-selected", "true");

  // the search field carries an accessible name (its icon is aria-hidden, a placeholder is not a name)
  await expect(dock.getByRole("textbox", { name: "Search plugins" })).toBeVisible();

  // collection chips: All + kind filters + a "Built-in" vendor group (no duplicate
  // Instruments/Effects vendor rows — built-ins collapse under one maker).
  await expect(dock.getByTestId("v2-pb-collection")).not.toHaveCount(0);
  await expect(dock.locator('[data-collection="all"]')).toContainText("All Plugins");
  await expect(dock.locator('[data-collection="v:Built-in"]')).toContainText("Built-in");

  // vendor filter narrows the list header + rows
  await dock.locator('[data-collection="v:Xfer"]').click();
  await expect(dock.locator(".v2-pb-listhead")).toContainText("Xfer");
  await expect(dock.getByTestId("v2-pb-row")).toHaveCount(1);

  // search narrows within the current view (use a term unique to one plugin —
  // bare "ott" now matches both Xfer OTT and the built-in Mosh OTT)
  await dock.locator('[data-collection="all"]').click();
  await dock.getByTestId("v2-pb-search").fill("mosh ott");
  await expect(dock.getByTestId("v2-pb-row")).toHaveCount(1);
  await expect(dock.getByTestId("v2-pb-row")).toContainText("OTT");

  // adding an effect lands the plugin in the FX rack; the dock stays open (it's a dock, not a modal)
  await dock.getByTestId("v2-pb-row").click();
  await expect(page.locator('[data-testid="v2-insp-body"]')).toContainText("OTT");
  await expect(dock).toBeVisible();
});

test("with collaborators present, the right rail shows the agent + camera/invite + peer tile", async ({ page }) => {
  await bootV2(page);
  await enterPeersMode(page);
  await expect(page.getByTestId("v2-rail")).toBeVisible();
  await expect(page.getByTestId("v2-mosh-card")).toBeVisible();
  await expect(page.locator('[data-testid="v2-mosh-card"] canvas')).toBeVisible(); // Moshi GL in the rail
  await expect(page.getByTestId("v2-camera-toggle")).toBeVisible();
  await expect(page.getByTestId("v2-invite")).toBeVisible();
  await expect(page.getByTestId("v2-collab-peer")).toBeVisible(); // Ava
});

test("the right rail is always present; peers add collaborator tiles", async ({ page }) => {
  await bootV2(page);
  // the rail is always on — even alone (the collaborators card shows just the invite cue)
  await expect(page.getByTestId("v2-rail")).toBeVisible();
  await expect(page.getByTestId("v2-collab-empty")).toBeVisible();
  await expect(page.getByTestId("v2-invite")).toBeVisible();
  await expect(page.getByTestId("v2-camera-toggle")).toHaveCount(0);
  await expect(page.getByTestId("v2-collab-peer")).toHaveCount(0);
  // the agent never rides the prompt bar anymore (it's maximized in the rail)
  await expect(page.getByTestId("v2-composer-agent")).toHaveCount(0);
  // a collaborator joins → their tile appears in the same rail
  await enterPeersMode(page);
  await expect(page.getByTestId("v2-collab-empty")).toHaveCount(0);
  await expect(page.getByTestId("v2-camera-toggle")).toBeVisible();
  await expect(page.getByTestId("v2-collab-peer")).toBeVisible();
});

test("song navigator: shows bar numbers and click jumps the playhead", async ({ page }) => {
  await bootV2(page);
  const nav = page.getByTestId("v2-songnav");
  await expect(nav).toBeVisible();
  // bar-number ticks across the whole song; the first one is bar 1
  await expect(nav.locator(".v2-songnav-bar").first()).toHaveText("1");
  await expect(await nav.locator(".v2-songnav-bar").count()).toBeGreaterThan(1);
  // clicking partway across jumps the transport (time readout leaves 1.1.1)
  await expect(page.getByTestId("v2-time")).toHaveText("1.1.1");
  const box = await nav.boundingBox();
  if (!box) throw new Error("no songnav");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect.poll(() => page.getByTestId("v2-time").textContent()).not.toBe("1.1.1");
});
