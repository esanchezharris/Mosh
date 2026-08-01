import type { PlaytestReport, RepairJob } from "./contracts.js";
import { PlaytestStore } from "./persistence.js";
import { ReportCoordinator } from "./report-coordinator.js";
import { RepairManager } from "./repair-manager.js";
import { RepairSwap } from "./repair-swap.js";
import type {
  Dependencies,
  EventSink,
} from "./orchestration-types.js";

export type {
  AppServerAdapter,
  AppServerEvent,
  Dependencies,
  EvidenceAdapter,
  GitAdapter,
  GitHubAdapter,
  PriorAppHandoffContext,
  ProcessAdapter,
  RepairArtifactPolicy,
  RepairCheckpoint,
  RepairLaunchContext,
  UploadedEvidence,
} from "./orchestration-types.js";

export class OwnerOrchestrator {
  private emitEvent?: EventSink;
  private repairTail: Promise<void> = Promise.resolve();
  private readonly coordinator: ReportCoordinator;
  private readonly repairs: RepairManager;
  private readonly swaps: RepairSwap;

  constructor(
    store: PlaytestStore,
    dependencies: Dependencies,
  ) {
    const emit = (
      playtestId: string,
      type: string,
      data: Record<string, unknown>,
    ) => this.emit(playtestId, type, data);
    this.coordinator = new ReportCoordinator(store, dependencies, emit);
    this.repairs = new RepairManager(store, dependencies, emit);
    this.swaps = new RepairSwap(store, dependencies, emit);
  }

  setEventSink(sink: EventSink): void {
    this.emitEvent = sink;
  }

  private async emit(
    playtestId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (this.emitEvent) await this.emitEvent(playtestId, type, data);
  }

  syncApprovedReport(report: PlaytestReport): Promise<PlaytestReport> {
    return this.coordinator.syncApprovedReport(report);
  }

  coordinateReport(report: PlaytestReport): Promise<void> {
    return this.coordinator.coordinateReport(report);
  }

  createRepair(report: PlaytestReport): Promise<RepairJob> {
    return this.serializeRepairOperation(() => this.repairs.create(report));
  }

  completeRepair(
    repair: RepairJob,
    result: NonNullable<RepairJob["result"]>,
  ): Promise<RepairJob> {
    return this.serializeRepairOperation(() => this.repairs.complete(repair, result));
  }

  launchRepairBuild(repair: RepairJob, buildPath: string): Promise<RepairJob> {
    return this.serializeRepairOperation(() => this.swaps.launch(repair.id, buildPath));
  }

  rollbackRepair(repair: RepairJob, reason: string): Promise<RepairJob> {
    return this.serializeRepairOperation(() => this.swaps.rollback(repair.id, reason));
  }

  private async serializeRepairOperation<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.repairTail;
    let release = (): void => undefined;
    this.repairTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
