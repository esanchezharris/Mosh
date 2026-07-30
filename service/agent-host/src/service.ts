import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  PlaytestReportSchema,
  RealtimeClientSecretSchema,
  SupervisorTurnSchema,
  type AuditEvent,
  type PlaytestReport,
  type PlaytestSession,
  type RepairJob,
  type SupervisorPlan,
} from "./contracts.js";
import {
  supervisorTraceInput,
  validateSupervisorPlan,
  type RealtimeSecretAdapter,
  type SupervisorModelAdapter,
} from "./openai.js";
import { FileAgentSession, PlaytestStore } from "./persistence.js";

export class OpenAIUnavailableError extends Error {
  readonly code = "openai_unavailable";
}

export class AgentHostService {
  readonly events = new EventEmitter();

  constructor(
    readonly store: PlaytestStore,
    private readonly supervisor?: SupervisorModelAdapter,
    private readonly realtime?: RealtimeSecretAdapter,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async createPlaytest(input: { retainTranscript?: boolean | undefined }): Promise<PlaytestSession> {
    const at = new Date().toISOString();
    const session: PlaytestSession = {
      version: 1,
      id: randomUUID(),
      status: "active",
      retainTranscript: input.retainTranscript ?? false,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.saveSession(session);
    await this.emit(session.id, "playtest.created", { retainTranscript: session.retainTranscript });
    return session;
  }

  async closePlaytest(playtestId: string, retainTranscript?: boolean): Promise<PlaytestSession> {
    const current = await this.store.loadSession(playtestId);
    const at = new Date().toISOString();
    const retained = retainTranscript ?? current.retainTranscript;
    const closed: PlaytestSession = {
      ...current,
      status: "closed",
      retainTranscript: retained,
      updatedAt: at,
      closedAt: at,
    };
    await this.store.saveSession(closed);
    if (!retained) await this.store.purgeTranscript(playtestId);
    await this.emit(playtestId, "playtest.closed", { retainTranscript: retained });
    return closed;
  }

  async supervisorTurn(input: unknown): Promise<SupervisorPlan> {
    if (!this.supervisor) {
      throw new OpenAIUnavailableError("OpenAI supervisor is unavailable: OPENAI_API_KEY is not configured");
    }
    const turn = SupervisorTurnSchema.parse(input);
    const playtest = await this.store.loadSession(turn.playtestId);
    if (playtest.status !== "active") throw new Error("Playtest is closed");
    const transcript = await this.store.loadTranscript(turn.playtestId);
    transcript.push({ role: "user", text: turn.message, at: new Date().toISOString() });
    await this.store.saveTranscript(turn.playtestId, transcript);
    const output = await this.supervisor.run(
      supervisorTraceInput(turn),
      new FileAgentSession(this.store, turn.playtestId),
      { playtest_id: turn.playtestId },
    );
    const plan = validateSupervisorPlan(output, turn);
    transcript.push({ role: "assistant", text: plan.say, at: new Date().toISOString() });
    await this.store.saveTranscript(turn.playtestId, transcript);
    await this.emit(turn.playtestId, "supervisor.turn.completed", {
      needsClarification: plan.needsClarification,
      selectedCapabilityIds: plan.selectedCapabilityIds,
      commandCount: plan.commands.length,
    });
    return plan;
  }

  async mintRealtimeSecret(): Promise<unknown> {
    if (!this.realtime) {
      throw new OpenAIUnavailableError("OpenAI Realtime is unavailable: OPENAI_API_KEY is not configured");
    }
    const secret = RealtimeClientSecretSchema.parse(await this.realtime.mint());
    return { value: secret.value, expires_at: secret.expires_at };
  }

  async createReport(input: unknown): Promise<PlaytestReport> {
    const object = input as Record<string, unknown>;
    await this.store.loadSession(String(object.playtestId ?? ""));
    const at = new Date().toISOString();
    const report = PlaytestReportSchema.parse({
      ...object,
      version: 1,
      id: randomUUID(),
      status: "draft",
      evidence: object.evidence ?? [],
      createdAt: at,
      updatedAt: at,
    });
    await this.store.saveReport(report);
    await this.emit(report.playtestId, "report.created", { reportId: report.id, kind: report.kind });
    return report;
  }

  async approveReport(reportId: string): Promise<PlaytestReport> {
    const current = await this.store.loadReport(reportId);
    const at = new Date().toISOString();
    const approved: PlaytestReport = {
      ...current,
      status: "approved",
      updatedAt: at,
      approvedAt: at,
    };
    await this.store.saveReport(approved);
    await this.emit(approved.playtestId, "report.approved", { reportId });
    return approved;
  }

  async createRepair(reportId: string): Promise<RepairJob> {
    const report = await this.store.loadReport(reportId);
    const at = new Date().toISOString();
    const repair: RepairJob = {
      version: 1,
      id: randomUUID(),
      playtestId: report.playtestId,
      reportId,
      status: "queued",
      createdAt: at,
      updatedAt: at,
    };
    await this.store.saveRepair(repair);
    await this.emit(report.playtestId, "repair.queued", { repairId: repair.id, reportId });
    return repair;
  }

  async emit(playtestId: string, type: string, data: Record<string, unknown>): Promise<AuditEvent> {
    const existing = await this.store.loadEvents(playtestId);
    const event: AuditEvent = {
      version: 1,
      id: randomUUID(),
      playtestId,
      sequence: (existing.at(-1)?.sequence ?? 0) + 1,
      type,
      at: new Date().toISOString(),
      data,
    };
    await this.store.appendEvent(event);
    this.events.emit(playtestId, event);
    return event;
  }
}
