import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult, TrainingJob } from "./types";

// Training job lifecycle — the mock keeps to what native does (MoshOps
// cmdSubmitTrainingJob / cmdTrainingJobStatus / cmdCancelTrainingJob):
//
//   submit   records the job as "queued"; nothing else moves it until it is read
//   status   reports what the trainer says, and that is what gets recorded
//   cancel   refuses an id nobody knows, stops a run that is still going, and
//            leaves a finished run exactly as it was — its answer is the state the
//            run was in, never an assumed "cancelled"
//
// The mock has no trainer, so a run finishes the first time its status is read
// and a stop lands at once.

const exec = <T = unknown>(command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult<T>>({ command, args });
const jobs = async () => (await mockSnapshot<Snapshot>()).training?.jobs ?? [];
const submit = async () =>
  (await exec<{ jobId: string }>("submit_training_job", { corpusBundle: "/mock/training/corpora/corpus-001" })).data!.jobId;
const status = (jobId: string) => exec<TrainingJob>("training_job_status", { jobId });

type CancelAnswer = { jobId: string; status: string; progress: number; cancelRequested: boolean };

describe("mock training job lifecycle", () => {
  beforeEach(() => __resetMockForTests());

  it("cancel refuses a jobId nobody knows and records no job for it", async () => {
    const res = await exec("cancel_training_job", { jobId: "no-such-job" });
    expect(res).toMatchObject({ ok: false, error: "unknown jobId" });
    expect(await jobs()).toEqual([]);
  });

  it("a submitted run is recorded as queued, and finishes when its status is read", async () => {
    const jobId = await submit();
    expect(await jobs()).toMatchObject([{ jobId, status: "queued", progress: 0 }]);

    expect((await status(jobId)).data).toMatchObject({ jobId, status: "ready", progress: 1 });
    expect(await jobs()).toMatchObject([{ jobId, status: "ready", progress: 1 }]);
  });

  it("cancel stops a run that is still going: it answers the state it found, and the next read says cancelled", async () => {
    const jobId = await submit();

    const res = await exec<CancelAnswer>("cancel_training_job", { jobId });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ jobId, status: "queued", progress: 0, cancelRequested: true });

    expect((await status(jobId)).data).toMatchObject({ jobId, status: "cancelled" });
    // A stopped run stays stopped — a later read must not finish it.
    expect((await status(jobId)).data).toMatchObject({ jobId, status: "cancelled" });
    expect(await jobs()).toMatchObject([{ jobId, status: "cancelled" }]);
  });

  it("cancel leaves a finished run alone and says there was nothing to stop", async () => {
    const jobId = await submit();
    await status(jobId);
    const finished = (await jobs())[0];
    expect(finished.status).toBe("ready");

    const res = await exec<CancelAnswer>("cancel_training_job", { jobId });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ jobId, status: "ready", progress: 1, cancelRequested: false });

    // Same record, field for field: not flipped to "cancelled", nothing dropped.
    expect((await jobs())[0]).toEqual(finished);
  });
});
