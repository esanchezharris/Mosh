import { describe, expect, it } from "vitest";
import {
  orchestrationFixture,
  repairResult,
  restartedService,
} from "./orchestration-fixture.js";

describe("repair worktree and app lifecycle", () => {
  it("refuses a dirty base and admits only one active approved repair", async () => {
    const { fakes, service, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    fakes.clean = false;
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "dirty_base" });
    fakes.clean = true;
    const first = await service.createRepair(report.id);
    expect(first.status).toBe("running");
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "repair_active" });
  });

  it("uses an isolated workspace-write thread and preserves draft-only output", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);
    const worktree = fakes.gitCalls
      .map((value) => JSON.parse(value) as { path: string; branch: string })[0];
    expect(worktree?.branch).toBe("codex/playtest-42-loop-jumps");
    expect(worktree?.path).toBe("/worktrees/playtest-42-loop-jumps");
    expect(fakes.appCalls.find((call) =>
      call.kind === "thread"
      && (call.value as { mode?: string }).mode === "workspace-write")?.value).toMatchObject({
      mode: "workspace-write",
      cwd: "/worktrees/playtest-42-loop-jumps",
    });

    const completed = await service.completeRepair(repair.id, repairResult);
    expect(completed.status).toBe("full_gate_pending");
    expect((await store.loadRepair(repair.id)).result?.merged).toBe(false);
  });

  it("preserves the queued crash-window reservation when worktree creation itself fails", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    fakes.failWorktree = true;
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "injected" });
    const reserved = (await store.listRepairs())[0];
    if (!reserved) throw new Error("Expected a reserved repair");
    expect(reserved).toMatchObject({
      status: "queued",
      failure: { code: "injected", message: "injected worktree failure" },
    });
    fakes.failWorktree = false;
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "repair_active" });
    expect(fakes.gitCalls).toHaveLength(1);
  });

  it.each(["initialize", "thread", "turn"] as const)(
    "marks %s startup failure terminal, emits a safe failure, removes its worktree, and permits retry",
    async (stage) => {
      const { fakes, service, store, report } = await orchestrationFixture();
      await service.approveReport(report.id);
      fakes.failAppAction = stage;

      await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "injected" });

      const failed = (await store.listRepairs())[0];
      expect(failed).toMatchObject({
        status: "failed",
        failure: { code: "injected", message: `injected ${stage} failure` },
      });
      expect(fakes.gitCalls.at(-1)).toContain('"remove":');
      expect((await store.loadEvents(report.playtestId)).at(-1)).toMatchObject({
        type: "repair.start.failed",
        data: { repairId: failed?.id, code: "injected", worktreeRemoved: true },
      });

      fakes.failAppAction = undefined;
      await expect(service.createRepair(report.id)).resolves.toMatchObject({ status: "running" });
    },
  );

  it("recovers active-job exclusion and rolls back in safe process order", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);
    const restarted = restartedService(store, fakes);
    await restarted.initialize();
    await expect(restarted.createRepair(report.id)).rejects.toMatchObject({ code: "repair_active" });

    await restarted.completeRepair(repair.id, repairResult);
    await restarted.launchRepairBuild(repair.id, "/build/Mosh.app");
    await restarted.rollbackRepair(repair.id, "retest failed");
    expect(fakes.processCalls).toEqual([
      "checkpoint", "stop_transport", "release_audio", "close_mosh", "launch_repair",
      "close_repair", "close_mosh", "restore_checkpoint", "launch_prior",
    ]);
    const types = (await store.loadEvents(report.playtestId)).map((event) => event.type);
    expect(types.slice(-10)).toEqual([
      "repair.checkpoint.created",
      "repair.transport.stopped",
      "repair.audio.released",
      "repair.app.closed",
      "repair.build.launched",
      "repair.build.closed",
      "repair.app.closed",
      "repair.checkpoint.restored",
      "repair.prior_app.launched",
      "repair.swap.rolled_back",
    ]);
  });

  it("serializes parallel swaps and preserves a recoverable failed transition", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);
    await service.completeRepair(repair.id, repairResult);
    const attempts = await Promise.allSettled([
      service.launchRepairBuild(repair.id, "/build/Mosh.app"),
      service.launchRepairBuild(repair.id, "/build/Mosh.app"),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(fakes.processCalls.filter((call) => call === "launch_repair")).toHaveLength(1);

    await service.rollbackRepair(repair.id, "parallel launch probe");
    expect((await store.loadRepair(repair.id)).swap?.state).toBe("rolled_back");

    const second = await orchestrationFixture();
    await second.service.approveReport(second.report.id);
    const secondRepair = await second.service.createRepair(second.report.id);
    await second.service.completeRepair(secondRepair.id, repairResult);
    second.fakes.failProcessAction = "close_mosh";
    await expect(second.service.launchRepairBuild(secondRepair.id, "/build/Mosh.app"))
      .rejects.toMatchObject({ code: "injected" });
    expect(await second.store.loadRepair(secondRepair.id)).toMatchObject({
      checkpoint: { checkpointPath: "/tmp/checkpoint.mosh" },
      swap: { state: "failed", buildPath: "/build/Mosh.app" },
    });
    await second.service.rollbackRepair(secondRepair.id, "injected failure");
    expect((await second.store.loadRepair(secondRepair.id)).swap?.state).toBe("rolled_back");
  });

  it("rejects a launch path that differs from the validated result before checkpoint or close", async () => {
    const { fakes, service, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);
    await service.completeRepair(repair.id, repairResult);

    await expect(service.launchRepairBuild(repair.id, "/outside/Evil.app"))
      .rejects.toMatchObject({ code: "repair_build_mismatch" });

    expect(fakes.processCalls).toEqual([]);
  });

  it("rejects a claimed source SHA that differs from the repair worktree HEAD", async () => {
    const { fakes, service, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);

    await expect(service.completeRepair(repair.id, {
      ...repairResult,
      sourceSha: "2".repeat(40),
    })).rejects.toMatchObject({ code: "repair_source_mismatch" });

    expect(fakes.processCalls).toEqual([]);
  });
});
