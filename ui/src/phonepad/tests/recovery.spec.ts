import { expect, test } from "@playwright/test";
import { staticServer, testToken, WireFixture } from "./browser-harness";
import { stateSchema } from "../src/contract";

let server: Awaited<ReturnType<typeof staticServer>>;
test.beforeAll(async () => { server = await staticServer(); });
test.afterAll(async () => { await server.close(); });

test("keeps an uncertain action locked when normal host authority changes", async ({ page }) => {
  const fixture = new WireFixture(); fixture.actionMode = "lost";
  await fixture.attach(page);
  await test.step("Given an unresolved Keep", async () => {
    await page.goto(`${server.url}#token=${testToken}`);
    await page.locator("#keep").click();
    await expect.poll(() => fixture.commands.length).toBe(1);
  });
  await test.step("When the host changes phase and therefore authority", async () => {
    fixture.state = stateSchema.parse({ ...fixture.state, authority: "authority-2", phase: "reviewing" });
    await expect(page.locator("#state")).toHaveText("REVIEWING");
  });
  await test.step("Then the pending receipt remains authoritative", async () => {
    await expect(page.locator("#keep")).toBeDisabled();
    expect(fixture.commands).toHaveLength(1);
    fixture.completeLast();
    await expect(page.locator("#keep")).toBeEnabled();
  });
});

test("pauses polling on a visibility event and refreshes before enabling controls", async ({ page }) => {
  const fixture = new WireFixture(); await fixture.attach(page);
  await test.step("Given a connected pad with a controlled visibility input", async () => {
    await page.goto(`${server.url}#token=${testToken}`);
    await expect(page.locator("#keep")).toBeEnabled();
    await page.clock.install();
  });
  await test.step("When the document reports hidden", async () => {
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  });
  await test.step("Then polling pauses until a fresh foreground read", async () => {
    await expect(page.locator("#keep")).toBeDisabled();
    const before = fixture.polls;
    await page.clock.fastForward(2000);
    expect(fixture.polls).toBe(before);
    fixture.state = { ...fixture.state, recording: true, phase: "recording" };
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
    await expect(page.locator("#again")).toHaveAccessibleName("Redo current recording");
    expect(fixture.polls).toBeGreaterThan(before);
  });
});

test("binds Hear during capture and Keep during review to the correct part", async ({ page }) => {
  const fixture = new WireFixture(); fixture.state = { ...fixture.state, recording: true, phase: "recording" };
  await fixture.attach(page);
  await test.step("Given a live current recording", async () => { await page.goto(`${server.url}#token=${testToken}`); });
  await test.step("When Hear is pressed", async () => { await page.locator("#hear").click(); });
  await test.step("Then the current take is preserved for review and Keep uses that reviewed part", async () => {
    await expect.poll(() => fixture.commands.length).toBe(1);
    expect(fixture.commands[0]).toMatchObject({ action: "hear", targetId: "part-3" });
    fixture.state = { ...fixture.state, recording: false, phase: "reviewing", reviewId: fixture.state.currentId, auditionedId: fixture.state.currentId };
    await expect(page.locator("#state")).toHaveText("REVIEWING");
    await page.locator("#keep").click();
    await expect.poll(() => fixture.commands.length).toBe(2);
    expect(fixture.commands[1]).toMatchObject({ action: "keep", targetId: "part-3" });
  });
});
