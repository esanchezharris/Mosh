import { expect, test } from "@playwright/test";
import { staticServer, testToken, WireFixture } from "./browser-harness";
import { ready } from "./fixture";

let server: Awaited<ReturnType<typeof staticServer>>;
test.beforeAll(async () => { server = await staticServer(); });
test.afterAll(async () => { await server.close(); });

test("captures explicit controller states at the reference phone size", async ({ page }) => {
  const fixture = new WireFixture(); await fixture.attach(page);
  await test.step("Given a phone with no pairing fragment", async () => {
    await page.goto(server.url);
    await expect(page.locator("#state")).toHaveText("PAIR PHONE");
    await page.screenshot({ path: "evidence/pairing-375x812.png", fullPage: true });
  });
  await test.step("When host states change", async () => {
    await page.goto(`${server.url}#token=${testToken}`);
    for (const state of [
      { ...ready, phase: "recording", recording: true, playing: true },
      { ...ready, phase: "reviewing", reviewId: ready.currentId, auditionedId: ready.currentId },
      { ...ready, phase: "setup", engaged: false },
    ]) {
      fixture.state = state;
      await expect(page.locator("#state")).toHaveText(state.engaged ? state.phase.toUpperCase() : "SETUP NEEDED");
      await expect(page.locator("#bar-readout")).toBeInViewport();
      await page.screenshot({ path: `evidence/${state.phase}-375x812.png`, fullPage: true, animations: "disabled" });
    }
    fixture.stateStatus = 503;
    await expect(page.locator("#state")).toHaveText("DISCONNECTED");
    await page.screenshot({ path: "evidence/disconnected-375x812.png", fullPage: true });
  });
  await test.step("Then focus and pressing retain their visible treatment", async () => {
    fixture.state = ready; fixture.stateStatus = 200;
    await expect(page.locator("#keep")).toBeEnabled();
    await page.locator("#keep").focus();
    await page.screenshot({ path: "evidence/focus-375x812.png", fullPage: true });
    await page.locator("#keep").hover();
    await page.mouse.down();
    await page.screenshot({ path: "evidence/pressed-375x812.png", fullPage: true });
    await page.mouse.up();
    await expect.poll(() => fixture.commands.length).toBe(1);
    await page.screenshot({ path: "evidence/settled-375x812.png", fullPage: true });
  });
});

test("revokes the pairing on unauthorized state responses", async ({ page }) => {
  const fixture = new WireFixture(); await fixture.attach(page);
  await test.step("Given a connected pad", async () => { await page.goto(`${server.url}#token=${testToken}`); await expect(page.locator("#record")).toBeEnabled(); });
  await test.step("When the helper revokes the pairing", async () => { fixture.stateStatus = 401; });
  await test.step("Then controls require a new pairing and polling stops", async () => {
    await expect(page.locator("#state")).toHaveText("PAIR PHONE");
    await expect(page.locator("#stop")).toBeDisabled();
    await page.clock.install();
    const before = fixture.polls;
    await page.clock.fastForward(2000);
    expect(fixture.polls).toBe(before);
  });
});
