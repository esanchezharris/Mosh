import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHostService } from "../src/service.js";
import { PlaytestStore } from "../src/persistence.js";
import { startAgentHost } from "../src/server.js";
import {
  OwnerOrchestrator,
  type AppServerAdapter,
  type EvidenceAdapter,
  type GitAdapter,
  type GitHubAdapter,
  type ProcessAdapter,
} from "../src/orchestration.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

class Fakes {
  evidenceCalls: string[] = [];
  githubCalls: string[] = [];
  appCalls: Array<{ kind: string; value: unknown }> = [];
  gitCalls: string[] = [];
  processCalls: string[] = [];
  clean = true;
  authenticated = true;
  githubTransportFailure = false;
  evidenceSha = "a".repeat(64);
  failWorktree = false;
  failProcessAction: string | undefined;

  evidence: EvidenceAdapter = {
    uploadPng: async (input) => {
      this.evidenceCalls.push(JSON.stringify(input));
      return {
        evidenceId: input.evidenceId,
        sha256: this.evidenceSha,
        objectPath: `${input.playtestId}/${input.reportId}/${input.evidenceId}.png`,
        previewUrl: "https://preview.invalid/signed",
        previewExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };
  github: GitHubAdapter = {
    syncApprovedReport: async (input) => {
      this.githubCalls.push(JSON.stringify(input));
      if (!this.authenticated) return { status: "auth_missing" };
      if (this.githubTransportFailure) {
        throw Object.assign(new Error("ambiguous GitHub transport failure"), { code: "github_failed" });
      }
      return { status: "synced", issueNumber: input.kind === "note" ? 88 : 42, issueUrl: "https://github.invalid/42" };
    },
  };
  appServer: AppServerAdapter = {
    initialize: async () => {
      this.appCalls.push({ kind: "initialize", value: null });
    },
    startThread: async (input) => {
      this.appCalls.push({ kind: "thread", value: input });
      return `${input.mode}-thread`;
    },
    startTurn: async (input) => {
      this.appCalls.push({ kind: "turn", value: input });
      return "turn-1";
    },
  };
  git: GitAdapter = {
    inspectBase: async () => ({ sha: "1".repeat(40), clean: this.clean }),
    createWorktree: async (input) => {
      this.gitCalls.push(JSON.stringify(input));
      if (this.failWorktree) throw Object.assign(new Error("injected worktree failure"), { code: "injected" });
    },
  };
  processes: ProcessAdapter = {
    checkpoint: async () => {
      this.processCalls.push("checkpoint");
      return { checkpointPath: "/tmp/checkpoint.mosh", priorAppPath: "/Applications/Mosh.app" };
    },
    stopTransport: async () => { await this.processAction("stop_transport"); },
    releaseAudio: async () => { await this.processAction("release_audio"); },
    closeMosh: async () => { await this.processAction("close_mosh"); },
    launchRepairBuild: async () => { await this.processAction("launch_repair"); },
    closeRepairBuild: async () => { this.processCalls.push("close_repair"); },
    restoreCheckpoint: async () => { this.processCalls.push("restore_checkpoint"); },
    launchPriorApp: async () => { this.processCalls.push("launch_prior"); },
  };

  private async processAction(name: string): Promise<void> {
    this.processCalls.push(name);
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (this.failProcessAction === name) {
      this.failProcessAction = undefined;
      throw Object.assign(new Error(`injected ${name} failure`), { code: "injected" });
    }
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mosh-task4-"));
  const fakes = new Fakes();
  const store = new PlaytestStore(root);
  const orchestration = new OwnerOrchestrator(store, {
    evidence: fakes.evidence,
    github: fakes.github,
    appServer: fakes.appServer,
    git: fakes.git,
    processes: fakes.processes,
    repositoryPath: "/repo",
    worktreeRoot: "/worktrees",
  });
  const service = new AgentHostService(store, undefined, undefined, orchestration);
  await service.initialize();
  const playtest = await service.createPlaytest({});
  const imagePath = path.join(root, "window.png");
  await writeFile(imagePath, PNG);
  const report = await service.createReport({
    playtestId: playtest.id,
    kind: "bug",
    title: "Loop jumps",
    body: "At the fourth bar the loop jumps.",
    evidence: [{
      kind: "screenshot",
      localPath: imagePath,
      sha256: "a".repeat(64),
      metadata: {
        buildSha: "1".repeat(40),
        dirtyDigest: "clean",
        snapshotDigest: "c".repeat(64),
        recentResults: [{ ok: false, command: "set_loop" }],
        projectReference: "must-not-leave-host.mosh",
        audioPayload: "must-not-leave-host",
      },
    }],
  });
  return { root, fakes, service, store, orchestration, playtest, report };
}

const repairResult = {
  redEvidencePath: "/evidence/red.log",
  greenEvidencePath: "/evidence/green.log",
  diagnosticsPath: "/evidence/diagnostics.log",
  bundlePath: "/evidence/repair-bundle",
  buildPath: "/build/Mosh.app",
  draftPrUrl: "https://github.invalid/pull/9",
  draft: true as const,
  merged: false as const,
};

describe("owner orchestration approval and coordinator", () => {
  it("performs no external write before approval, then uploads immutable PNG evidence and syncs one issue", async () => {
    const { fakes, service, report } = await fixture();
    expect(fakes.evidenceCalls).toEqual([]);
    expect(fakes.githubCalls).toEqual([]);

    const approved = await service.approveReport(report.id);

    expect(approved.status).toBe("approved");
    expect(fakes.evidenceCalls).toHaveLength(1);
    expect(fakes.githubCalls).toHaveLength(1);
    expect(fakes.evidenceCalls[0]).not.toContain("owner-secret");
  });

  it("refuses an uploaded checksum that differs from the durable local screenshot", async () => {
    const { fakes, service, report } = await fixture();
    fakes.evidenceSha = "b".repeat(64);
    await expect(service.approveReport(report.id)).rejects.toMatchObject({
      code: "evidence_checksum_mismatch",
    });
    expect(fakes.githubCalls).toEqual([]);
  });

  it("keeps missing gh authentication pending and retries idempotently through the same report identity", async () => {
    const { fakes, service, store, report } = await fixture();
    fakes.authenticated = false;
    expect((await service.approveReport(report.id)).status).toBe("approved_pending_sync");
    fakes.authenticated = true;
    expect((await service.approveReport(report.id)).status).toBe("approved");
    const calls = fakes.githubCalls.map((call) =>
      (JSON.parse(call) as { reportId: string }).reportId);
    expect(calls).toEqual([report.id, report.id]);
    expect((await store.loadReport(report.id)).external?.issueNumber).toBe(42);
  });

  it("persists the stable sync intent before an ambiguous GitHub result", async () => {
    const { fakes, service, store, report } = await fixture();
    fakes.githubTransportFailure = true;
    await expect(service.approveReport(report.id)).rejects.toMatchObject({ code: "github_failed" });
    expect(await store.loadReport(report.id)).toMatchObject({
      syncIntent: {
        marker: `mosh-playtest-report:${report.id}`,
        state: "pending",
      },
    });
  });

  it("creates one scrubbed read-only coordinator thread per playtest and records streamed events", async () => {
    const { fakes, service, store, playtest, report } = await fixture();
    await service.approveReport(report.id);
    await service.coordinateReport(report.id);
    await service.coordinateReport(report.id);

    const threads = fakes.appCalls.filter((call) => call.kind === "thread");
    expect(threads).toHaveLength(1);
    expect(threads[0]?.value).toMatchObject({ mode: "read-only", cwd: "/repo" });
    const serialized = JSON.stringify(fakes.appCalls);
    expect(serialized).toContain("Loop jumps");
    expect(serialized).not.toContain("must-not-leave-host");
    expect((await store.loadEvents(playtest.id)).map((event) => event.type)).toContain("codex.turn.started");
  });

  it("serializes concurrent coordinator creation and fails closed on a stranded reservation", async () => {
    const { fakes, service, store, playtest, report } = await fixture();
    await service.approveReport(report.id);
    const session = await store.loadSession(playtest.id);
    const unreserved = { ...session };
    delete unreserved.coordinatorThreadId;
    delete unreserved.coordinator;
    await store.saveSession({ ...unreserved, updatedAt: new Date().toISOString() });
    fakes.appCalls.length = 0;

    await Promise.all([
      service.coordinateReport(report.id),
      service.coordinateReport(report.id),
    ]);
    expect(fakes.appCalls.filter((call) => call.kind === "thread")).toHaveLength(1);

    const ready = await store.loadSession(playtest.id);
    const stranded = {
      ...ready,
      coordinator: { state: "starting", reservationId: crypto.randomUUID() },
      updatedAt: new Date().toISOString(),
    } as const;
    delete (stranded as { coordinatorThreadId?: string }).coordinatorThreadId;
    await store.saveSession(stranded);
    const before = fakes.appCalls.length;
    await expect(service.coordinateReport(report.id)).rejects.toMatchObject({
      code: "coordinator_recovery_required",
    });
    expect(fakes.appCalls).toHaveLength(before);
  });

  it("rejects nested result payloads before sending any report context to app-server", async () => {
    const { fakes, orchestration, report } = await fixture();
    const unsafe = structuredClone(report);
    unsafe.evidence[0]!.metadata.recentResults = [{
      command: "set_loop",
      ok: false,
      payload: { audio: "data:audio/wav;base64,AAAA" },
    }];
    await expect(orchestration.coordinateReport(unsafe)).rejects.toThrow();
    expect(fakes.appCalls).toEqual([]);
  });
});

describe("repair worktree and app lifecycle", () => {
  it("refuses a dirty base and admits only one active approved repair", async () => {
    const { fakes, service, report } = await fixture();
    await service.approveReport(report.id);
    fakes.clean = false;
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "dirty_base" });
    fakes.clean = true;
    const first = await service.createRepair(report.id);
    expect(first.status).toBe("running");
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "repair_active" });
  });

  it("uses an isolated workspace-write thread and preserves draft-only full-gate-pending output", async () => {
    const { fakes, service, store, report } = await fixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);
    const worktree = fakes.gitCalls.map((value) => JSON.parse(value) as { path: string; branch: string })[0];
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

  it("persists a queued reservation before worktree creation and blocks duplicate recovery after failure", async () => {
    const { fakes, service, store, report } = await fixture();
    await service.approveReport(report.id);
    fakes.failWorktree = true;
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "injected" });
    const reserved = (await store.listRepairs())[0]!;
    expect(reserved).toMatchObject({
      status: "queued",
      failure: { code: "injected", message: "injected worktree failure" },
    });
    fakes.failWorktree = false;
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "repair_active" });
    expect(fakes.gitCalls).toHaveLength(1);
  });

  it("recovers active-job exclusion after restart and rolls back in safe process order", async () => {
    const { fakes, service, store, report } = await fixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);
    const restarted = new AgentHostService(
      store,
      undefined,
      undefined,
      new OwnerOrchestrator(store, {
        evidence: fakes.evidence,
        github: fakes.github,
        appServer: fakes.appServer,
        git: fakes.git,
        processes: fakes.processes,
        repositoryPath: "/repo",
        worktreeRoot: "/worktrees",
      }),
    );
    await restarted.initialize();
    await expect(restarted.createRepair(report.id)).rejects.toMatchObject({ code: "repair_active" });

    await restarted.completeRepair(repair.id, repairResult);
    await restarted.launchRepairBuild(repair.id, "/build/Mosh.app");
    await restarted.rollbackRepair(repair.id, "retest failed");
    expect(fakes.processCalls).toEqual([
      "checkpoint", "stop_transport", "release_audio", "close_mosh", "launch_repair",
      "close_repair", "restore_checkpoint", "launch_prior",
    ]);
    const types = (await store.loadEvents(report.playtestId)).map((event) => event.type);
    expect(types.slice(-8)).toEqual([
      "repair.checkpoint.created",
      "repair.transport.stopped",
      "repair.audio.released",
      "repair.app.closed",
      "repair.build.launched",
      "repair.build.closed",
      "repair.checkpoint.restored",
      "repair.prior_app.launched",
    ]);
  });

  it("serializes parallel swaps and persists a recoverable failed transition before rollback", async () => {
    const { fakes, service, store, report } = await fixture();
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
    const rolledBack = await store.loadRepair(repair.id);
    expect(rolledBack.swap?.state).toBe("rolled_back");

    const second = await fixture();
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
});

describe("authenticated orchestration routes", () => {
  it("rejects unauthenticated Fix Now and admits the approved authenticated request", async () => {
    const { service, report } = await fixture();
    const host = await startAgentHost({ service, capability: "task4-capability" });
    try {
      const unauthenticated = await fetch(`${host.origin}/v1/reports/${report.id}/repairs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(unauthenticated.status).toBe(401);
      const approved = await fetch(`${host.origin}/v1/reports/${report.id}/approve`, {
        method: "POST",
        headers: {
          Authorization: "Bearer task4-capability",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(approved.status).toBe(200);
      const repair = await fetch(`${host.origin}/v1/reports/${report.id}/repairs`, {
        method: "POST",
        headers: {
          Authorization: "Bearer task4-capability",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(repair.status).toBe(201);
      expect(await repair.json()).toMatchObject({ status: "running", reportId: report.id });
    } finally {
      await host.close();
    }
  });
});
