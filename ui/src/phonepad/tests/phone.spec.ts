import { expect, test } from "@playwright/test";
import { staticServer, testToken, WireFixture } from "./browser-harness";

let server: Awaited<ReturnType<typeof staticServer>>;
test.beforeAll(async () => { server = await staticServer(); });
test.afterAll(async () => { await server.close(); });

test("labels a rejected former keeper as preserved redo", async ({ page }) => {
  const fixture = new WireFixture();
  fixture.state = { ...fixture.state, contributions: fixture.state.contributions.map((part) => part.id === "part-1" ? { ...part, keeper: true, rejected: true } : part) };
  await fixture.attach(page);
  await page.goto(`${server.url}#token=${testToken}`);
  await expect(page.locator('#takes option[value="part-1"]')).toHaveText("Part 1 · preserved redo");
});

test("pairs privately and requires a fresh scan after reload", async ({ page }) => {
  const fixture = new WireFixture();
  await fixture.attach(page);
  await test.step("Given a pairing fragment", async () => { await page.goto(`${server.url}#token=${testToken}`); });
  await test.step("When the phone connects", async () => { await expect(page.locator("#record")).toBeEnabled(); });
  await test.step("Then the fragment is gone and no credential persists", async () => {
    expect(page.url()).toBe(server.url);
    expect(fixture.authValid).toBe(true);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    await page.reload();
    await expect(page.locator("#state")).toHaveText("PAIR PHONE");
    await expect(page.locator("#record")).toBeDisabled();
  });
});

test("reconstructs the current recording target despite an earlier selection", async ({ page }) => {
  const fixture = new WireFixture();
  await fixture.attach(page);
  await test.step("Given an explicitly selected earlier part", async () => {
    await page.goto(`${server.url}#token=${testToken}`);
    await page.locator("#takes").selectOption("part-2");
    await expect(page.locator("#again")).toHaveAccessibleName("Redo Part 2");
    fixture.state = { ...fixture.state, recording: true, playing: true, phase: "recording" };
    await expect(page.locator("#again")).toHaveAccessibleName("Redo current recording");
  });
  await test.step("When Again is pressed while capture runs", async () => { await page.locator("#again").click(); });
  await test.step("Then only the current capture is targeted", async () => {
    await expect.poll(() => fixture.commands.length).toBe(1);
    expect(fixture.commands[0]).toMatchObject({ action: "again", targetId: "part-3", sessionId: "session-1", projectId: "project-1", authority: "authority-1" });
    await expect(page.locator("#bar")).toBeDisabled();
  });
});

test("holds an uncertain action without replay and releases it from a receipt", async ({ page }) => {
  const fixture = new WireFixture(); fixture.actionMode = "lost";
  await fixture.attach(page);
  await test.step("Given a connection whose next mutation response is lost", async () => { await page.goto(`${server.url}#token=${testToken}`); });
  await test.step("When Keep is pressed", async () => { await page.locator("#keep").click(); });
  await test.step("Then polling continues without replay and Stop stays available", async () => {
    await expect.poll(() => fixture.polls).toBeGreaterThan(4);
    expect(fixture.commands).toHaveLength(1);
    await expect(page.locator("#keep")).toBeDisabled();
    await expect(page.locator("#stop")).toBeEnabled();
    fixture.completeLast();
    await expect(page.locator("#keep")).toBeEnabled();
    expect(fixture.commands).toHaveLength(1);
  });
});

test("sends Stop while a nonterminal Keep is pending", async ({ page }) => {
  const fixture = new WireFixture(); fixture.actionMode = "accepted";
  await fixture.attach(page);
  await page.goto(`${server.url}#token=${testToken}`);
  await test.step("Given a pending Keep receipt", async () => { await page.locator("#keep").click(); await expect(page.locator("#keep")).toBeDisabled(); });
  await test.step("When Stop is pressed", async () => { await page.locator("#stop").click(); });
  await test.step("Then a separate Stop reaches the transport", async () => {
    await expect.poll(() => fixture.commands.length).toBe(2);
    expect(fixture.commands.map((command) => command.action)).toEqual(["keep", "stop"]);
    expect(fixture.commands[0]?.requestId).not.toBe(fixture.commands[1]?.requestId);
  });
});

test("holds ordinary actions after an uncertain Stop but permits a new explicit Stop", async ({ page }) => {
  const fixture = new WireFixture(); fixture.actionMode = "lost";
  await fixture.attach(page);
  await test.step("Given a connected pad", async () => { await page.goto(`${server.url}#token=${testToken}`); });
  await test.step("When Stop loses its response", async () => { await page.locator("#stop").click(); await expect.poll(() => fixture.polls).toBeGreaterThan(3); });
  await test.step("Then ordinary actions stay locked and a fresh explicit Stop can reach the host", async () => {
    await expect(page.locator("#record")).toBeDisabled();
    await page.locator("#stop").click();
    await expect.poll(() => fixture.commands.length).toBe(2);
    expect(fixture.commands.map((command) => command.action)).toEqual(["stop", "stop"]);
  });
});

test("navigates only while stopped and transmits an integer bar", async ({ page }) => {
  const fixture = new WireFixture(); await fixture.attach(page);
  await test.step("Given a stopped host", async () => { await page.goto(`${server.url}#token=${testToken}`); await page.locator("#bar").fill("17"); });
  await test.step("When Go is pressed", async () => { await page.locator("#go").click(); });
  await test.step("Then the bar reaches the controller", async () => {
    await expect.poll(() => fixture.commands.length).toBe(1);
    expect(fixture.commands[0]).toMatchObject({ action: "navigate", bar: 17 });
  });
});

test("keeps Play All untargeted while Review Selected Take requires a selection", async ({ page }) => {
  const fixture = new WireFixture(); await fixture.attach(page);
  await page.goto(`${server.url}#token=${testToken}`);
  await expect(page.locator("#play-all")).toBeEnabled();
  await expect(page.locator("#hear")).toBeDisabled();
  await page.locator("#play-all").click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toMatchObject({ action: "play_all" });
  expect(fixture.commands[0]).not.toHaveProperty("targetId");
  await page.locator("#takes").selectOption("part-2");
  await page.locator("#hear").click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[1]).toMatchObject({ action: "hear", targetId: "part-2" });
});

test("sends Project Start and bounded quarter-note lead-in only while stopped", async ({ page }) => {
  const fixture = new WireFixture(); await fixture.attach(page);
  await page.goto(`${server.url}#token=${testToken}`);
  await page.locator("#home").click();
  await page.locator("#lead").fill("6.5");
  await page.locator("#set-lead").click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[0]).toMatchObject({ action: "home" });
  expect(fixture.commands[0]).not.toHaveProperty("bar");
  expect(fixture.commands[1]).toMatchObject({ action: "lead_in", leadQn: 6.5 });
  await page.locator("#lead").fill("Infinity");
  await page.locator("#set-lead").click();
  expect(fixture.commands).toHaveLength(2);
});

test("blocks controls when desktop engagement is off", async ({ page }) => {
  const fixture = new WireFixture(); fixture.state = { ...fixture.state, engaged: false };
  await fixture.attach(page);
  await test.step("Given desktop setup is incomplete", async () => { await page.goto(`${server.url}#token=${testToken}`); });
  await test.step("When the host state arrives", async () => { await expect(page.locator("#state")).toHaveText("SETUP NEEDED"); });
  await test.step("Then no remote setup or transport action is offered", async () => {
    for (const id of ["keep", "again", "play-all", "hear", "record", "stop", "home", "go", "set-lead"]) await expect(page.locator(`#${id}`)).toBeDisabled();
  });
});

test("disables controls on a lost host and reconnects without replay", async ({ page }) => {
  const fixture = new WireFixture(); await fixture.attach(page);
  await test.step("Given a connected pad", async () => { await page.goto(`${server.url}#token=${testToken}`); await expect(page.locator("#record")).toBeEnabled(); });
  await test.step("When state requests fail", async () => { fixture.stateStatus = 503; await expect(page.locator("#record")).toBeDisabled(); });
  await test.step("Then a recovered connection restores controls without sending actions", async () => {
    fixture.stateStatus = 200;
    await expect(page.locator("#record")).toBeEnabled();
    expect(fixture.commands).toHaveLength(0);
  });
});

for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
  test(`keeps all primary controls reachable at ${viewport.width}px`, async ({ page }) => {
    const fixture = new WireFixture(); await fixture.attach(page);
    await test.step("Given a reference viewport", async () => { await page.setViewportSize(viewport); await page.goto(`${server.url}#token=${testToken}`); });
    await test.step("When the ready state is shown", async () => { await expect(page.locator("#record")).toBeEnabled(); });
    await test.step("Then the pad has no horizontal overflow or clipped controls", async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator("#stop")).toBeInViewport();
      await expect(page.locator("#go")).toBeInViewport();
      await page.screenshot({ path: `evidence/ready-${viewport.width}x${viewport.height}.png`, fullPage: true });
    });
  });
}
