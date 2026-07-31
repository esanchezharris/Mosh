import path from "node:path";
import type {
  AuditEvent,
  EvidenceRecord,
  PlaytestReport,
  RepairJob,
} from "./contracts.js";
import { PlaytestStore } from "./persistence.js";

export type UploadedEvidence = {
  evidenceId: string;
  sha256: string;
  objectPath: string;
  previewUrl: string;
  previewExpiresAt: string;
};

export interface EvidenceAdapter {
  uploadPng(input: {
    evidenceId: string;
    playtestId: string;
    reportId: string;
    localPath: string;
  }): Promise<UploadedEvidence>;
}

export interface GitHubAdapter {
  syncApprovedReport(input: {
    reportId: string;
    playtestId: string;
    kind: PlaytestReport["kind"];
    title: string;
    body: string;
    evidence: ReadonlyArray<UploadedEvidence>;
  }): Promise<
    | { status: "auth_missing" }
    | { status: "synced"; issueNumber: number; issueUrl: string }
  >;
}

export type AppServerEvent = {
  type: "thread" | "turn" | "approval" | "progress";
  data: Readonly<Record<string, unknown>>;
};

export interface AppServerAdapter {
  initialize(): Promise<void>;
  startThread(
    input: { mode: "read-only" | "workspace-write"; cwd: string },
    onEvent?: (event: AppServerEvent) => void,
  ): Promise<string>;
  startTurn(input: { threadId: string; prompt: string }): Promise<string>;
}

export interface GitAdapter {
  inspectBase(repositoryPath: string): Promise<{ sha: string; clean: boolean }>;
  createWorktree(input: {
    repositoryPath: string;
    baseSha: string;
    branch: string;
    path: string;
  }): Promise<void>;
}

export type RepairCheckpoint = {
  checkpointPath: string;
  priorAppPath: string;
};

export interface ProcessAdapter {
  checkpoint(): Promise<RepairCheckpoint>;
  stopTransport(): Promise<void>;
  releaseAudio(): Promise<void>;
  closeMosh(): Promise<void>;
  launchRepairBuild(buildPath: string): Promise<void>;
  closeRepairBuild(): Promise<void>;
  restoreCheckpoint(checkpointPath: string): Promise<void>;
  launchPriorApp(appPath: string): Promise<void>;
}

type EventSink = (
  playtestId: string,
  type: string,
  data: Record<string, unknown>,
) => Promise<AuditEvent>;

type Dependencies = {
  evidence: EvidenceAdapter;
  github: GitHubAdapter;
  appServer: AppServerAdapter;
  git: GitAdapter;
  processes: ProcessAdapter;
  repositoryPath: string;
  worktreeRoot: string;
};

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 48) || "repair";
}

function reportContext(report: PlaytestReport, sessionText: unknown[] = []): string {
  const evidence = report.evidence.map((item) => ({
    localScreenshotPath: item.kind === "screenshot" ? item.localPath : undefined,
    buildSha: item.metadata.buildSha,
    dirtyDigest: item.metadata.dirtyDigest,
    snapshotDigest: item.metadata.snapshotDigest,
    timelinePosition: item.metadata.timelinePosition,
    recentMoshOpsEnvelopes: item.metadata.recentResults,
  }));
  return JSON.stringify({
    session: { playtestId: report.playtestId, text: sessionText },
    report: { id: report.id, kind: report.kind, title: report.title, body: report.body },
    issue: report.external,
    evidence,
  });
}

export class OwnerOrchestrator {
  private emitEvent?: EventSink;
  private repairTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: PlaytestStore,
    private readonly dependencies: Dependencies,
  ) {}

  setEventSink(sink: EventSink): void {
    this.emitEvent = sink;
  }

  private async emit(playtestId: string, type: string, data: Record<string, unknown>): Promise<void> {
    if (this.emitEvent) await this.emitEvent(playtestId, type, data);
  }

  async syncApprovedReport(report: PlaytestReport): Promise<PlaytestReport> {
    const evidence: EvidenceRecord[] = [];
    for (const item of report.evidence) {
      if (item.kind !== "screenshot" || item.remote) {
        evidence.push(item);
        continue;
      }
      const uploaded = await this.dependencies.evidence.uploadPng({
        evidenceId: item.id,
        playtestId: item.playtestId,
        reportId: item.reportId,
        localPath: item.localPath,
      });
      if (uploaded.evidenceId !== item.id) {
        throw failure("evidence_identity_mismatch", "Evidence identity changed during upload");
      }
      if (uploaded.sha256 !== item.sha256) {
        throw failure("evidence_checksum_mismatch", "Uploaded evidence checksum differs from the local screenshot");
      }
      evidence.push({ ...item, remote: uploaded });
      await this.emit(report.playtestId, "evidence.uploaded", {
        reportId: report.id,
        evidenceId: item.id,
        sha256: uploaded.sha256,
        objectPath: uploaded.objectPath,
        previewExpiresAt: uploaded.previewExpiresAt,
      });
    }
    const withEvidence = { ...report, evidence };
    await this.store.saveReport(withEvidence);
    const sync = await this.dependencies.github.syncApprovedReport({
      reportId: report.id,
      playtestId: report.playtestId,
      kind: report.kind,
      title: report.title,
      body: report.body,
      evidence: evidence.flatMap((item) => item.remote ? [item.remote] : []),
    });
    const updatedAt = new Date().toISOString();
    const synced: PlaytestReport = sync.status === "auth_missing"
      ? { ...withEvidence, status: "approved_pending_sync", updatedAt }
      : {
          ...withEvidence,
          status: "approved",
          updatedAt,
          external: { issueNumber: sync.issueNumber, issueUrl: sync.issueUrl },
        };
    await this.store.saveReport(synced);
    await this.emit(report.playtestId,
      sync.status === "auth_missing" ? "report.sync.pending" : "report.sync.completed",
      sync.status === "auth_missing"
        ? { reportId: report.id, reason: "github_auth_missing" }
        : { reportId: report.id, issueNumber: sync.issueNumber, issueUrl: sync.issueUrl });
    return synced;
  }

  async coordinateReport(report: PlaytestReport): Promise<void> {
    const session = await this.store.loadSession(report.playtestId);
    const sessionText = await this.store.loadTranscript(report.playtestId);
    await this.dependencies.appServer.initialize();
    let threadId = session.coordinatorThreadId;
    if (!threadId) {
      threadId = await this.dependencies.appServer.startThread(
        { mode: "read-only", cwd: this.dependencies.repositoryPath },
        (event) => void this.emit(report.playtestId, `codex.${event.type}`, { ...event.data }),
      );
      await this.store.saveSession({ ...session, coordinatorThreadId: threadId, updatedAt: new Date().toISOString() });
      await this.emit(report.playtestId, "codex.coordinator.started", { threadId, mode: "read-only" });
    }
    const turnId = await this.dependencies.appServer.startTurn({
      threadId,
      prompt: reportContext(report, sessionText),
    });
    await this.emit(report.playtestId, "codex.turn.started", { threadId, turnId, reportId: report.id });
  }

  async createRepair(report: PlaytestReport): Promise<RepairJob> {
    const preceding = this.repairTail;
    let release = (): void => undefined;
    this.repairTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await this.createRepairUnlocked(report);
    } finally {
      release();
    }
  }

  private async createRepairUnlocked(report: PlaytestReport): Promise<RepairJob> {
    if (report.status !== "approved" || !report.approvedAt) {
      throw failure("approval_required", "Owner approval is required before repair");
    }
    if (!report.external) {
      throw failure("github_sync_required", "GitHub issue sync is required before repair");
    }
    const active = (await this.store.listRepairs()).find((job) =>
      job.status === "queued" || job.status === "running");
    if (active) throw failure("repair_active", "Another repair is already active");
    const base = await this.dependencies.git.inspectBase(this.dependencies.repositoryPath);
    if (!base.clean) throw failure("dirty_base", "Repair requires a clean committed base");
    const reportedSha = report.evidence.find((item) =>
      typeof item.metadata.buildSha === "string")?.metadata.buildSha;
    if (reportedSha !== base.sha) {
      throw failure("base_sha_mismatch", "Report build SHA does not match the clean committed base");
    }
    const name = `playtest-${report.external.issueNumber}-${slug(report.title)}`;
    const branch = `codex/${name}`;
    const worktreePath = path.join(this.dependencies.worktreeRoot, name);
    await this.dependencies.git.createWorktree({
      repositoryPath: this.dependencies.repositoryPath,
      baseSha: base.sha,
      branch,
      path: worktreePath,
    });
    await this.dependencies.appServer.initialize();
    const repairThreadId = await this.dependencies.appServer.startThread(
      { mode: "workspace-write", cwd: worktreePath },
      (event) => void this.emit(report.playtestId, `repair.codex.${event.type}`, { ...event.data }),
    );
    const at = new Date().toISOString();
    const repair: RepairJob = {
      version: 1,
      id: crypto.randomUUID(),
      playtestId: report.playtestId,
      reportId: report.id,
      status: "running",
      baseSha: base.sha,
      branch,
      worktreePath,
      repairThreadId,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.saveRepair(repair);
    await this.emit(report.playtestId, "repair.started", {
      repairId: repair.id,
      reportId: report.id,
      branch,
      worktreePath,
      baseSha: base.sha,
      repairThreadId,
    });
    const sessionText = await this.store.loadTranscript(report.playtestId);
    await this.dependencies.appServer.startTurn({
      threadId: repairThreadId,
      prompt: `${reportContext(report, sessionText)}\nReproduce with a focused RED, implement the smallest GREEN, capture diagnostics and a repair bundle, then open a draft PR. Never merge.`,
    });
    return repair;
  }

  async completeRepair(repair: RepairJob, result: NonNullable<RepairJob["result"]>): Promise<RepairJob> {
    const completed: RepairJob = {
      ...repair,
      status: "full_gate_pending",
      result,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveRepair(completed);
    await this.emit(repair.playtestId, "repair.full_gate_pending", {
      repairId: repair.id,
      redEvidencePath: result.redEvidencePath,
      greenEvidencePath: result.greenEvidencePath,
      diagnosticsPath: result.diagnosticsPath,
      bundlePath: result.bundlePath,
      buildPath: result.buildPath,
      draftPrUrl: result.draftPrUrl,
      draft: true,
      merged: false,
    });
    return completed;
  }

  async launchRepairBuild(repair: RepairJob, buildPath: string): Promise<RepairJob> {
    const checkpoint = await this.dependencies.processes.checkpoint();
    await this.emit(repair.playtestId, "repair.checkpoint.created", { repairId: repair.id, ...checkpoint });
    await this.dependencies.processes.stopTransport();
    await this.emit(repair.playtestId, "repair.transport.stopped", { repairId: repair.id });
    await this.dependencies.processes.releaseAudio();
    await this.emit(repair.playtestId, "repair.audio.released", { repairId: repair.id });
    await this.dependencies.processes.closeMosh();
    await this.emit(repair.playtestId, "repair.app.closed", { repairId: repair.id });
    await this.dependencies.processes.launchRepairBuild(buildPath);
    await this.emit(repair.playtestId, "repair.build.launched", { repairId: repair.id, buildPath });
    const updated = { ...repair, checkpoint, updatedAt: new Date().toISOString() };
    await this.store.saveRepair(updated);
    return updated;
  }

  async rollbackRepair(repair: RepairJob, reason: string): Promise<RepairJob> {
    if (!repair.checkpoint) throw failure("checkpoint_missing", "Repair checkpoint is missing");
    await this.dependencies.processes.closeRepairBuild();
    await this.emit(repair.playtestId, "repair.build.closed", { repairId: repair.id, reason });
    await this.dependencies.processes.restoreCheckpoint(repair.checkpoint.checkpointPath);
    await this.emit(repair.playtestId, "repair.checkpoint.restored", {
      repairId: repair.id,
      checkpointPath: repair.checkpoint.checkpointPath,
    });
    await this.dependencies.processes.launchPriorApp(repair.checkpoint.priorAppPath);
    await this.emit(repair.playtestId, "repair.prior_app.launched", {
      repairId: repair.id,
      priorAppPath: repair.checkpoint.priorAppPath,
    });
    const failed = { ...repair, status: "failed" as const, updatedAt: new Date().toISOString() };
    await this.store.saveRepair(failed);
    return failed;
  }
}
