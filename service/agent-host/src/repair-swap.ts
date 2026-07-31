import type { RepairJob } from "./contracts.js";
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
    if (current.status !== "full_gate_pending" || current.swap) {
      throw failure("repair_swap_state", "Repair build is not ready for launch");
    }
    try {
      const checkpoint = await this.dependencies.processes.checkpoint();
      current = {
        ...current,
        checkpoint,
        swap: { state: "checkpointed", buildPath },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(current);
      await this.emit(current.playtestId, "repair.checkpoint.created", { repairId, ...checkpoint });
      current = { ...current, swap: { state: "stopping", buildPath }, updatedAt: new Date().toISOString() };
      await this.store.saveRepair(current);
      await this.dependencies.processes.stopTransport();
      await this.emit(current.playtestId, "repair.transport.stopped", { repairId });
      await this.dependencies.processes.releaseAudio();
      await this.emit(current.playtestId, "repair.audio.released", { repairId });
      await this.dependencies.processes.closeMosh();
      current = {
        ...current,
        swap: { state: "current_app_closed", buildPath },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(current);
      await this.emit(current.playtestId, "repair.app.closed", { repairId });
      await this.dependencies.processes.launchRepairBuild(buildPath);
      current = {
        ...current,
        swap: { state: "repair_running", buildPath },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(current);
      await this.emit(current.playtestId, "repair.build.launched", { repairId, buildPath });
      return current;
    } catch (error) {
      const failed: RepairJob = {
        ...current,
        swap: {
          state: "failed",
          buildPath,
          error: (error as Error).message,
        },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(failed);
      throw error;
    }
  }

  private async rollbackUnlocked(repairId: string, reason: string): Promise<RepairJob> {
    let current = await this.store.loadRepair(repairId);
    if (!current.checkpoint) throw failure("checkpoint_missing", "Repair checkpoint is missing");
    const checkpoint = current.checkpoint;
    if (!current.swap || !["repair_running", "failed"].includes(current.swap.state)) {
      throw failure("repair_swap_state", "Repair build is not in a rollback state");
    }
    current = {
      ...current,
      swap: { ...current.swap, state: "rolling_back" },
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveRepair(current);
    try {
      await this.dependencies.processes.closeRepairBuild();
      await this.emit(current.playtestId, "repair.build.closed", { repairId, reason });
      await this.dependencies.processes.restoreCheckpoint(checkpoint.checkpointPath);
      await this.emit(current.playtestId, "repair.checkpoint.restored", {
        repairId,
        checkpointPath: checkpoint.checkpointPath,
      });
      await this.dependencies.processes.launchPriorApp(checkpoint.priorAppPath);
      await this.emit(current.playtestId, "repair.prior_app.launched", {
        repairId,
        priorAppPath: checkpoint.priorAppPath,
      });
      const rolledBack: RepairJob = {
        ...current,
        status: "failed",
        swap: { ...current.swap, state: "rolled_back" },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(rolledBack);
      return rolledBack;
    } catch (error) {
      const failed: RepairJob = {
        ...current,
        swap: { ...current.swap, state: "failed", error: (error as Error).message },
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveRepair(failed);
      throw error;
    }
  }
}
