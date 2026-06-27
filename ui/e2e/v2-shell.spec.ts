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
  await expect(dock.getByPlaceholder("Search by name or vendor…")).toBeVisible();
  await expect(dock.getByTestId("v2-pb-collection").first()).toBeVisible(); // collection chips
  await expect(dock.getByTestId("v2-pb-row").first()).toBeVisible();        // plugin rows
  await expect(page.getByTestId("v2-browser-drawer").getByTestId("content-browser")).toHaveCount(0);
  // close
  await page.getByTestId("v2-browser-close").click();
  await expect(page.getByTestId("v2-browser-tab-sounds")).toHaveCount(0);
});

test("boots the v2 shell with topbar, tracks, composer and the always-on rail", async ({ page }) => {
  await bootV2(page);
  await expect(page.getByTestId("v2-topbar")).toBeVisible();
  await expect(page.getByTestId("v2-track-header")).toHaveCount(3);
  await expect(page.getByTestId("v2-composer")).toBeVisible();
  // the agent lives "maximized" in the always-on right rail (its only live WebGL mount)
  await expect(page.getByTestId("v2-rail")).toBeVisible();
  await expect(page.locator('[data-testid="v2-mosh-card"] canvas')).toBeVisible();
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

test("the rail inspector reveals Mix/FX/Gen for the selected track", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").first().click();
  await expect(page.getByTestId("v2-inspector")).toBeVisible(); // always-on rail
  await page.getByTestId("v2-insp-tab-fx").click();
  await expect(page.locator('[data-testid="v2-insp-body"] [data-testid="rack"]')).toBeVisible();
  await page.getByTestId("v2-insp-tab-gen").click();
  await expect(page.locator('[data-testid="v2-insp-body"] [data-testid="generative"]')).toBeVisible();
});

test("generative runs on a MIDI/drum track (any track, via the backend auto-bounce)", async ({ page }) => {
  await bootV2(page);
  // The seeded Drums track is a MIDI drum clip (no wave clip) — generative must still
  // offer create/render/accept (the native backend auto-bounces it to audio first).
  await page.getByTestId("v2-track-header").first().click();
  await expect(page.getByTestId("v2-inspector")).toBeVisible(); // always-on rail
  await page.getByTestId("v2-insp-tab-gen").click();
  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();
  await expect(gen.getByTestId("gen-create")).toBeVisible(); // create offered on a non-wave clip
  await gen.getByTestId("gen-create").click();
  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");
  const accept = gen.getByTestId("gen-accept");
  await expect(accept).toBeEnabled();
  await accept.click();
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
  await expect(page.getByTestId("v2-invite")).toBeVisible();
  await expect(page.getByTestId("v2-collab-peer")).toHaveCount(0);
  // the agent never rides the prompt bar anymore (it's maximized in the rail)
  await expect(page.getByTestId("v2-composer-agent")).toHaveCount(0);
  // a collaborator joins → their tile appears in the same rail
  await enterPeersMode(page);
  await expect(page.getByTestId("v2-collab-peer")).toBeVisible();
});

test("section ribbon: '+' creates a section and opens it for rename", async ({ page }) => {
  await bootV2(page);
  await expect(page.getByTestId("v2-section")).toHaveCount(3); // Intro / Verse / Hook seed
  await page.getByTestId("v2-section-add").click();
  await expect(page.getByTestId("v2-section")).toHaveCount(4);
  const input = page.getByTestId("v2-section-rename"); // auto-opens on the new section
  await expect(input).toBeVisible();
  await input.fill("Outro");
  await input.press("Enter");
  await expect(page.getByTestId("v2-section").last()).toContainText("Outro");
});

test("section ribbon: double-click renames an existing section", async ({ page }) => {
  await bootV2(page);
  const first = page.getByTestId("v2-section").first();
  await expect(first).toContainText("Intro");
  await first.dblclick();
  const input = page.getByTestId("v2-section-rename");
  await expect(input).toBeVisible();
  await input.fill("Bridge");
  await input.press("Enter");
  await expect(page.getByTestId("v2-section").first()).toContainText("Bridge");
});

test("section ribbon: ✕ removes a section", async ({ page }) => {
  await bootV2(page);
  await expect(page.getByTestId("v2-section")).toHaveCount(3);
  await page.getByTestId("v2-section").first().getByTestId("v2-section-remove").click();
  await expect(page.getByTestId("v2-section")).toHaveCount(2);
});

test("section ribbon: a quick click across two sections seeks (does not spuriously rename)", async ({ page }) => {
  await bootV2(page);
  // Click Intro, then quickly Verse — a shared double-click timer must not treat two
  // single-clicks on DIFFERENT sections as a double-click (which would open rename).
  await page.getByTestId("v2-section").nth(0).click();
  await page.getByTestId("v2-section").nth(1).click();
  await expect(page.getByTestId("v2-section-rename")).toHaveCount(0);
});

test("section ribbon: ✕ removes without seeking the playhead", async ({ page }) => {
  await bootV2(page);
  await expect(page.getByTestId("v2-time")).toHaveText("1.1.1");
  // Remove Hook (starts at beat 24) — the ✕ must not also fire a transport seek.
  await page.getByTestId("v2-section").last().getByTestId("v2-section-remove").click();
  await expect(page.getByTestId("v2-section")).toHaveCount(2);
  await expect(page.getByTestId("v2-time")).toHaveText("1.1.1");
});

test("section ribbon: interacting inside the rename input never discards the draft", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-section").first().dblclick();
  const input = page.getByTestId("v2-section-rename");
  await input.fill("WIP");
  await input.dblclick(); // a double-click inside the input must not reset the draft
  await expect(input).toHaveValue("WIP");
});

test("section ribbon: dragging a section body moves it (snapped to the bar)", async ({ page }) => {
  await bootV2(page);
  // Verse (2nd) so there's room to move right without clamping at 0.
  const seg = page.getByTestId("v2-section").nth(1);
  const before = await seg.getAttribute("data-start-beat");
  const box = await seg.boundingBox();
  if (!box) throw new Error("no section");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(() => page.getByTestId("v2-section").nth(1).getAttribute("data-start-beat"))
    .not.toBe(before);
});
