// The run header must describe THE RUN, not the app's current state.
//
// It used to compute "N of M epochs" from `snapshot.training.sources.length`
// (the live rights registry) and `capabilities.trainingRecipe` (the recommended
// recipe for whatever corpus is registered NOW). Both move independently of a
// run in flight, so the readout had two silent failure modes:
//
//   * a finished run showed "—" once its sources were cleared, though it plainly
//     had epochs
//   * registering more sources mid-run re-scaled the epoch count of a training
//     that had not changed at all — the number moved, the run did not
//
// Both are the kind of wrong that looks like a working UI. So the run now
// carries its own corpus size and batch, and these pin that they WIN.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { epochsFor } from "./recipe";
import type { LabRun } from "../../store/loraLab";

const RUN: LabRun = {
  jobId: "j1", label: "ken-01", status: "training",
  step: 940, totalSteps: 2079, loss: 0.31, sPerStep: 2.15, etaSeconds: 2450,
  leg: 2, legs: 4, clipCount: 189, batchSize: 2, gradAccum: 2,
};

describe("LoRA Lab — the run reports its own facts", () => {
  beforeEach(() => {
    useStore.getState().resetLab();
    vi.restoreAllMocks();
  });

  it("carries clipCount / batchSize / gradAccum off the status detail", async () => {
    useStore.setState({ labRun: { ...RUN, clipCount: null, batchSize: null, gradAccum: null } } as never);
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async () => ({ ok: true, data: {
        status: "training",
        detail: { step: 940, totalSteps: 2079, clipCount: 189, batchSize: 2, gradAccum: 2 },
      } })) as never,
    );
    await useStore.getState().pollLabRun();
    const r = useStore.getState().labRun!;
    expect(r.clipCount).toBe(189);
    expect(r.batchSize).toBe(2);
    expect(r.gradAccum).toBe(2);
  });

  it("keeps them when a later poll omits them", async () => {
    useStore.setState({ labRun: RUN } as never);
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async () => ({ ok: true, data: { status: "training", detail: { step: 1000 } } })) as never,
    );
    await useStore.getState().pollLabRun();
    const r = useStore.getState().labRun!;
    // Sticky: a service that predates these fields, or a poll that races the
    // trainer's first log line, must not blank a number already on screen.
    expect(r.step).toBe(1000);
    expect(r.clipCount).toBe(189);
    expect(r.batchSize).toBe(2);
  });

  it("a new run starts with them UNKNOWN, not guessed from live state", async () => {
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string }) => {
        if (req.command === "build_training_corpus") return { ok: true, data: { bundlePath: "/mock/bundle" } };
        if (req.command === "submit_training_job") return { ok: true, data: { jobId: "new1" } };
        return { ok: true, data: {} };
      }) as never,
    );
    const started = await useStore.getState().startLabRun("ken-02");
    expect(started).toBe(true);
    const r = useStore.getState().labRun!;
    expect(r.jobId).toBe("new1");
    // Seeding these from the registry/recipe at start is exactly the bug: it
    // would show a confident epoch count for a corpus the run may not use.
    expect(r.clipCount).toBeNull();
    expect(r.batchSize).toBeNull();
  });

  it("the epoch math is the run's, and does not move when the registry does", () => {
    // 940 steps x effective 4 / 189 clips = 19.9 epochs — a fact about the run.
    const fromRun = epochsFor(RUN.clipCount!, RUN.step, RUN.batchSize!, RUN.gradAccum!);
    expect(fromRun).toBeCloseTo(19.89, 1);
    // Same run, registry doubled behind it: the OLD code read 189 -> 378 here
    // and halved the epoch count of a training that never changed.
    const fromLiveRegistry = epochsFor(378, RUN.step, RUN.batchSize!, RUN.gradAccum!);
    expect(fromLiveRegistry).not.toBeCloseTo(fromRun, 1);
  });

  it("a refused start surfaces the reason and starts no run", async () => {
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string }) => {
        if (req.command === "build_training_corpus")
          return { ok: false, error: "no approved local sources available for training" };
        return { ok: true, data: {} };
      }) as never,
    );
    expect(await useStore.getState().startLabRun()).toBe(false);
    expect(useStore.getState().labStartError).toContain("no approved");
    expect(useStore.getState().labRun).toBeNull();
  });

  it("omits steps/batch on submit so the MEASURED epoch curve applies", async () => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string; args: Record<string, unknown> }) => {
        calls.push(req);
        if (req.command === "build_training_corpus") return { ok: true, data: { bundlePath: "/b" } };
        if (req.command === "submit_training_job") return { ok: true, data: { jobId: "x" } };
        return { ok: true, data: {} };
      }) as never,
    );
    await useStore.getState().startLabRun("ken-03");
    const cfg = (calls.find((c) => c.command === "submit_training_job")!.args.config ?? {}) as Record<string, unknown>;
    // The epoch count does NOT transfer between corpora (145/44/11 measured for
    // 33/189/424 clips); hardcoding steps here would throw that away.
    expect(cfg.steps).toBeUndefined();
    expect(cfg.batch_size).toBeUndefined();
    expect(cfg.label).toBe("ken-03");
  });
});
