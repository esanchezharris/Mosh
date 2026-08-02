import type { EvidenceRecord, PlaytestReport } from "./contracts.js";
import type { PlaytestStore } from "./persistence.js";
import { reportContext } from "./report-context.js";
import {
  failure,
  serialized,
  type Dependencies,
  type Emit,
} from "./orchestration-types.js";

export class ReportCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: PlaytestStore,
    private readonly dependencies: Dependencies,
    private readonly emit: Emit,
  ) {}

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
    const intentAt = new Date().toISOString();
    const withIntent: PlaytestReport = {
      ...report,
      evidence,
      syncIntent: {
        marker: `mosh-playtest-report:${report.id}`,
        state: "pending",
        updatedAt: intentAt,
      },
    };
    await this.store.saveReport(withIntent);
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
      ? { ...withIntent, status: "approved_pending_sync", updatedAt }
      : {
          ...withIntent,
          status: "approved",
          updatedAt,
          external: { issueNumber: sync.issueNumber, issueUrl: sync.issueUrl },
          syncIntent: {
            ...withIntent.syncIntent!,
            state: "synced",
            updatedAt,
            issueNumber: sync.issueNumber,
          },
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
    return serialized(this.tails, report.playtestId, () => this.coordinateUnlocked(report));
  }

  private async coordinateUnlocked(report: PlaytestReport): Promise<void> {
    const session = await this.store.loadSession(report.playtestId);
    const sessionText = await this.store.loadTranscript(report.playtestId);
    const prompt = reportContext(report, sessionText);
    let threadId = session.coordinator?.state === "ready"
      ? session.coordinator.threadId
      : session.coordinatorThreadId;
    if (session.coordinator?.state === "starting" || session.coordinator?.state === "failed") {
      throw failure("coordinator_recovery_required", "Coordinator reservation requires owner recovery");
    }
    await this.dependencies.appServer.initialize();
    if (!threadId) {
      const reservationId = crypto.randomUUID();
      await this.store.saveSession({
        ...session,
        coordinator: { state: "starting", reservationId },
        updatedAt: new Date().toISOString(),
      });
      try {
        threadId = await this.dependencies.appServer.startThread(
          { mode: "read-only", cwd: this.dependencies.repositoryPath },
          (event) => this.emit(report.playtestId, `codex.${event.type}`, { ...event.data }),
        );
      } catch (error) {
        await this.store.saveSession({
          ...session,
          coordinator: {
            state: "failed",
            reservationId,
            code: (error as Error & { code?: string }).code ?? "coordinator_start_failed",
          },
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
      await this.store.saveSession({
        ...session,
        coordinatorThreadId: threadId,
        coordinator: { state: "ready", reservationId, threadId },
        updatedAt: new Date().toISOString(),
      });
      await this.emit(report.playtestId, "codex.coordinator.started", { threadId, mode: "read-only" });
    }
    const turnId = await this.dependencies.appServer.startTurn({
      threadId,
      prompt,
      mode: "read-only",
      cwd: this.dependencies.repositoryPath,
    });
    await this.emit(report.playtestId, "codex.turn.started", { threadId, turnId, reportId: report.id });
  }
}
