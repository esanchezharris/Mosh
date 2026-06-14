import { expect, test } from "@playwright/test";
import { collectConsoleProblems, openApp, snapshot } from "./helpers";

// The app shell loads and the swappable seam is live against the real native backend.
test("app shell loads against the real MoshOps backend", async ({ page, request }) => {
  const problems = collectConsoleProblems(page);
  await openApp(page);

  const snap = await snapshot(request);
  expect(snap.schemaVersion).toBeGreaterThanOrEqual(1);
  expect(typeof snap.session.tempo).toBe("number");

  expect(problems).toEqual([]);
});
