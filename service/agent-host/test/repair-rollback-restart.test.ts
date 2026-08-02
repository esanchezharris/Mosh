import { describe, expect, it } from "vitest";
import {
  persistedSwapFixture,
  restartedService,
} from "./orchestration-fixture.js";

const rollbackActions = [
  "handoff_prior",
];

const rollbackEvents = [
  "repair.swap.recovered",
  "repair.rollback.handoff_accepted",
  "repair.swap.rolled_back",
];

describe("persisted rolling_back restart recovery", () => {
  it("restores exactly one prior app after a fresh-store orchestrator restart", async () => {
    const { fakes, store, report, repair } = await persistedSwapFixture("rolling_back");
    const restarted = restartedService(store, fakes);
    await restarted.initialize();

    const recovered = await restarted.rollbackRepair(repair.id, "resume durable rollback");

    expect(fakes.processCalls).toEqual(rollbackActions);
    expect(recovered.swap?.state).toBe("rolled_back");
    const types = (await store.loadEvents(report.playtestId)).map((event) => event.type);
    expect(types.slice(-rollbackEvents.length)).toEqual(rollbackEvents);
  });

  it("persists failure and a second new orchestrator retries without app overlap", async () => {
    const { fakes, store, report, repair } = await persistedSwapFixture("rolling_back");
    fakes.failProcessAction = "handoff_prior";
    const firstRestart = restartedService(store, fakes);
    await firstRestart.initialize();

    await expect(firstRestart.rollbackRepair(repair.id, "first restart"))
      .rejects.toMatchObject({ code: "injected" });
    expect(fakes.processCalls).toEqual([
      "handoff_prior",
    ]);
    expect((await store.loadRepair(repair.id)).swap?.state).toBe("failed");
    const failedTypes = (await store.loadEvents(report.playtestId))
      .map((event) => event.type);
    expect(failedTypes.slice(-2)).toEqual([
      "repair.swap.recovered",
      "repair.swap.failed",
    ]);
    expect((await store.loadEvents(report.playtestId)).at(-1)).toMatchObject({
      type: "repair.swap.failed",
      data: {
        repairId: repair.id,
        fromState: "rolling_back",
        hasCheckpoint: true,
        code: "injected",
      },
    });

    const firstAttemptCount = fakes.processCalls.length;
    const secondRestart = restartedService(store, fakes);
    await secondRestart.initialize();
    const retried = await secondRestart.rollbackRepair(repair.id, "second restart");

    expect(fakes.processCalls.slice(firstAttemptCount)).toEqual(rollbackActions);
    expect(retried.swap?.state).toBe("rolled_back");
    const types = (await store.loadEvents(report.playtestId)).map((event) => event.type);
    expect(types.slice(-rollbackEvents.length)).toEqual(rollbackEvents);
  });
});

describe("persisted rolled_back relaunch", () => {
  it("reuses the existing checkpoint without overlapping app processes", async () => {
    const { fakes, store, report, repair } = await persistedSwapFixture("repair_running");
    const restarted = restartedService(store, fakes);
    await restarted.initialize();
    await restarted.rollbackRepair(repair.id, "owner requested rollback");
    expect(fakes.priorHandoffs).toEqual([{
      playtestId: repair.playtestId,
      checkpointPath: "/tmp/checkpoint.mosh",
      priorAppPath: "/Applications/Mosh.app",
      repairId: repair.id,
      buildPath: "/build/Mosh.app",
    }]);
    fakes.processCalls.length = 0;

    const relaunched = await restarted.launchRepairBuild(repair.id, "/build/Mosh.app");

    expect(fakes.processCalls).toEqual([
      "stop_transport",
      "release_audio",
      "handoff_repair",
    ]);
    expect(relaunched.status).toBe("full_gate_pending");
    expect(relaunched.swap?.state).toBe("repair_running");
    await expect(restarted.createRepair(report.id))
      .rejects.toMatchObject({ code: "repair_active" });
    const types = (await store.loadEvents(report.playtestId)).map((event) => event.type);
    expect(types.slice(-4)).toEqual([
      "repair.swap.recovered",
      "repair.transport.stopped",
      "repair.audio.released",
      "repair.build.handoff_accepted",
    ]);
  });

  it("does not relaunch a generic failed swap with a checkpoint", async () => {
    const { fakes, store, repair } = await persistedSwapFixture("failed");
    const restarted = restartedService(store, fakes);
    await restarted.initialize();

    await expect(restarted.launchRepairBuild(repair.id, "/build/Mosh.app"))
      .rejects.toMatchObject({ code: "repair_swap_state" });
    expect(fakes.processCalls).toEqual([]);
  });

  it("rejects relaunching an older repair while a newer repair is active", async () => {
    const { fakes, store, report, repair } = await persistedSwapFixture("repair_running");
    const restarted = restartedService(store, fakes);
    await restarted.initialize();
    await restarted.rollbackRepair(repair.id, "owner requested rollback");
    const newer = await restarted.createRepair(report.id);
    fakes.processCalls.length = 0;

    await expect(restarted.launchRepairBuild(repair.id, "/build/Mosh.app"))
      .rejects.toMatchObject({ code: "repair_active" });

    expect(fakes.processCalls).toEqual([]);
    expect((await store.loadRepair(repair.id)).swap?.state).toBe("rolled_back");
    expect((await store.loadRepair(newer.id)).status).toBe("running");
  });

  it("serializes a concurrent relaunch and new repair reservation", async () => {
    const { fakes, store, report, repair } = await persistedSwapFixture("repair_running");
    const restarted = restartedService(store, fakes);
    await restarted.initialize();
    await restarted.rollbackRepair(repair.id, "owner requested rollback");
    fakes.processCalls.length = 0;

    const outcomes = await Promise.allSettled([
      restarted.createRepair(report.id),
      restarted.launchRepairBuild(repair.id, "/build/Mosh.app"),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "repair_active" },
    });
    const active = (await store.listRepairs()).filter((job) =>
      job.status === "queued" || job.status === "running" || job.status === "full_gate_pending");
    expect(active).toHaveLength(1);
  });
});
