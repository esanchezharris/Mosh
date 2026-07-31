import { describe, expect, it } from "vitest";
import {
  persistedSwapFixture,
  restartedService,
} from "./orchestration-fixture.js";

describe("repair swap restart continuation", () => {
  const hostileFailure = () => Object.assign(new Error([
    "Authorization: Bearer hostile-bearer-token",
    "OPENAI_API_KEY=sk-hostile-openai-token",
    "SUPABASE_SERVICE_ROLE_KEY=supabase-hostile-token",
    "/Users/owner/private/repair.app",
  ].join(" ")), { code: "github_pat_hostilecodevalue" });

  it.each([
    {
      state: "checkpointed" as const,
      actions: ["stop_transport", "release_audio", "close_mosh", "launch_repair"],
      events: [
        "repair.swap.recovered",
        "repair.transport.stopped",
        "repair.audio.released",
        "repair.app.closed",
        "repair.build.launched",
      ],
    },
    {
      state: "stopping" as const,
      actions: ["stop_transport", "release_audio", "close_mosh", "launch_repair"],
      events: [
        "repair.swap.recovered",
        "repair.transport.stopped",
        "repair.audio.released",
        "repair.app.closed",
        "repair.build.launched",
      ],
    },
    {
      state: "current_app_closed" as const,
      actions: ["close_repair", "launch_repair"],
      events: [
        "repair.swap.recovered",
        "repair.build.closed",
        "repair.build.launched",
      ],
    },
  ])("continues persisted $state safely after a new orchestrator starts", async ({
    state,
    actions,
    events,
  }) => {
    const { fakes, store, report, repair } = await persistedSwapFixture(state);
    const restarted = restartedService(store, fakes);
    await restarted.initialize();

    const recovered = await restarted.launchRepairBuild(repair.id, "/build/Mosh.app");

    expect(recovered.swap?.state).toBe("repair_running");
    expect(fakes.processCalls).toEqual(actions);
    const types = (await store.loadEvents(report.playtestId)).map((event) => event.type);
    expect(types.slice(-events.length)).toEqual(events);
  });

  it.each([
    {
      state: "checkpointed" as const,
      failAction: "stop_transport",
      attemptActions: ["stop_transport"],
      attemptEvents: ["repair.swap.recovered", "repair.swap.failed"],
    },
    {
      state: "stopping" as const,
      failAction: "close_mosh",
      attemptActions: ["stop_transport", "release_audio", "close_mosh"],
      attemptEvents: [
        "repair.swap.recovered",
        "repair.transport.stopped",
        "repair.audio.released",
        "repair.swap.failed",
      ],
    },
    {
      state: "current_app_closed" as const,
      failAction: "close_repair",
      attemptActions: ["close_repair"],
      attemptEvents: ["repair.swap.recovered", "repair.swap.failed"],
    },
  ])("rolls back without overlap when restarted $state recovery fails", async ({
    state,
    failAction,
    attemptActions,
    attemptEvents,
  }) => {
    const { fakes, store, report, repair } = await persistedSwapFixture(state);
    fakes.failProcessAction = failAction;
    const firstRestart = restartedService(store, fakes);
    await firstRestart.initialize();
    await expect(firstRestart.launchRepairBuild(repair.id, "/build/Mosh.app"))
      .rejects.toMatchObject({ code: "injected" });
    expect((await store.loadRepair(repair.id)).swap?.state).toBe("failed");
    expect(fakes.processCalls).toEqual(attemptActions);
    const recoveryTypes = (await store.loadEvents(report.playtestId))
      .map((event) => event.type);
    expect(recoveryTypes.slice(-attemptEvents.length)).toEqual(attemptEvents);

    const beforeRollback = fakes.processCalls.length;
    const secondRestart = restartedService(store, fakes);
    await secondRestart.initialize();
    const rolledBack = await secondRestart.rollbackRepair(repair.id, "restart recovery failed");

    expect(fakes.processCalls.slice(beforeRollback)).toEqual([
      "close_repair",
      "close_mosh",
      "restore_checkpoint",
      "launch_prior",
    ]);
    expect(rolledBack.swap?.state).toBe("rolled_back");
    const types = (await store.loadEvents(report.playtestId)).map((event) => event.type);
    expect(types.slice(-6)).toEqual([
      "repair.swap.recovered",
      "repair.build.closed",
      "repair.app.closed",
      "repair.checkpoint.restored",
      "repair.prior_app.launched",
      "repair.swap.rolled_back",
    ]);
  });

  it("redacts hostile helper failures from returned errors, swap JSON, and events", async () => {
    const { fakes, service, store, report, repair } =
      await persistedSwapFixture("checkpointed");
    fakes.failProcessAction = "close_mosh";
    fakes.failProcessError = hostileFailure();

    let launchReturned = "";
    try {
      await service.launchRepairBuild(repair.id, "/build/Mosh.app");
    } catch (error) {
      launchReturned = JSON.stringify({
        code: (error as Error & { code?: string }).code,
        message: (error as Error).message,
      });
    }
    const launchDurable = JSON.stringify({
      repair: await store.loadRepair(repair.id),
      events: await store.loadEvents(report.playtestId),
      returned: launchReturned,
    });
    expect(launchDurable).toContain("[REDACTED]");
    expect(launchDurable).not.toMatch(
      /Authorization|hostile-bearer|sk-hostile|supabase-hostile|github_pat_hostile|\/Users\/owner/u,
    );

    fakes.failProcessAction = "close_repair";
    fakes.failProcessError = hostileFailure();
    let rollbackReturned = "";
    try {
      await service.rollbackRepair(repair.id, "retry after helper failure");
    } catch (error) {
      rollbackReturned = JSON.stringify({
        code: (error as Error & { code?: string }).code,
        message: (error as Error).message,
      });
    }
    const rollbackDurable = JSON.stringify({
      repair: await store.loadRepair(repair.id),
      events: await store.loadEvents(report.playtestId),
      returned: rollbackReturned,
    });
    expect(rollbackDurable).toContain("[REDACTED]");
    expect(rollbackDurable).not.toMatch(
      /Authorization|hostile-bearer|sk-hostile|supabase-hostile|github_pat_hostile|\/Users\/owner/u,
    );
  });
});
