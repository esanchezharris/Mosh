import { describe, it, expect } from "vitest";
import { deriveTrainingJob } from "./trainingJobView";
import type { TrainingJob } from "../types";

// Pure derivation the LoRA popover Jobs list paints with — see meterGeom.test.ts /
// takeLanes.test.ts for the same "test the pure derivation, not the rendered
// component" convention. The real trainer drives a job through
// queued → running (progress 1/6..6/6) → ready, or terminates in error/cancelled
// (service/server.py:280-318); none of progress/error was surfaced before AL-003.

const baseJob = (over: Partial<TrainingJob>): TrainingJob => ({
  jobId: "job-abc123",
  status: "queued",
  progress: 0,
  ...over,
});

describe("deriveTrainingJob — phase", () => {
  it("maps a queued job to the queued phase", () => {
    expect(deriveTrainingJob(baseJob({ status: "queued" })).phase).toBe("queued");
  });

  it("maps a running job to the running phase", () => {
    expect(deriveTrainingJob(baseJob({ status: "running" })).phase).toBe("running");
  });

  it("maps a ready job to the ready phase", () => {
    expect(deriveTrainingJob(baseJob({ status: "ready" })).phase).toBe("ready");
  });

  it("maps an error job to the error phase", () => {
    expect(deriveTrainingJob(baseJob({ status: "error" })).phase).toBe("error");
  });

  it("maps a cancelled job to the cancelled phase", () => {
    expect(deriveTrainingJob(baseJob({ status: "cancelled" })).phase).toBe("cancelled");
  });

  it("treats the 'canceled' spelling as cancelled", () => {
    expect(deriveTrainingJob(baseJob({ status: "canceled" })).phase).toBe("cancelled");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(deriveTrainingJob(baseJob({ status: " RUNNING " })).phase).toBe("running");
  });

  it("falls back to the queued phase for an unknown status", () => {
    expect(deriveTrainingJob(baseJob({ status: "weird-state" })).phase).toBe("queued");
  });
});

describe("deriveTrainingJob — progressPct", () => {
  it("maps a 0..1 progress fraction to a 0..100 percentage", () => {
    expect(deriveTrainingJob(baseJob({ status: "running", progress: 0.5 })).progressPct).toBe(50);
  });

  it("rounds to an integer percentage", () => {
    expect(deriveTrainingJob(baseJob({ status: "running", progress: 1 / 6 })).progressPct).toBe(17);
  });

  it("clamps an out-of-range progress to 0..100", () => {
    expect(deriveTrainingJob(baseJob({ progress: 1.7 })).progressPct).toBe(100);
    expect(deriveTrainingJob(baseJob({ progress: -0.3 })).progressPct).toBe(0);
  });

  it("treats a non-finite progress as 0%", () => {
    expect(deriveTrainingJob(baseJob({ progress: Number.NaN })).progressPct).toBe(0);
    expect(deriveTrainingJob(baseJob({ progress: Number.POSITIVE_INFINITY })).progressPct).toBe(100);
  });

  it("treats a missing progress as 0%", () => {
    const job = { jobId: "job-x", status: "queued" } as unknown as TrainingJob;
    expect(deriveTrainingJob(job).progressPct).toBe(0);
  });

  it("reports a ready job as fully complete even if progress lagged", () => {
    expect(deriveTrainingJob(baseJob({ status: "ready", progress: 0.3 })).progressPct).toBe(100);
  });
});

describe("deriveTrainingJob — showProgress", () => {
  it("shows the progress bar while queued or running", () => {
    expect(deriveTrainingJob(baseJob({ status: "queued" })).showProgress).toBe(true);
    expect(deriveTrainingJob(baseJob({ status: "running" })).showProgress).toBe(true);
  });

  it("hides the progress bar for terminal phases", () => {
    expect(deriveTrainingJob(baseJob({ status: "ready" })).showProgress).toBe(false);
    expect(deriveTrainingJob(baseJob({ status: "error" })).showProgress).toBe(false);
    expect(deriveTrainingJob(baseJob({ status: "cancelled" })).showProgress).toBe(false);
  });
});

describe("deriveTrainingJob — canImport", () => {
  it("offers import only for a ready job", () => {
    expect(deriveTrainingJob(baseJob({ status: "ready" })).canImport).toBe(true);
  });

  it("does not offer import for non-ready jobs", () => {
    expect(deriveTrainingJob(baseJob({ status: "queued" })).canImport).toBe(false);
    expect(deriveTrainingJob(baseJob({ status: "running" })).canImport).toBe(false);
    expect(deriveTrainingJob(baseJob({ status: "error" })).canImport).toBe(false);
    expect(deriveTrainingJob(baseJob({ status: "cancelled" })).canImport).toBe(false);
  });
});

describe("deriveTrainingJob — errorText", () => {
  it("surfaces the backend error message for a failed job", () => {
    const v = deriveTrainingJob(baseJob({ status: "error", error: "OOM at step 1400" }));
    expect(v.errorText).toBe("OOM at step 1400");
  });

  it("provides a fallback message when an error job has no detail", () => {
    expect(deriveTrainingJob(baseJob({ status: "error", error: "" })).errorText).toBe("training failed");
    expect(deriveTrainingJob(baseJob({ status: "error" })).errorText).toBe("training failed");
  });

  it("carries no error text for non-error phases (even if a stale error string lingers)", () => {
    expect(deriveTrainingJob(baseJob({ status: "running", error: "" })).errorText).toBeNull();
    expect(deriveTrainingJob(baseJob({ status: "ready", error: "stale" })).errorText).toBeNull();
  });
});

describe("deriveTrainingJob — label", () => {
  it("labels each phase with a human-readable status word", () => {
    expect(deriveTrainingJob(baseJob({ status: "queued" })).label).toBe("queued");
    expect(deriveTrainingJob(baseJob({ status: "running", progress: 0.5 })).label).toBe("training 50%");
    expect(deriveTrainingJob(baseJob({ status: "ready" })).label).toBe("ready");
    expect(deriveTrainingJob(baseJob({ status: "error" })).label).toBe("failed");
    expect(deriveTrainingJob(baseJob({ status: "cancelled" })).label).toBe("cancelled");
  });
});
