import path from "node:path";
import type { PlaytestReport, RepairJob } from "./contracts.js";
import { safeFailure } from "./audit-boundary.js";
import type { PlaytestStore } from "./persistence.js";
import { reportContext } from "./report-context.js";
import {
  failure,
  type Dependencies,
  type Emit,
} from "./orchestration-types.js";

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 48) || "repair";
}

export class RepairManager {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: PlaytestStore,
    private readonly dependencies: Dependencies,
    private readonly emit: Emit,
  ) {}

  async create(report: PlaytestReport): Promise<RepairJob> {
    const preceding = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await this.createUnlocked(report);
    } finally {
      release();
    }
  }

  private async createUnlocked(report: PlaytestReport): Promise<RepairJob> {
    if (report.status !== "approved" || !report.approvedAt) {
      throw failure("approval_required", "Owner approval is required before repair");
    }
    if (!report.external) {
      throw failure("github_sync_required", "GitHub issue sync is required before repair");
    }
    const active = (await this.store.listRepairs()).find((job) =>
      job.status === "queued" || job.status === "running" || job.status === "full_gate_pending");
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
    const sessionText = await this.store.loadTranscript(report.playtestId);
    const prompt = `${reportContext(report, sessionText)}\nReproduce with a focused RED, implement the smallest GREEN, capture diagnostics and a repair bundle, then open a draft PR. Never merge.`;
    const at = new Date().toISOString();
    let repair: RepairJob = {
      version: 1,
      id: crypto.randomUUID(),
      playtestId: report.playtestId,
      reportId: report.id,
      status: "queued",
      baseSha: base.sha,
      branch,
      worktreePath,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.saveRepair(repair);
    await this.emit(report.playtestId, "repair.reserved", {
      repairId: repair.id,
      reportId: report.id,
      branch,
      worktreePath,
      baseSha: base.sha,
    });
    let repairThreadId: string;
    let worktreeCreated = false;
    try {
      await this.dependencies.git.createWorktree({
        repositoryPath: this.dependencies.repositoryPath,
        baseSha: base.sha,
        branch,
        path: worktreePath,
      });
      worktreeCreated = true;
      await this.dependencies.appServer.initialize();
      repairThreadId = await this.dependencies.appServer.startThread(
        { mode: "workspace-write", cwd: worktreePath },
        (event) => this.emit(report.playtestId, `repair.codex.${event.type}`, { ...event.data }),
      );
    } catch (error) {
      const startFailure = safeFailure(
        error,
        "repair_start_failed",
        "Repair start failed",
      );
      repair = {
        ...repair,
        status: worktreeCreated ? "failed" : "queued",
        failure: startFailure,
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(repair);
      if (worktreeCreated) {
        let worktreeRemoved = false;
        try {
          await this.dependencies.git.removeWorktree({
            repositoryPath: this.dependencies.repositoryPath,
            path: worktreePath,
            branch,
          });
          worktreeRemoved = true;
        } catch {
          worktreeRemoved = false;
        }
        await this.emit(report.playtestId, "repair.start.failed", {
          repairId: repair.id,
          code: repair.failure?.code ?? "repair_start_failed",
          worktreeRemoved,
        });
      }
      throw failure(startFailure.code, startFailure.message);
    }
    repair = {
      ...repair,
      status: "running",
      repairThreadId,
      updatedAt: new Date().toISOString(),
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
    try {
      await this.dependencies.appServer.startTurn({
        threadId: repairThreadId,
        prompt,
        mode: "workspace-write",
        cwd: worktreePath,
      });
    } catch (error) {
      const startFailure = safeFailure(
        error,
        "repair_start_failed",
        "Repair start failed",
      );
      repair = {
        ...repair,
        status: "failed",
        failure: startFailure,
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(repair);
      let worktreeRemoved = false;
      try {
        await this.dependencies.git.removeWorktree({
          repositoryPath: this.dependencies.repositoryPath,
          path: worktreePath,
          branch,
        });
        worktreeRemoved = true;
      } catch {
        worktreeRemoved = false;
      }
      await this.emit(report.playtestId, "repair.start.failed", {
        repairId: repair.id,
        code: startFailure.code,
        worktreeRemoved,
      });
      throw failure(startFailure.code, startFailure.message);
    }
    return repair;
  }

  async complete(
    repair: RepairJob,
    result: NonNullable<RepairJob["result"]>,
  ): Promise<RepairJob> {
    if (!repair.worktreePath) {
      throw failure("repair_worktree_path", "Repair worktree is missing");
    }
    const source = await this.dependencies.git.inspectBase(repair.worktreePath);
    if (source.sha !== result.sourceSha) {
      throw failure("repair_source_mismatch", "Repair source SHA does not match its worktree HEAD");
    }
    const validated = await this.dependencies.artifacts.validateResult(repair.worktreePath, result);
    const completed: RepairJob = {
      ...repair,
      status: "full_gate_pending",
      result: validated,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveRepair(completed);
    await this.emit(repair.playtestId, "repair.full_gate_pending", {
      repairId: repair.id,
      redEvidencePath: validated.redEvidencePath,
      greenEvidencePath: validated.greenEvidencePath,
      diagnosticsPath: validated.diagnosticsPath,
      bundlePath: validated.bundlePath,
      buildPath: validated.buildPath,
      sourceSha: validated.sourceSha,
      draftPrUrl: validated.draftPrUrl,
      draft: true,
      merged: false,
    });
    return completed;
  }
}
