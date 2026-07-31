import {
  agentHostApproveReport,
  agentHostClosePlaytest,
  agentHostCreateReport,
  agentHostEvents,
  agentHostRealtimeSecret,
  agentHostStartPlaytest,
} from "../bridge";
import type { DraftReportInput } from "./ownerCockpit";

type ErrorEnvelope = {
  readonly ok?: boolean;
  readonly error?: string;
  readonly code?: string;
  readonly retryable?: boolean;
};

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
};

const nativeBridge: AgentHostBridge = {
  start: agentHostStartPlaytest,
  close: agentHostClosePlaytest,
  events: agentHostEvents,
  secret: agentHostRealtimeSecret,
  createReport: agentHostCreateReport,
  approveReport: agentHostApproveReport,
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

function unwrap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object")
    throw new AgentHostApiError("Invalid Agent Host response", "invalid_response");
  const object = value as ErrorEnvelope & Record<string, unknown>;
  if (object.ok === false)
    throw new AgentHostApiError(
      object.error ?? "Agent Host unavailable",
      object.code ?? "host_unavailable",
      object.retryable ?? false,
    );
  return object;
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

  async approveReport(reportId: string): Promise<void> {
    unwrap(await this.bridge.approveReport(reportId));
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
          if (!candidate || typeof candidate !== "object") continue;
          const event = candidate as HostEvent;
          if (!Number.isInteger(event.sequence) || event.sequence <= lastSequence) continue;
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
