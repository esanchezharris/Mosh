import { useSyncExternalStore } from "react";
import { AgentHostApiError, AgentHostClient, type HostEvent } from "./agentHostClient";
import {
  classifyReportTrigger,
  type DraftReport,
  type DraftReportInput,
} from "./ownerCockpit";

export type OwnerCockpitState = {
  readonly status: "inactive" | "starting" | "active" | "closing" | "outage";
  readonly retainTranscript: boolean;
  readonly disclosure: string | null;
  readonly reports: readonly DraftReport[];
  readonly pendingNotes: number;
  readonly urgentMessage: string | null;
  readonly error: string | null;
  readonly lastEvent: string | null;
  readonly repair: {
    readonly id: string;
    readonly status: "running" | "ready" | "launch_failed" | "repair_running" | "rolled_back" | "failed";
    readonly buildPath?: string;
  } | null;
};

type OwnerCockpitClient = Pick<
  AgentHostClient,
  "start" | "close" | "watchEvents" | "realtimeSecret" | "createReport" | "approveReport"
    | "createRepair" | "launchRepair" | "rollbackRepair"
>;

export class OwnerCockpitRuntime {
  private state: OwnerCockpitState = {
    status: "inactive",
    retainTranscript: false,
    disclosure: null,
    reports: [],
    pendingNotes: 0,
    urgentMessage: null,
    error: null,
    lastEvent: null,
    repair: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly quietReportIds = new Set<string>();
  private allReports: DraftReport[] = [];
  private stopEvents: (() => void) | null = null;

  constructor(readonly client: OwnerCockpitClient = new AgentHostClient()) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): OwnerCockpitState => this.state;

  async start(retainTranscript = this.state.retainTranscript): Promise<void> {
    this.update({ status: "starting", error: null, retainTranscript });
    try {
      const session = await this.client.start(retainTranscript);
      this.update({
        status: "active",
        retainTranscript: session.retainTranscript,
        disclosure: session.disclosureRequired
          ? "Hosted text and tool traces may outlive a locally purged transcript. Audio, screenshots, media, credentials, and project files are excluded."
          : this.state.disclosure,
      });
      this.stopEvents?.();
      this.stopEvents = this.client.watchEvents((event) => this.handleEvent(event));
    } catch (error) {
      this.update({ status: "outage", error: error instanceof Error ? error.message : "Agent Host unavailable" });
      throw error;
    }
  }

  async close(retainTranscript = this.state.retainTranscript): Promise<void> {
    this.update({ status: "closing", retainTranscript });
    try {
      await this.client.close(retainTranscript);
      this.stopEvents?.();
      this.stopEvents = null;
      this.flushQuietReports();
      this.update({ status: "inactive", disclosure: null, urgentMessage: null, lastEvent: "playtest.closed" });
    } catch (error) {
      this.update({ status: "outage", error: error instanceof Error ? error.message : "Agent Host unavailable" });
      throw error;
    }
  }

  setRetainTranscript(retainTranscript: boolean): void {
    this.update({ retainTranscript });
  }

  async createReport(input: DraftReportInput): Promise<DraftReport> {
    if (this.state.status !== "active")
      throw new AgentHostApiError(
        "Start an owner playtest before creating a report.",
        "playtest_not_started",
        false,
      );
    const report = await this.client.createReport(input);
    this.allReports = [...this.allReports, report];
    if (input.kind === "note") {
      this.quietReportIds.add(report.id);
      this.update({
        reports: this.allReports.filter((item) => !this.quietReportIds.has(item.id)),
        pendingNotes: this.quietReportIds.size,
      });
    } else {
      this.update({
        reports: this.allReports,
        urgentMessage: input.kind === "blocker" ? `Blocker captured: ${input.title}` : `Bug captured: ${input.title}`,
      });
    }
    return report;
  }

  async createFromText(text: string): Promise<DraftReport | null> {
    const kind = classifyReportTrigger(text);
    if (!kind) return null;
    const title = text.replace(/^\s*(?:log\s+this|blocker|bug|note)\s*[:—-]?\s*/iu, "").trim().slice(0, 120)
      || `${kind[0]?.toUpperCase()}${kind.slice(1)} report`;
    return this.createReport({ kind, title, body: text });
  }

  async approve(reportId: string): Promise<void> {
    await this.runOwnerAction("Report approval failed.", async () => {
      const approved = await this.client.approveReport(reportId);
      this.allReports = this.allReports.map((report) =>
        report.id === reportId ? { ...report, status: approved.status } : report);
      this.update({
        reports: this.allReports.filter((item) => !this.quietReportIds.has(item.id)),
        lastEvent: approved.status === "approved" ? "report.approved" : "report.sync.pending",
      });
    });
  }

  async fixNow(reportId: string): Promise<void> {
    await this.runOwnerAction("Repair creation failed.", async () => {
      const report = this.allReports.find((candidate) => candidate.id === reportId);
      if (!report || report.status !== "approved")
        throw new AgentHostApiError("Approve and sync the report before repair.", "approval_required", false);
      const repair = await this.client.createRepair(reportId);
      this.update({ lastEvent: "repair.running", repair: { id: repair.id, status: "running" } });
    });
  }

  async launchRepair(): Promise<void> {
    await this.runOwnerAction("Repair launch failed.", async () => {
      const repair = this.state.repair;
      if (!repair?.buildPath || (repair.status !== "ready" && repair.status !== "launch_failed"))
        throw new AgentHostApiError("Repair build is not ready.", "repair_swap_state", false);
      try {
        await this.client.launchRepair(repair.id, repair.buildPath);
      } catch (error) {
        const current = this.state.repair;
        if (current?.id === repair.id
          && (current.status === "ready" || current.status === "launch_failed"))
          this.update({ repair: { ...current, status: "launch_failed" } });
        throw error;
      }
      this.update({ lastEvent: "repair.build.handoff_accepted", repair: { ...repair, status: "repair_running" } });
    });
  }

  async rollbackRepair(reason = "Owner requested rollback after repair retest"): Promise<void> {
    await this.runOwnerAction("Repair rollback failed.", async () => {
      const repair = this.state.repair;
      if (!repair || (repair.status !== "repair_running" && repair.status !== "failed"))
        throw new AgentHostApiError("No repair build is available to roll back.", "repair_swap_state", false);
      await this.client.rollbackRepair(repair.id, reason);
      this.update({ lastEvent: "repair.swap.rolled_back", repair: { ...repair, status: "rolled_back" } });
    });
  }

  resumeInstalledRepair(repairId: string): void {
    if (!repairId || this.state.repair?.id === repairId) return;
    this.update({
      lastEvent: "repair.build.resumed",
      repair: { id: repairId, status: "repair_running" },
    });
  }

  flushQuietReports(): void {
    this.quietReportIds.clear();
    this.update({ reports: this.allReports, pendingNotes: 0 });
  }

  clearUrgent(): void {
    this.update({ urgentMessage: null });
  }

  private async runOwnerAction<T>(fallback: string, action: () => Promise<T>): Promise<T> {
    this.update({ error: null });
    try {
      return await action();
    } catch (error) {
      const surfaced = error instanceof Error ? error : new Error(fallback);
      this.update({ error: surfaced.message });
      throw surfaced;
    }
  }

  private update(patch: Partial<OwnerCockpitState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private handleEvent(event: HostEvent): void {
    if (event.type === "repair.full_gate_pending"
      && typeof event.data.repairId === "string"
      && typeof event.data.buildPath === "string") {
      this.update({
        lastEvent: event.type,
        repair: { id: event.data.repairId, status: "ready", buildPath: event.data.buildPath },
      });
      return;
    }
    if (event.type === "repair.build.handoff_accepted" && this.state.repair)
      this.update({ lastEvent: event.type, repair: { ...this.state.repair, status: "repair_running" } });
    else if (event.type === "repair.swap.rolled_back" && this.state.repair)
      this.update({ lastEvent: event.type, repair: { ...this.state.repair, status: "rolled_back" } });
    else if (event.type === "repair.swap.failed" && this.state.repair) {
      const code = typeof event.data.code === "string" ? ` (${event.data.code})` : "";
      const hasCheckpoint = event.data.hasCheckpoint === true;
      this.update({
        lastEvent: event.type,
        error: `Repair swap failed${code}.`,
        repair: { ...this.state.repair, status: hasCheckpoint ? "failed" : "launch_failed" },
      });
    }
    else
      this.update({ lastEvent: event.type });
  }
}

export const ownerCockpitRuntime = new OwnerCockpitRuntime();

export function useOwnerCockpit(): OwnerCockpitState {
  return useSyncExternalStore(
    ownerCockpitRuntime.subscribe,
    ownerCockpitRuntime.getSnapshot,
    ownerCockpitRuntime.getSnapshot,
  );
}
