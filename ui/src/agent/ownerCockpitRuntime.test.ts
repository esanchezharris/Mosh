import { describe, expect, it, vi } from "vitest";
import { OwnerCockpitRuntime } from "./ownerCockpitRuntime";
import { AgentHostApiError, type HostEvent } from "./agentHostClient";
import type { DraftReportInput } from "./ownerCockpit";

function runtime() {
  let report = 0;
  const client = {
    start: vi.fn(async (retainTranscript: boolean) => ({
      active: true,
      retainTranscript,
      disclosureRequired: true,
    })),
    close: vi.fn(async (retainTranscript: boolean) => ({ active: false, retainTranscript })),
    watchEvents: vi.fn((_onEvent: (event: HostEvent) => void) => () => undefined),
    realtimeSecret: vi.fn(async () => "ek_test"),
    createReport: vi.fn(async (input: DraftReportInput) => ({
      id: `report-${++report}`,
      ...input,
      status: "draft" as const,
    })),
    approveReport: vi.fn(async () => ({ status: "approved" as const })),
    createRepair: vi.fn(async () => ({ id: "repair-1", status: "running" as const })),
    launchRepair: vi.fn(async () => ({ id: "repair-1", state: "repair_running" as const })),
    rollbackRepair: vi.fn(async () => ({ id: "repair-1", state: "rolled_back" as const })),
  };
  return { cockpit: new OwnerCockpitRuntime(client), client };
}

describe("owner cockpit runtime presentation", () => {
  it("shows the hosted-trace disclosure only when the host marks this session", async () => {
    const { cockpit } = runtime();
    await cockpit.start(true);
    expect(cockpit.getSnapshot()).toMatchObject({
      status: "active",
      retainTranscript: true,
      disclosure: expect.stringContaining("Audio, screenshots, media, credentials, and project files are excluded."),
    });
  });

  it("holds minor notes until pause/close flush while surfacing blockers immediately", async () => {
    const { cockpit } = runtime();
    await cockpit.start();
    await cockpit.createReport({ kind: "note", title: "Small spacing", body: "note spacing" });
    expect(cockpit.getSnapshot()).toMatchObject({ reports: [], pendingNotes: 1, urgentMessage: null });

    cockpit.flushQuietReports();
    expect(cockpit.getSnapshot()).toMatchObject({
      reports: [expect.objectContaining({ kind: "note" })],
      pendingNotes: 0,
    });

    await cockpit.createReport({ kind: "blocker", title: "No playback", body: "blocker silence" });
    expect(cockpit.getSnapshot()).toMatchObject({
      urgentMessage: "Blocker captured: No playback",
      reports: [
        expect.objectContaining({ kind: "note" }),
        expect.objectContaining({ kind: "blocker" }),
      ],
    });
  });

  it("rejects the Composer phrase route before an explicit playtest start without invoking screenshot persistence", async () => {
    const { cockpit, client } = runtime();

    await expect(cockpit.createFromText("bug: silent playback")).rejects.toMatchObject({
      name: "AgentHostApiError",
      code: "playtest_not_started",
      retryable: false,
    });

    expect(client.createReport).not.toHaveBeenCalled();
    expect(cockpit.getSnapshot().reports).toEqual([]);
  });

  it("rejects the Felt Wrong route before an explicit playtest start without invoking screenshot persistence", async () => {
    const { cockpit, client } = runtime();

    await expect(cockpit.createReport({
      kind: "bug",
      title: "Felt wrong: drums stiff",
      body: "Felt Wrong submission: drums stiff",
    })).rejects.toMatchObject({
      name: "AgentHostApiError",
      code: "playtest_not_started",
      retryable: false,
    });

    expect(client.createReport).not.toHaveBeenCalled();
    expect(cockpit.getSnapshot().reports).toEqual([]);
  });

  it("offers Fix Now only after approval and records the running repair event", async () => {
    const { cockpit, client } = runtime();
    await cockpit.start();
    const report = await cockpit.createReport({
      kind: "bug",
      title: "Loop jumps",
      body: "The loop jumps at bar four.",
    });
    await expect(cockpit.fixNow(report.id)).rejects.toMatchObject({ code: "approval_required" });
    expect(client.createRepair).not.toHaveBeenCalled();

    await cockpit.approve(report.id);
    expect(cockpit.getSnapshot().reports[0]?.status).toBe("approved");
    await cockpit.fixNow(report.id);
    expect(client.createRepair).toHaveBeenCalledWith(report.id);
    expect(cockpit.getSnapshot().lastEvent).toBe("repair.running");
  });

  it("offers launch after the validated build event and preserves one-click rollback", async () => {
    const { cockpit, client } = runtime();
    await cockpit.start();
    const onEvent = client.watchEvents.mock.calls[0]?.[0];
    onEvent?.({
      sequence: 7,
      type: "repair.full_gate_pending",
      data: { repairId: "repair-1", buildPath: "/worktree/build/Mosh.app" },
    });
    expect(cockpit.getSnapshot().repair).toEqual({
      id: "repair-1",
      status: "ready",
      buildPath: "/worktree/build/Mosh.app",
    });

    await cockpit.launchRepair();
    expect(client.launchRepair).toHaveBeenCalledWith("repair-1", "/worktree/build/Mosh.app");
    await cockpit.rollbackRepair();
    expect(client.rollbackRepair).toHaveBeenCalledWith(
      "repair-1",
      "Owner requested rollback after repair retest",
    );
    expect(cockpit.getSnapshot().repair?.status).toBe("rolled_back");
  });

  it("surfaces a preflight launch rejection without falsely offering rollback", async () => {
    const { cockpit, client } = runtime();
    await cockpit.start();
    const onEvent = client.watchEvents.mock.calls[0]?.[0];
    onEvent?.({
      sequence: 8,
      type: "repair.full_gate_pending",
      data: { repairId: "repair-1", buildPath: "/worktree/build/Mosh.app" },
    });
    client.launchRepair.mockRejectedValueOnce(
      new AgentHostApiError("Launch build does not match the validated repair result", "repair_build_mismatch", false),
    );

    await expect(cockpit.launchRepair()).rejects.toMatchObject({ code: "repair_build_mismatch" });
    expect(cockpit.getSnapshot()).toMatchObject({
      error: "Launch build does not match the validated repair result",
      repair: { id: "repair-1", status: "launch_failed" },
    });
  });

  it("offers rollback only when a swap failure happened after checkpointing", async () => {
    const { cockpit, client } = runtime();
    await cockpit.start();
    const onEvent = client.watchEvents.mock.calls[0]?.[0];
    onEvent?.({
      sequence: 8,
      type: "repair.full_gate_pending",
      data: { repairId: "repair-1", buildPath: "/worktree/build/Mosh.app" },
    });
    onEvent?.({
      sequence: 9,
      type: "repair.swap.failed",
      data: {
        repairId: "repair-1",
        fromState: "preflight",
        hasCheckpoint: false,
        code: "repair_build_mismatch",
      },
    });
    expect(cockpit.getSnapshot().repair?.status).toBe("launch_failed");

    onEvent?.({
      sequence: 10,
      type: "repair.swap.failed",
      data: {
        repairId: "repair-1",
        fromState: "stopping",
        hasCheckpoint: true,
        code: "repair_process_failed",
      },
    });
    expect(cockpit.getSnapshot().repair?.status).toBe("failed");
  });

  it("does not invent rollback after consecutive preflight failures", async () => {
    const { cockpit, client } = runtime();
    await cockpit.start();
    const onEvent = client.watchEvents.mock.calls[0]?.[0];
    onEvent?.({
      sequence: 8,
      type: "repair.full_gate_pending",
      data: { repairId: "repair-1", buildPath: "/worktree/build/Mosh.app" },
    });
    for (const [sequence, fromState] of [[9, "preflight"], [10, "failed"]] as const) {
      onEvent?.({
        sequence,
        type: "repair.swap.failed",
        data: { repairId: "repair-1", fromState, hasCheckpoint: false, code: "repair_build_mismatch" },
      });
      expect(cockpit.getSnapshot().repair?.status).toBe("launch_failed");
    }
    expect(client.rollbackRepair).not.toHaveBeenCalled();
  });

  it("preserves rollback when the checkpointed failure event beats launch rejection", async () => {
    const { cockpit, client } = runtime();
    await cockpit.start();
    const onEvent = client.watchEvents.mock.calls[0]?.[0];
    onEvent?.({
      sequence: 8,
      type: "repair.full_gate_pending",
      data: { repairId: "repair-1", buildPath: "/worktree/build/Mosh.app" },
    });
    client.launchRepair.mockImplementationOnce(async () => {
      onEvent?.({
        sequence: 9,
        type: "repair.swap.failed",
        data: {
          repairId: "repair-1",
          fromState: "stopping",
          hasCheckpoint: true,
          code: "repair_process_failed",
        },
      });
      throw new AgentHostApiError("Repair handoff failed", "repair_process_failed", false);
    });

    await expect(cockpit.launchRepair()).rejects.toMatchObject({ code: "repair_process_failed" });
    expect(cockpit.getSnapshot()).toMatchObject({
      error: "Repair handoff failed",
      repair: { id: "repair-1", status: "failed" },
    });
  });

  it("keeps rollback available when the rollback handoff itself fails", async () => {
    const { cockpit, client } = runtime();
    await cockpit.start();
    cockpit.resumeInstalledRepair("repair-1");
    const onEvent = client.watchEvents.mock.calls[0]?.[0];
    onEvent?.({
      sequence: 9,
      type: "repair.swap.failed",
      data: {
        repairId: "repair-1",
        fromState: "rolling_back",
        hasCheckpoint: true,
        code: "repair_process_failed",
      },
    });
    expect(cockpit.getSnapshot().repair?.status).toBe("failed");
  });

  it("restores one-click rollback when the installed repair app starts", async () => {
    const { cockpit, client } = runtime();
    cockpit.resumeInstalledRepair("repair-1");
    expect(cockpit.getSnapshot().repair).toEqual({ id: "repair-1", status: "repair_running" });

    await cockpit.rollbackRepair();
    expect(client.rollbackRepair).toHaveBeenCalledWith(
      "repair-1",
      "Owner requested rollback after repair retest",
    );
    expect(cockpit.getSnapshot().repair?.status).toBe("rolled_back");
  });
});
