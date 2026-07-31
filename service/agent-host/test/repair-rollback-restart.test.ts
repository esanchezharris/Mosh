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
