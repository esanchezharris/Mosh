import { describe, expect, it } from "vitest";
import {
  persistedSwapFixture,
  restartedService,
} from "./orchestration-fixture.js";

const rollbackActions = [
  "close_repair",
  "close_mosh",
  "restore_checkpoint",
  "launch_prior",
];

const rollbackEvents = [
  "repair.swap.recovered",
  "repair.build.closed",
  "repair.app.closed",
  "repair.checkpoint.restored",
  "repair.prior_app.launched",
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
    fakes.failProcessAction = "restore_checkpoint";
    const firstRestart = restartedService(store, fakes);
    await firstRestart.initialize();

    await expect(firstRestart.rollbackRepair(repair.id, "first restart"))
      .rejects.toMatchObject({ code: "injected" });
    expect(fakes.processCalls).toEqual([
      "close_repair",
      "close_mosh",
      "restore_checkpoint",
    ]);
    expect((await store.loadRepair(repair.id)).swap?.state).toBe("failed");
    const failedTypes = (await store.loadEvents(report.playtestId))
      .map((event) => event.type);
    expect(failedTypes.slice(-4)).toEqual([
      "repair.swap.recovered",
      "repair.build.closed",
      "repair.app.closed",
      "repair.swap.failed",
    ]);

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
