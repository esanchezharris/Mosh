import {
  agentHostApproveReport,
  agentHostClosePlaytest,
  agentHostCreateReport,
  agentHostCreateRepair,
  agentHostEvents,
  agentHostLaunchRepair,
  agentHostRealtimeSecret,
  agentHostRollbackRepair,
  agentHostStartPlaytest,
} from "../bridge";
import type { DraftReportInput } from "./ownerCockpit";

export type HostEvent = {
  readonly sequence: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
};

export type AgentHostBridge = {
  start(retainTranscript: boolean): Promise<unknown>;
  close(retainTranscript: boolean): Promise<unknown>;
  events(afterSequence: number): Promise<unknown>;
  secret(): Promise<unknown>;
  createReport(input: DraftReportInput): Promise<unknown>;
  approveReport(reportId: string): Promise<unknown>;
  createRepair?(reportId: string): Promise<unknown>;
  launchRepair?(repairId: string, buildPath: string): Promise<unknown>;
  rollbackRepair?(repairId: string, reason: string): Promise<unknown>;
};

const nativeBridge: AgentHostBridge = {
  start: agentHostStartPlaytest,
  close: agentHostClosePlaytest,
  events: agentHostEvents,
  secret: agentHostRealtimeSecret,
  createReport: agentHostCreateReport,
  approveReport: agentHostApproveReport,
  createRepair: agentHostCreateRepair,
  launchRepair: agentHostLaunchRepair,
  rollbackRepair: agentHostRollbackRepair,
};

export class AgentHostApiError extends Error {
  constructor(
    message: string,
    readonly code = "host_unavailable",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AgentHostApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(message = "Invalid Agent Host response"): never {
  throw new AgentHostApiError(message, "invalid_response", false);
}

function unwrap(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || (value.ok !== true && value.ok !== false))
    return invalidResponse();
  if (value.ok === false) {
    if ((value.error !== undefined && typeof value.error !== "string")
      || (value.code !== undefined && typeof value.code !== "string")
      || (value.retryable !== undefined && typeof value.retryable !== "boolean"))
      return invalidResponse();
    throw new AgentHostApiError(
      value.error ?? "Agent Host unavailable",
      value.code ?? "host_unavailable",
      value.retryable ?? false,
    );
  }
  return value;
}

function parseHostEvent(value: unknown): HostEvent | null {
  if (!isRecord(value)
    || !Number.isInteger(value.sequence)
    || typeof value.sequence !== "number"
    || value.sequence <= 0
    || typeof value.type !== "string"
    || value.type.length === 0
    || !isRecord(value.data))
    return null;
  return {
    sequence: value.sequence,
    type: value.type,
    data: value.data,
  };
}

export class AgentHostClient {
  constructor(
    private readonly bridge: AgentHostBridge = nativeBridge,
    private readonly reconnectDelayMs = 750,
  ) {}

  async start(retainTranscript: boolean): Promise<{
    active: boolean;
    retainTranscript: boolean;
    disclosureRequired: boolean;
  }> {
    const value = unwrap(await this.bridge.start(retainTranscript));
    return {
      active: value.active === true,
      retainTranscript: value.retainTranscript === true,
      disclosureRequired: value.disclosureRequired === true,
    };
  }

  async close(retainTranscript: boolean): Promise<{
    active: boolean;
    retainTranscript: boolean;
  }> {
    const value = unwrap(await this.bridge.close(retainTranscript));
    return {
      active: value.active === true,
      retainTranscript: value.retainTranscript === true,
    };
  }

  async realtimeSecret(): Promise<string> {
    const value = unwrap(await this.bridge.secret());
    if (typeof value.value !== "string" || !value.value.startsWith("ek_"))
      throw new AgentHostApiError("Invalid Realtime client secret", "invalid_response");
    return value.value;
  }

  async createReport(input: DraftReportInput): Promise<{
    id: string;
    kind: DraftReportInput["kind"];
    title: string;
    body: string;
    status: "draft";
  }> {
    const value = unwrap(await this.bridge.createReport(input));
    if (typeof value.id !== "string")
      throw new AgentHostApiError("Invalid report response", "invalid_response");
    return { id: value.id, ...input, status: "draft" };
  }

  async approveReport(reportId: string): Promise<{
    status: "approved" | "approved_pending_sync";
  }> {
    const value = unwrap(await this.bridge.approveReport(reportId));
    if (value.status !== "approved" && value.status !== "approved_pending_sync")
      throw new AgentHostApiError("Invalid approval response", "invalid_response");
    return { status: value.status };
  }

  async createRepair(reportId: string): Promise<{ id: string; status: "running" }> {
    if (!this.bridge.createRepair)
      throw new AgentHostApiError("Repair orchestration unavailable", "repair_unavailable");
    const value = unwrap(await this.bridge.createRepair(reportId));
    if (typeof value.id !== "string" || value.status !== "running")
      throw new AgentHostApiError("Invalid repair response", "invalid_response");
    return { id: value.id, status: "running" };
  }

  async launchRepair(repairId: string, buildPath: string): Promise<{ id: string; state: "repair_running" }> {
    if (!this.bridge.launchRepair)
      throw new AgentHostApiError("Repair launch unavailable", "repair_unavailable");
    const value = unwrap(await this.bridge.launchRepair(repairId, buildPath));
    if (typeof value.id !== "string" || value.state !== "repair_running")
      throw new AgentHostApiError("Invalid repair launch response", "invalid_response");
    return { id: value.id, state: value.state };
  }

  async rollbackRepair(repairId: string, reason: string): Promise<{ id: string; state: "rolled_back" }> {
    if (!this.bridge.rollbackRepair)
      throw new AgentHostApiError("Repair rollback unavailable", "repair_unavailable");
    const value = unwrap(await this.bridge.rollbackRepair(repairId, reason));
    if (typeof value.id !== "string" || value.state !== "rolled_back")
      throw new AgentHostApiError("Invalid repair rollback response", "invalid_response");
    return { id: value.id, state: value.state };
  }

  watchEvents(onEvent: (event: HostEvent) => void): () => void {
    let stopped = false;
    let lastSequence = 0;
    let timer: number | undefined;
    const poll = async () => {
      if (stopped) return;
      try {
        const value = unwrap(await this.bridge.events(lastSequence));
        const events = Array.isArray(value.events) ? value.events : [];
        for (const candidate of events) {
          const event = parseHostEvent(candidate);
          if (!event || event.sequence <= lastSequence) continue;
          lastSequence = event.sequence;
          onEvent(event);
          if (stopped) return;
        }
      } catch (error) {
        if (!(error instanceof AgentHostApiError) || !error.retryable) {
          stopped = true;
          return;
        }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), this.reconnectDelayMs);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }
}
