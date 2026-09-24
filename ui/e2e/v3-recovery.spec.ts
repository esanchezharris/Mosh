import { test, expect, type Page } from "@playwright/test";
import { bootV3 } from "./helpers";

// Demo readiness round 2, D1 (real-app walkthrough 2026-09-23, screenshot 11): after an unclean
// exit the V3 shell showed every orphan take inline in a red strip — 15 takes, 30 buttons, four
// lines over the timeline. V3 now shows one calm line; the takes wait behind a disclosure that
// opens to the same per-take actions. The mock has no crash journal, so the spec seeds the
// snapshot the engine sends after a crash (recoveryAvailable + recordingResidue).

type Residue = { file: string; name: string; trackName: string; take: number; readable: boolean;
  seconds: number; sampleRate: number; startSeconds: number; decision: "adopt" | "quarantine" };
type MoshWindow = Window & { __moshStore?: {
  getState: () => { snapshot: { session: Record<string, unknown> } & Record<string, unknown> };
  setState: (patch: Record<string, unknown>) => void;
} };

async function seedCrash(page: Page, takes: number): Promise<void> {
  await page.evaluate((n) => {
    const store = (window as unknown as MoshWindow).__moshStore!;
    const snap = store.getState().snapshot;
    const recordingResidue: Residue[] = Array.from({ length: n }, (_, i) => ({
      file: `/mock/takes/MOMENTUM_Take_${i + 1}.wav`, name: `MOMENTUM_Take_${i + 1}.wav`,
      trackName: "MOMENTUM", take: i + 1, readable: true, seconds: 2.9, sampleRate: 48000,
      startSeconds: 0, decision: "adopt",
    }));
    store.setState({
      recoveryDismissed: false,
      snapshot: { ...snap, session: { ...snap.session, recoveryAvailable: true, recoverableCount: 2, recordingResidue } },
    });
  }, takes);
}

test("D1: after a crash, one calm line; the 15 orphan takes wait behind a disclosure", async ({ page }) => {
  await bootV3(page);
  const arrangement = page.getByTestId("v3-arrangement");
  const topBefore = (await arrangement.boundingBox())!.y;

  await seedCrash(page, 15);
  const notice = page.getByTestId("recovery-notice");
  await expect(notice).toBeVisible();
  await expect(page.getByTestId("recovery-residue-quarantine")).toHaveCount(0);
  await expect(page.getByTestId("recovery-residue-adopt")).toHaveCount(0);
  const toggle = page.getByTestId("recovery-residue-toggle");
  await expect(toggle).toHaveText(/15 older recordings are still on disk/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(notice).toContainText("Restored from the last auto-save");
  await expect(notice).not.toHaveClass(/error-bar/);
  await expect(page.getByTestId("recovery-recover")).toBeVisible();

  // One short row: the timeline moves down by the notice and its margin, nothing more.
  const closed = (await notice.boundingBox())!;
  expect(closed.height).toBeLessThanOrEqual(36);
  expect((await arrangement.boundingBox())!.y - topBefore).toBeLessThanOrEqual(44);

  // Open: every take and both of its actions are reachable, in a list that scrolls in place.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("recovery-residue-item")).toHaveCount(15);
  await expect(page.getByTestId("recovery-residue-adopt")).toHaveCount(15);
  await expect(page.getByTestId("recovery-residue-quarantine")).toHaveCount(15);
  await expect(page.getByTestId("recovery-residue-quarantine").first()).toBeVisible();
  const open = (await notice.boundingBox())!;
  expect(open.height).toBeLessThanOrEqual(900 * 0.3 + 60);

  await toggle.click();
  await expect(page.getByTestId("recovery-residue-item")).toHaveCount(0);
  await page.getByTestId("recovery-dismiss").click();
  await expect(notice).toHaveCount(0);
});
