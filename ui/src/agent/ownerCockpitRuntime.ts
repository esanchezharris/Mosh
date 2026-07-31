import { useSyncExternalStore } from "react";
import { AgentHostApiError, AgentHostClient } from "./agentHostClient";
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
};

type OwnerCockpitClient = Pick<
  AgentHostClient,
  "start" | "close" | "watchEvents" | "realtimeSecret" | "createReport" | "approveReport" | "createRepair"
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
      this.stopEvents = this.client.watchEvents((event) => this.update({ lastEvent: event.type }));
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
    const approved = await this.client.approveReport(reportId);
    this.allReports = this.allReports.map((report) =>
      report.id === reportId ? { ...report, status: approved.status } : report);
    this.update({
      reports: this.allReports.filter((item) => !this.quietReportIds.has(item.id)),
      lastEvent: approved.status === "approved" ? "report.approved" : "report.sync.pending",
    });
  }

  async fixNow(reportId: string): Promise<void> {
    const report = this.allReports.find((candidate) => candidate.id === reportId);
    if (!report || report.status !== "approved")
      throw new AgentHostApiError("Approve and sync the report before repair.", "approval_required", false);
    await this.client.createRepair(reportId);
    this.update({ lastEvent: "repair.running" });
  }

  flushQuietReports(): void {
    this.quietReportIds.clear();
    this.update({ reports: this.allReports, pendingNotes: 0 });
  }

  clearUrgent(): void {
    this.update({ urgentMessage: null });
  }

  private update(patch: Partial<OwnerCockpitState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
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
