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

// a11y — a search that collapses the plugin dock to zero rows must be announced. The empty
// message is a live region (matches the sibling scan-status line), so a screen-reader user
// hears that results vanished instead of getting silence.
test("plugins dock: the empty / no-results message is an aria-live region", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-browser-pull").click();
  await page.getByTestId("v2-browser-tab-plugins").click();
  const dock = page.getByTestId("v2-plugin-dock");
  await dock.getByTestId("v2-pb-search").fill("zzzznomatch");
  const empty = dock.locator(".v2-pb-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toHaveAttribute("role", "status");
  await expect(empty).toHaveAttribute("aria-live", "polite");
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

  // Assert the INVARIANT rather than a magic number: every operable child of the
  // role="menu" container must carry role="menuitem", or the menu announces fewer items
  // than it has. An exact count was a proxy for that, and it broke as soon as the menu
  // legitimately grew (the project actions). The floor keeps it non-vacuous.
  const menu = page.locator('.v2-menu[role="menu"]');
  const buttons = await menu.locator("button").count();
  const items = await menu.getByRole("menuitem").count();
  expect(buttons, "overflow menu rendered no buttons at all").toBeGreaterThanOrEqual(6);
  expect(items, "some menu buttons are missing role=menuitem").toBe(buttons);
});

test("top-right primary controls stay visible and secondary tools move into overflow", async ({ page }) => {
  // #52 (EDGECASE_SWEEP_V2_2026-07-18): below the shell's 1120px usability floor the
  // layout SCROLLS horizontally instead of self-destructing (the old always-on-screen
  // claim at 820px only held for the right-anchored cluster while the centred
  // transport crushed the left meta controls). Above the floor, controls must be
  // on-screen; below it, they must be reachable by scrolling the shell.
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
    if (width < 1120) {
      // floor active: shell scrolls; bring the right cluster into view first
      await page.evaluate(() => {
        const shell = document.querySelector('[data-testid="v2-shell"]')!;
        shell.scrollLeft = shell.scrollWidth;
      });
    }
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

test("transport Record exposes armed state via aria-pressed", async ({ page }) => {
  await bootV2(page);
  // Mirrors the Play/Metronome/Mute/Solo toggles: the Record button reflects its
  // armed on/off state to assistive tech through aria-pressed, not just visually.
  const rec = page.getByTestId("v2-record");
  await expect(rec).toHaveAttribute("aria-pressed", "false");
  await rec.click();
  await expect(rec).toHaveAttribute("aria-pressed", "true");
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

// UI-REACH — sketch_beatbox had NO entry point in either shell: cmdSketchBeatbox takes an
// absolute file path (not a clipId), so the clipId-based clip-menu AI actions
// (transcribe_clip/build_skeleton_from_clip) are not a fit. The sample browser's directory
// listing is: a real absolute path already exists there (list_directory), in the native
// app, the dev mock, AND here under Playwright — unlike pickFiles' native file dialog,
// which only ever resolves in the packaged app and would hang forever under the mock (no
// backend answers its promise). This drives the REAL mouse gesture end to end: a genuine
// pointerdown→mousedown→mouseup→click sequence Playwright issues, which is exactly the
// class of interaction jsdom's synthetic click() cannot reproduce (see
// SketchBeatboxDialog.test.ts's unit coverage for what jsdom CAN prove, and why it isn't
// enough on its own).
test("beatbox -> beat: the sample browser is the entry point, and it lands a playable drum clip", async ({ page }) => {
  await bootV2(page);
  const before = await page.getByTestId("v2-track-header").count();

  await page.getByTestId("v2-browser-pull").click();
  const row = page.getByTestId("sample-row").first();
  await expect(row).toBeVisible();
  const sketchButton = row.getByTestId("sample-sketch-beatbox");
  await sketchButton.click();

  const dialog = page.getByTestId("sketch-beatbox-dialog");
  await expect(dialog).toBeVisible();
  // Defaults to the PROJECT's own tempo (the mock's seed session is 120 BPM) — never a
  // hardcoded guess, since a wrong default here silently mis-times every hit.
  await expect(dialog.getByTestId("sketch-bpm-input")).toHaveValue("120");

  await dialog.getByTestId("sketch-bpm-input").fill("140");
  await dialog.getByTestId("sketch-bars-2").click();
  await dialog.getByTestId("sketch-beatbox-confirm").click();
  await expect(dialog).toHaveCount(0); // closes immediately (optimistic — async work continues)

  // The mock resolves the transduction ~400ms later, via the same sketch_status event
  // path the real backend's async (wait:false) branch uses.
  await expect(page.getByTestId("v2-track-header")).toHaveCount(before + 1);
  const last = page.getByTestId("v2-track-header").last();
  await expect(last).toContainText("Sketch");
  const trackId = await last.getAttribute("data-track-id");
  await expect(page.locator(`.v2-lane[data-track-id="${trackId}"]`).getByTestId("v2-clip")).toHaveCount(1);
});

test("beatbox -> beat: an out-of-range bpm keeps the confirm button disabled — the engine's " +
     "own 20..300 rejection never has to surface as an error toast", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-browser-pull").click();
  await page.getByTestId("sample-row").first().getByTestId("sample-sketch-beatbox").click();
  const dialog = page.getByTestId("sketch-beatbox-dialog");
  const bpmInput = dialog.getByTestId("sketch-bpm-input");
  const confirm = dialog.getByTestId("sketch-beatbox-confirm");

  await bpmInput.fill("400");
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByTestId("sketch-bpm-hint")).toBeVisible();

  await bpmInput.fill("140");
  await expect(confirm).toBeEnabled();
  await expect(dialog.getByTestId("sketch-bpm-hint")).toHaveCount(0);

  // Escape dismisses without dispatching anything (shared Escape-stack convention).
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("beatbox -> beat: the entry point is keyboard reachable, matching Import's affordance", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-browser-pull").click();
  const row = page.getByTestId("sample-row").first();
  const sketchButton = row.getByTestId("sample-sketch-beatbox");
  await sketchButton.focus();
  await expect(sketchButton).toBeFocused();
  await expect.poll(() => sketchButton.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
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

test("the selected track-header tint is the NEUTRAL accent, identical in both themes", async ({ page }) => {
  // This used to assert the tint differed per theme, because --v2-accent flipped
  // (#ccff36 dark / #c2f53f light) and selection was painted with it.
  //
  // Selection is no longer accent-bearing. Under the accent reservation the lime is
  // reserved for generative and Moshi surfaces, and --v2-accent resolves to the
  // near-white neutral for everything else — one value that does NOT flip, because v2
  // keeps dark panels on a cream page in both themes (--v2-surface-2 is #242427 in
  // light), so the same tint reads correctly on both.
  //
  // So the theme-divergence assertion is inverted, and a STRICTER one replaces it: the
  // tint must not be lime-derived at all. That is the invariant worth guarding — it is
  // what stops selection quietly reclaiming the accent.
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const header = page.getByTestId("v2-track-header").first();
  await header.click();
  const lightBg = await header.evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.evaluate(() => window.localStorage.setItem(
    "mosh.settings",
    JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }),
  ));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await header.click();
  const darkBg = await header.evaluate((el) => getComputedStyle(el).backgroundColor);

  // The neutral does not flip, so the two themes now agree.
  expect(lightBg).toBe(darkBg);

  // Resolve both candidate tints in the page so this compares engine output to engine
  // output rather than hand-computed rgba strings.
  const { neutralTint, limeTint } = await page.evaluate(() => {
    const mix = (c: string) => {
      const d = document.createElement("div");
      d.style.backgroundColor = `color-mix(in srgb, ${c} 4.5%, transparent)`;
      document.body.appendChild(d);
      const v = getComputedStyle(d).backgroundColor;
      d.remove();
      return v;
    };
    return { neutralTint: mix("#f2f2f4"), limeTint: mix("#ccff36") };
  });

  // Anti-vacuity: if the two candidates ever resolved to the same string the assertions
  // below would be trivially satisfiable.
  expect(neutralTint).not.toBe(limeTint);
  expect(darkBg, "selection tint is not the neutral accent").toBe(neutralTint);
  expect(darkBg, "selection has reclaimed the agentic lime — see accentReservation.test.ts").not.toBe(limeTint);
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

test("the inspector body is a role=tabpanel labelled by the active tab (finishes the WAI-ARIA pattern)", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").first().click(); // bind the always-on inspector
  const body = page.getByTestId("v2-insp-body");
  await expect(body).toBeVisible();
  // Default tab is Mix — the panel names its owning tab, and that tab controls this panel.
  await expect(body).toHaveAttribute("role", "tabpanel");
  await expect(body).toHaveAttribute("aria-labelledby", "v2-insp-tab-mix");
  await expect(page.getByTestId("v2-insp-tab-mix")).toHaveAttribute("aria-controls", "v2-insp-body");
  // Switching tabs moves aria-labelledby to the newly-active tab.
  await page.getByTestId("v2-insp-tab-fx").click();
  await expect(body).toHaveAttribute("aria-labelledby", "v2-insp-tab-fx");
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

test("the in-flight clip badge honors prefers-reduced-motion (no blink)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await bootV2(page);
  // drive the async "transcribing…" badge on via the dev store handle (keyed by clip id),
  // the same path enterPeersMode uses.
  const id = await page.getByTestId("v2-clip").first().getAttribute("data-clip-id");
  expect(id).toBeTruthy();
  await page.evaluate((clipId) => {
    const store = (window as unknown as { __moshStore?: { setState: (s: object) => void } }).__moshStore;
    store?.setState({ transcribing: { [clipId!]: true } });
  }, id);
  const badge = page.getByTestId("clip-transcribing");
  await expect(badge).toBeVisible();
  // the v2-blink infinite animation must be neutralized under reduced-motion
  await expect
    .poll(() => badge.evaluate((el) => getComputedStyle(el).animationName))
    .toBe("none");
});

test("the arrangement shrink-wraps to its tracks; the add-track row creates a track", async ({ page }) => {
  await bootV2(page);
  // sparse session: the stage is content-sized (shorter than the body) so cream shows below it
  const sb = await page.locator(".v2-stage").boundingBox();
  const bb = await page.locator(".v2-body").boundingBox();
  if (!sb || !bb) throw new Error("no bounds");
  expect(sb.height).toBeLessThan(bb.height - 100);
  // the trailing "+ New track" row opens the kind menu; picking Audio adds a track
  // (and the panel grows by a lane)
  const before = await page.getByTestId("v2-track-header").count();
  const h0 = sb.height;
  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-audio").click();
  await expect(page.getByTestId("v2-track-header")).toHaveCount(before + 1);
  await expect.poll(async () => (await page.locator(".v2-stage").boundingBox())?.height ?? 0).toBeGreaterThan(h0);
});

// TRK-KIND — the v2 shell shipped able to create ONLY audio tracks, so a mouse-only user
// could never program a beat or a melody. Prove both newly-reachable kinds land a track
// that is actually playable: an instrument in the rack (else it is silent), and for the
// instrument kind a MIDI clip to open in the piano roll.
test("the add-track menu reaches drum and instrument tracks, and they land playable", async ({ page }) => {
  await bootV2(page);
  const before = await page.getByTestId("v2-track-header").count();

  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-drum").click();
  await expect(page.getByTestId("v2-track-header")).toHaveCount(before + 1);
  // the drum track carries the sampler+kit — the header shows the instrument as its preset
  await expect(page.getByTestId("v2-track-header").last().locator(".v2-lpreset")).not.toHaveText("Audio");

  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-midi").click();
  await expect(page.getByTestId("v2-track-header")).toHaveCount(before + 2);
  // …and the instrument track arrives with a clip already ON IT, so the piano roll —
  // which only opens on an existing MIDI clip — is reachable at last. Scoped to the new
  // track's own lane: the clip must not land on tracks[0], which is where an omitted
  // trackId would put it in the mock.
  const newTrackId = await page.getByTestId("v2-track-header").last().getAttribute("data-track-id");
  expect(newTrackId).toBeTruthy();
  await expect(page.locator(`.v2-lane[data-track-id="${newTrackId}"]`).getByTestId("v2-clip")).toHaveCount(1);
});

// TRK-RENAME — `rename_track` shipped with no user-facing call site in EITHER shell, so
// naming a track was agent-only. It commits on blur, like the Clip tab's rename field.
test("a track can be renamed from the Inspector", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").first().click();
  const name = page.getByTestId("v2-track-name");
  await expect(name).toBeVisible();
  await name.fill("Rhodes");
  await name.blur();
  // the header and the inspector title both follow the backend's new name
  await expect(page.getByTestId("v2-track-header").first()).toContainText("Rhodes");
  await expect(page.getByTestId("v2-inspector")).toContainText("Rhodes");
});

test("an emptied track-name field snaps back instead of clearing the name", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").first().click();
  const before = await page.getByTestId("v2-track-name").inputValue();
  await page.getByTestId("v2-track-name").fill("   ");
  await page.getByTestId("v2-track-name").blur();
  await expect(page.getByTestId("v2-track-name")).toHaveValue(before);
  await expect(page.getByTestId("v2-track-header").first()).toContainText(before);
});

test("the add-track menu closes on Escape without creating anything", async ({ page }) => {
  await bootV2(page);
  const before = await page.getByTestId("v2-track-header").count();
  await page.getByTestId("v2-track-add").click();
  await expect(page.getByTestId("v2-track-add-drum")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v2-track-add-drum")).toHaveCount(0);
  await expect(page.getByTestId("v2-track-header")).toHaveCount(before);
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

test("the empty-arrangement placeholder is announced as a live region (role=status)", async ({ page }) => {
  await bootV2(page);
  // Reach the empty stage (also shown when the last track is removed) via the dev store
  // handle — the same pattern e2e/multiplayer.spec.ts uses for a fresh/empty project.
  await page.evaluate(() => {
    const store = (window as unknown as { __moshStore?: { getState: () => { snapshot: unknown }; setState: (s: object) => void } }).__moshStore;
    const snap = store?.getState().snapshot as { tracks?: unknown[] } | null | undefined;
    if (snap) store?.setState({ snapshot: { ...snap, tracks: [] } });
  });
  // The onboarding cue must announce itself, matching its sibling .v2-drop status region.
  const empty = page.getByTestId("v2-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toHaveAttribute("role", "status");
});

test("the timeline zoom segmented control is grouped with an accessible name (a11y)", async ({ page }) => {
  await bootV2(page);
  // the 8b/16b/Full buttons are mutually-exclusive aria-pressed toggles — group them so a
  // screen reader announces them as one control, not three unrelated buttons (matches the
  // role=group pattern the lyric proposals panel already uses).
  await expect(page.getByRole("group", { name: "Timeline zoom" })).toBeVisible();
});

// TRK-KIND flip-up — the add-track row sits at the END of the lane list, so on a full
// session it lands at the bottom of the window. The menu opened downward unconditionally,
// which pushed "Instrument" off-screen entirely (found by driving the real app with 8
// tracks — the 3-track browser fixture always had room below). The panel must flip above
// the trigger when there is no room beneath it, and every item must stay on-screen.
test("the add-track menu flips above the trigger when it would run off-screen", async ({ page }) => {
  await bootV2(page);
  // A short viewport puts the trailing add-track row hard against the bottom edge.
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.getByTestId("v2-track-add").click();

  const panel = page.locator(".v2-menu-panel-fixed");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  const vh = page.viewportSize()!.height;
  if (!box) throw new Error("no panel bounds");

  // The whole panel — not just its top — must be within the viewport.
  expect(box.y, "panel top is above the viewport").toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, "panel bottom runs off-screen").toBeLessThanOrEqual(vh);

  // and the last item is genuinely clickable, which is what actually broke
  await page.getByTestId("v2-track-add-midi").click();
  await expect(page.getByTestId("v2-track-add-midi")).toHaveCount(0);
});

// METER-COLLIDE — the per-track peak meter shipped visually broken and nothing could see
// it. `.v2-meter` was declared twice in shell.css (track meter + PresenceMeter), and the
// second block's DESCENDANT rule `.v2-meter span` reached the `.mbar` spans inside
// TrackMeterBar, pinning `width: 3px; transform: scaleY(0.18)` — properties mosh.css's
// `.meter .mbar` never contests and Meter.tsx's rAF loop never writes (it only touches
// `.mmask`). Result: frozen 3px x 0.54px slivers instead of level bars. The unit suites
// run in jsdom with no real cascade, so only a browser can assert this.
for (const theme of ["light", "dark"] as const) {
  test(`per-track meter bars render full-size and correctly masked (${theme} theme)`, async ({ page }) => {
    await page.addInitScript((t) => {
      window.localStorage.clear();
      window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: t }, keyOverrides: {} }));
    }, theme);
    await page.goto("/?shell=v2");
    await expect(page.getByTestId("v2-shell")).toBeVisible();

    const bar = page.locator('[data-testid="v2-track-meter"] .mbar').first();
    await expect(bar).toBeAttached();

    const geom = await bar.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { w: b.width, h: b.height, transform: getComputedStyle(el).transform };
    });
    // The exact failure was transform: scaleY(0.18).
    expect(geom.transform, "a CSS transform is squashing the meter bar").toBe("none");
    // This pair is what stops the test being vacuous: `transform: none` alone passes
    // happily for a 3px-wide element.
    expect(geom.w, "meter bar too narrow to read as a level bar").toBeGreaterThan(10);
    expect(geom.h, "meter bar has no height").toBeGreaterThan(1);

    // The unlit mask overlays the gradient, so it must be OPAQUE and match the v2 ink —
    // not the classic --ink-deep, which is cream in the light theme.
    const mask = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="v2-track-meter"] .mmask')!;
      const probe = document.createElement("div");
      probe.style.color = getComputedStyle(document.querySelector(".v2-shell")!)
        .getPropertyValue("--v2-ink").trim();
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(el).backgroundColor, expected };
    });
    expect(mask.actual, "unlit mask does not match --v2-ink").toBe(mask.expected);
    expect(mask.actual, "unlit mask is translucent — the gradient will ghost through")
      .not.toContain("rgba");
  });
}

// HEAD-TRUNCATE — the track NAME had 28px in a 168px header once the icon (34), meter
// (30), M/S column (22), three 10px gaps and 24px of padding were paid for; and the
// uppercase AUDIO/DRUM pill inside the name column was `flex: 0 0 auto`, so it took its
// ~45px first and the name absorbed the entire shortfall. Every name read "Ser…".
// The pill duplicated the track-type icon beside it, so it went; the header widened to
// 200px and the meter/gaps slimmed. Asserts the BUDGET, not any particular name.
test("the track-name column is wide enough to read a name", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: {}, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();

  // A name long enough that the column width is what decides legibility.
  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    await st.exec("rename_track", { trackId: st.snapshot.tracks[0].id, name: "Serum Lead Stack" });
  });

  const meta = page.locator(".v2-lmeta").first();
  await expect(meta).toBeVisible();
  const columnPx = await meta.evaluate((el) => el.clientWidth);
  // 28px was the shipped value. 60 is a floor that fails loudly on any regression
  // toward it while leaving room to re-tune the header.
  expect(columnPx, "track-name column has collapsed again").toBeGreaterThan(60);

  // And the pill that caused it must not come back inside the name column.
  await expect(page.locator(".v2-ltype")).toHaveCount(0);

  // The full name stays recoverable even when the column does truncate it.
  await expect(page.locator(".v2-lname").first()).toHaveAttribute("title", "Serum Lead Stack");
});

// A <button> whose UA border is never reset renders `2px outset`, and `outset` is a 3D
// bevel: the browser paints the top/left edges LIGHTENED and bottom/right darkened. On the
// v2 shell's near-black panels that showed up as two stray white lines on the top and left
// of the add-track row — and nowhere else, which is what made it read as a rendering glitch
// rather than a style bug. Nothing in a designed UI ever wants a bevel border, so assert the
// whole shell is free of them instead of pinning the one element that regressed.
test("no element in the shell carries a UA bevel border", async ({ page }) => {
  await bootV2(page);

  const found = await page.evaluate(() => {
    const BEVEL = new Set(["outset", "inset", "groove", "ridge"]);
    const sides = ["Top", "Right", "Bottom", "Left"] as const;
    const els = [...document.querySelectorAll(".v2-shell, .v2-shell *")];
    const bad: { cls: string; testid: string | null; sides: string[] }[] = [];
    for (const el of els) {
      const cs = getComputedStyle(el);
      const hit = sides.filter((s) => BEVEL.has(cs[`border${s}Style` as never] as string));
      if (hit.length) {
        bad.push({
          cls: String((el as HTMLElement).className).slice(0, 60),
          testid: el.getAttribute("data-testid"),
          sides: hit.map((s) => s.toLowerCase()),
        });
      }
    }
    return { scanned: els.length, bad };
  });

  // Anti-vacuity: if the query matched nothing, "no bevels found" would be meaningless.
  expect(found.scanned, "shell query matched nothing — this guard would pass on an empty page").toBeGreaterThan(120);
  expect(
    found.bad,
    `bevel border(s) leaked from UA defaults: ${JSON.stringify(found.bad)}`,
  ).toEqual([]);
});
