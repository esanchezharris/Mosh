import type { RepairJob } from "./contracts.js";
import { safeFailure } from "./audit-boundary.js";
import type { PlaytestStore } from "./persistence.js";
import {
  failure,
  serialized,
  type Dependencies,
  type Emit,
} from "./orchestration-types.js";

export class RepairSwap {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: PlaytestStore,
    private readonly dependencies: Dependencies,
    private readonly emit: Emit,
  ) {}

  launch(repairId: string, buildPath: string): Promise<RepairJob> {
    return serialized(this.tails, repairId, () => this.launchUnlocked(repairId, buildPath));
  }

  rollback(repairId: string, reason: string): Promise<RepairJob> {
    return serialized(this.tails, repairId, () => this.rollbackUnlocked(repairId, reason));
  }

  private async launchUnlocked(repairId: string, buildPath: string): Promise<RepairJob> {
    let current = await this.store.loadRepair(repairId);
    try {
      if (!current.result || !current.worktreePath) {
        throw failure("repair_swap_state", "Repair result is missing");
      }
      const result = current.result;
      const worktreePath = current.worktreePath;
      const validatedBuild = await this.dependencies.artifacts.validateBuild(
        worktreePath,
        buildPath,
        result.sourceSha,
      );
      if (validatedBuild !== result.buildPath) {
        throw failure("repair_build_mismatch", "Launch build does not match the validated repair result");
      }
      const recoverable = new Set(["checkpointed", "stopping"]);
      const failedBeforeCheckpoint = current.swap?.state === "failed" && !current.checkpoint;
      if (current.status !== "full_gate_pending"
        || (current.swap && !recoverable.has(current.swap.state) && !failedBeforeCheckpoint)
        || (current.swap?.buildPath && current.swap.buildPath !== buildPath && !failedBeforeCheckpoint)) {
        throw failure("repair_swap_state", "Repair build is not ready for launch");
      }
      if (!current.checkpoint) {
        const checkpoint = await this.dependencies.processes.checkpoint();
        current = {
          ...current,
          checkpoint,
          swap: { state: "checkpointed", buildPath },
          updatedAt: new Date().toISOString(),
        };
        await this.store.saveRepair(current);
        await this.emit(current.playtestId, "repair.checkpoint.created", { repairId, ...checkpoint });
      } else if (!current.swap) {
        current = {
          ...current,
          swap: { state: "checkpointed", buildPath },
          updatedAt: new Date().toISOString(),
        };
        await this.store.saveRepair(current);
      } else {
        await this.emit(current.playtestId, "repair.swap.recovered", {
          repairId,
          fromState: current.swap.state,
          action: "continue",
        });
      }
      const launchState = current.swap?.state;
      if (!launchState) {
        throw failure("repair_swap_state", "Repair swap reservation is missing");
      }
      current = {
        ...current,
        swap: { state: "stopping", buildPath },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(current);
      await this.dependencies.processes.stopTransport();
      await this.emit(current.playtestId, "repair.transport.stopped", { repairId });
      await this.dependencies.processes.releaseAudio();
      await this.emit(current.playtestId, "repair.audio.released", { repairId });
      await this.dependencies.processes.handoffRepairBuild({
        repairId,
        buildPath: validatedBuild,
        worktreePath,
        sourceSha: result.sourceSha,
        checkpointPath: current.checkpoint!.checkpointPath,
      });
      current = {
        ...current,
        swap: { state: "repair_running", buildPath },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(current);
      await this.emit(current.playtestId, "repair.build.handoff_accepted", {
        repairId,
        buildPath,
      });
      return current;
    } catch (error) {
      const swapFailure = safeFailure(
        error,
        "repair_swap_failed",
        "Repair swap failed",
      );
      const failed: RepairJob = {
        ...current,
        swap: {
          state: "failed",
          buildPath,
          error: swapFailure.message,
        },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(failed);
      await this.emit(current.playtestId, "repair.swap.failed", {
        repairId,
        fromState: current.swap?.state ?? "preflight",
        hasCheckpoint: Boolean(current.checkpoint),
        code: swapFailure.code,
      });
      throw failure(swapFailure.code, swapFailure.message);
    }
  }

  private async rollbackUnlocked(repairId: string, reason: string): Promise<RepairJob> {
    let current = await this.store.loadRepair(repairId);
    if (!current.checkpoint) throw failure("checkpoint_missing", "Repair checkpoint is missing");
    const checkpoint = current.checkpoint;
    if (!current.swap || ![
      "checkpointed",
      "stopping",
      "repair_running",
      "rolling_back",
      "failed",
    ].includes(current.swap.state)) {
      throw failure("repair_swap_state", "Repair build is not in a rollback state");
    }
    const fromState = current.swap.state;
    current = {
      ...current,
      swap: { ...current.swap, state: "rolling_back" },
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveRepair(current);
    try {
      if (fromState !== "repair_running") {
        await this.emit(current.playtestId, "repair.swap.recovered", {
          repairId,
          fromState,
          action: "rollback",
        });
      }
      await this.dependencies.processes.handoffPriorApp({
        checkpointPath: checkpoint.checkpointPath,
        priorAppPath: checkpoint.priorAppPath,
      });
      await this.emit(current.playtestId, "repair.rollback.handoff_accepted", {
        repairId,
        checkpointPath: checkpoint.checkpointPath,
        priorAppPath: checkpoint.priorAppPath,
      });
      const rolledBack: RepairJob = {
        ...current,
        status: "failed",
        swap: { ...current.swap, state: "rolled_back" },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(rolledBack);
      await this.emit(current.playtestId, "repair.swap.rolled_back", { repairId, reason });
      return rolledBack;
    } catch (error) {
      const rollbackFailure = safeFailure(
        error,
        "repair_rollback_failed",
        "Repair rollback failed",
      );
      const failed: RepairJob = {
        ...current,
        swap: { ...current.swap, state: "failed", error: rollbackFailure.message },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(failed);
      await this.emit(current.playtestId, "repair.swap.failed", {
        repairId,
        fromState: "rolling_back",
        hasCheckpoint: true,
        code: rollbackFailure.code,
      });
      throw failure(rollbackFailure.code, rollbackFailure.message);
    }
  }
}
