import { test, expect } from "@playwright/test";
import { bootV2, expectDispatched } from "./helpers";

// The LoRA Lab, reached and driven by a MOUSE ONLY, from the shipped v2 shell.
//
// This is the check that the reachability guard cannot make. `uiReachability.test.ts`
// greps the module graph for a command string, so a Lab that is imported, rendered,
// and completely unusable would satisfy it — the exact false positive that once hid
// a v2 user being unable to delete a track. Only a real click path proves the door
// opens, the prompt gates the render, and a take can actually be auditioned.
//
// The interesting assertion is the PROMPT GATE. A take with no prompt has no question
// to answer, so play is disabled — and that is easy to get backwards, because the
// button looks perfectly fine either way and a click on it in a manual test just
// silently does nothing.

test.beforeEach(async ({ page }) => {
  await bootV2(page);
});

/** The mouse path a producer actually takes: More tools -> LoRA -> Open LoRA Lab.
 *  In v2 the training popover lives in the topbar OVERFLOW, so the Lab is three
 *  clicks deep and every one of them has to work. */
async function openLab(page: import("@playwright/test").Page) {
  await page.getByTestId("v2-overflow").click();
  await page.getByTestId("v2-tool-training").click();
  const openBtn = page.getByTestId("open-lora-lab");
  await expect(openBtn).toBeVisible();
  await openBtn.click();
}

test("opens from the training tool and auditions a take with the mouse", async ({ page }) => {
  // The Lab is not open by construction — it opens from the LoRA popover, which is
  // where the rights registry already lives.
  await expect(page.getByTestId("lora-lab")).toHaveCount(0);

  await openLab(page);

  const lab = page.getByTestId("lora-lab");
  await expect(lab).toBeVisible();

  // The base row is always present: it is the comparison, not a take, so it exists
  // before any training has happened.
  const baseRow = lab.getByTestId("lab-take-base");
  await expect(baseRow).toBeVisible();

  // No prompt yet ⇒ nothing to render ⇒ play is disabled, and the sheet says why.
  await expect(lab.getByTestId("lab-hint-prompt")).toBeVisible();
  const play = baseRow.getByRole("button", { name: /Audition/i });
  await expect(play).toBeDisabled();

  // Write a prompt; the gate opens.
  await lab.getByTestId("lab-prompt").fill("rage trap instrumental, distorted 808, 152 bpm");
  await expect(play).toBeEnabled();

  await play.click();
  // The mock resolves on the next tick, so the row reaches a rendered state and the
  // waveform — the widest element, and the whole point of the row — appears.
  await expect(baseRow.getByTestId("lab-wave")).toBeVisible();
});

test("a take can be hidden and brought back — dismissal is never a delete", async ({ page }) => {
  await openLab(page);

  const lab = page.getByTestId("lora-lab");
  await expect(lab).toBeVisible();

  // Seed a take through the dev store handle rather than sitting through a real
  // 20-minute fine-tune. What is under test here is the sheet's behaviour, not the
  // trainer's — that is verify-hardware's job.
  await page.evaluate(() => {
    const w = window as unknown as { __moshStore?: { setState: (s: unknown) => void } };
    w.__moshStore?.setState({
      labTakes: [{ name: "e2e-run@600", step: 600, isFinal: false, landedAt: Date.now() }],
    });
  });

  const row = lab.getByTestId("lab-take-e2e-run@600");
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: /Hide/i }).click();
  await expect(row).toHaveCount(0);

  // ...and it comes back. Each take is ~20 minutes of compute, and the finding
  // behind this whole surface is that the take you nearly binned was sometimes the
  // good one — so hiding must never be a one-way door.
  const restore = lab.getByTestId("lab-restore");
  await expect(restore).toBeVisible();
  await restore.click();
  await expect(lab.getByTestId("lab-take-e2e-run@600")).toBeVisible();
});

test("Train starts a run on the approved sources, and Stop cancels that run", async ({ page }) => {
  type LabStore = {
    getState: () => {
      exec: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      labRun: { jobId: string } | null;
    };
  };

  // Two rights-cleared sources, registered and approved. Approval alone is not enough:
  // the registry counts a source only when it also has a title, a creator, a license
  // claim, proof of rights and a local file — and Train is disabled until one counts.
  await page.evaluate(async () => {
    const { exec } = (window as unknown as { __moshStore: LabStore }).__moshStore.getState();
    for (const sourceId of ["e2e-beat-a", "e2e-beat-b"]) {
      await exec("import_training_source", {
        sourceId, title: sourceId, creator: "e2e", localPath: `/Users/you/${sourceId}.wav`,
        userClaimedLicense: "my own work", proofOfRights: "session files",
      });
      await exec("approve_training_source", { sourceId, approved: true });
    }
  });

  await openLab(page);

  const lab = page.getByTestId("lora-lab");
  const train = lab.getByTestId("lab-train");
  await expect(train).toBeEnabled();
  await expect(train).toContainText("2 clips");

  // The mock's job finishes on its second status read, and the Lab polls once a
  // second — so on a running clock the run can end before a click lands. Freeze
  // time: the run stays "queued" (what submit records) until Stop is pressed.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 60_000));

  await train.click();
  const status = lab.getByTestId("lab-run-status");
  await expect(status).toHaveText("queued");
  const jobId = await page.evaluate(
    () => (window as unknown as { __moshStore: LabStore }).__moshStore.getState().labRun?.jobId,
  );
  expect(jobId, "Train recorded the job it started").toBeTruthy();

  await lab.getByTestId("lab-stop").click();
  await expectDispatched(page, "cancel_training_job", { jobId });

  // Stop never writes a status itself: it cancels, then re-reads the run. With the
  // clock frozen the 1 s poll cannot fire, so that one re-read is the only thing that
  // can move the header. The read is absent from the command trace (the mock keeps
  // read-only commands out of it), which is why it is pinned by its effect.
  await expect(status, 'the header shows what "training_job_status" reported after the cancel')
    .toHaveText("stopped");
});
