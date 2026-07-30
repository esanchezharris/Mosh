import { Agent, Runner } from "@openai/agents";
import type { Session } from "@openai/agents-core";
import {
  RealtimeClientSecretSchema,
  SupervisorPlanSchema,
  type SupervisorPlan,
  type SupervisorTurn,
} from "./contracts.js";

export interface SupervisorModelAdapter {
  run(input: string, session: Session, traceMetadata: Record<string, string>): Promise<unknown>;
}

export interface RealtimeSecretAdapter {
  mint(): Promise<unknown>;
}

export function createHostedTraceRunner(): Runner {
  return new Runner({
    tracingDisabled: false,
    traceIncludeSensitiveData: false,
    workflowName: "mosh-owner-playtest-supervisor",
    traceMetadata: { service: "mosh-agent-host" },
  });
}

export class OpenAIAgentsSupervisorAdapter implements SupervisorModelAdapter {
  private readonly runner = createHostedTraceRunner();
  private readonly agent: Agent<unknown, typeof SupervisorPlanSchema>;

  constructor(model = process.env.MOSH_AGENT_HOST_MODEL ?? "gpt-5.2") {
    this.agent = new Agent({
      name: "Mosh Owner Playtest Supervisor",
      model,
      instructions: [
        "Return a plan only. Never execute commands or mutate Mosh state.",
        "Use only the supplied capability schemas and include every command capability ID in selectedCapabilityIds.",
        "Ask for clarification when a safe, unambiguous plan cannot be formed.",
      ].join(" "),
      outputType: SupervisorPlanSchema,
    });
  }

  async run(input: string, session: Session, _traceMetadata: Record<string, string>): Promise<unknown> {
    const result = await this.runner.run(this.agent, input, {
      session,
    });
    return result.finalOutput;
  }
}

export class OpenAIRealtimeSecretAdapter implements RealtimeSecretAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly model = "gpt-realtime-2.1",
  ) {}

  async mint(): Promise<unknown> {
    const response = await this.fetchImplementation("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session: { type: "realtime", model: this.model } }),
    });
    if (!response.ok) {
      throw new Error(`Realtime client-secret request failed (${response.status})`);
    }
    const parsed = RealtimeClientSecretSchema.parse(await response.json());
    return { value: parsed.value, expires_at: parsed.expires_at };
  }
}

const secretPattern = /\b(?:sk|ek|sess)-[A-Za-z0-9_-]{8,}\b/g;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._-]+/gi;

function safeText(value: string, maximumLength: number): string {
  return value
    .replace(secretPattern, "[REDACTED]")
    .replace(bearerPattern, "Bearer [REDACTED]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, maximumLength);
}

function safeString(value: unknown, maximumLength = 500): string | undefined {
  return typeof value === "string" ? safeText(value, maximumLength) : undefined;
}

function safeStringArray(value: unknown, maximumItems = 100): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .slice(0, maximumItems)
    .map((item) => safeText(item, 200));
  return strings.length > 0 ? strings : undefined;
}

function presentEntries(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

const schemaScalarKeys = new Set([
  "additionalProperties",
  "const",
  "description",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "pattern",
  "title",
  "type",
  "uniqueItems",
]);

function safeSchemaScalar(key: string, value: unknown): unknown {
  if (typeof value === "boolean" || typeof value === "number" || value === null) return value;
  if (typeof value === "string") return safeText(value, key === "description" ? 500 : 200);
  if (key === "type") return safeStringArray(value, 10);
  return undefined;
}

function safeJsonSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) return {};
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (schemaScalarKeys.has(key)) {
      const scalar = safeSchemaScalar(key, child);
      if (scalar !== undefined) output[key] = scalar;
    } else if (key === "required") {
      const required = safeStringArray(child);
      if (required) output.required = required;
    } else if (key === "enum" && Array.isArray(child)) {
      output.enum = child.slice(0, 100).flatMap((item) => {
        if (typeof item === "string") return [safeText(item, 200)];
        if (typeof item === "number" || typeof item === "boolean" || item === null) return [item];
        return [];
      });
    } else if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      output.properties = Object.fromEntries(
        Object.entries(child as Record<string, unknown>)
          .slice(0, 200)
          .map(([name, property]) => [safeText(name, 100), safeJsonSchema(property, depth + 1)]),
      );
    } else if (key === "items") {
      output.items = safeJsonSchema(child, depth + 1);
    } else if (["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(child)) {
      output[key] = child.slice(0, 20).map((item) => safeJsonSchema(item, depth + 1));
    }
  }
  return output;
}

function safeStateDigest(value: Record<string, unknown>): Record<string, unknown> {
  return presentEntries({
    playing: typeof value.playing === "boolean" ? value.playing : undefined,
    recording: typeof value.recording === "boolean" ? value.recording : undefined,
    metronomeEnabled: typeof value.metronomeEnabled === "boolean" ? value.metronomeEnabled : undefined,
    tempo: typeof value.tempo === "number" && Number.isFinite(value.tempo) ? value.tempo : undefined,
    timelinePosition: typeof value.timelinePosition === "number" && Number.isFinite(value.timelinePosition)
      ? value.timelinePosition
      : undefined,
    loopStart: typeof value.loopStart === "number" && Number.isFinite(value.loopStart) ? value.loopStart : undefined,
    loopEnd: typeof value.loopEnd === "number" && Number.isFinite(value.loopEnd) ? value.loopEnd : undefined,
    timeSignature: safeString(value.timeSignature, 20),
    snapshotDigest: safeString(value.snapshotDigest, 200),
    dirtyDigest: safeString(value.dirtyDigest, 200),
    buildSha: safeString(value.buildSha, 100),
    selectedTrackId: safeString(value.selectedTrackId, 200),
    selectedClipId: safeString(value.selectedClipId, 200),
    selectedTrackIds: safeStringArray(value.selectedTrackIds),
    selectedClipIds: safeStringArray(value.selectedClipIds),
  });
}

function safeResultEnvelope(value: Record<string, unknown>): Record<string, unknown> {
  return presentEntries({
    ok: typeof value.ok === "boolean" ? value.ok : undefined,
    commandId: safeString(value.commandId, 100),
    status: safeString(value.status, 100),
    code: safeString(value.code, 100),
    message: safeString(value.message, 2_000),
    undoable: typeof value.undoable === "boolean" ? value.undoable : undefined,
    transactionId: safeString(value.transactionId, 200),
    eventIds: safeStringArray(value.eventIds),
  });
}

export interface SupervisorTraceDto {
  version: 1;
  message: string;
  capabilities: Array<{
    id: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  state: Record<string, unknown>;
  recentResults: Array<Record<string, unknown>>;
  conversation: Array<{ role: "user" | "assistant"; text: string }>;
  allowedCapabilityIds: string[];
}

export function buildSupervisorTraceDto(turn: SupervisorTurn): SupervisorTraceDto {
  return {
    version: 1,
    message: safeText(turn.message, 20_000),
    capabilities: turn.capabilitySchemas.map((capability) => ({
      id: safeText(capability.id, 100),
      description: safeText(capability.description, 500),
      inputSchema: safeJsonSchema(capability.inputSchema),
    })),
    state: safeStateDigest(turn.stateDigest),
    recentResults: turn.recentResults.map(safeResultEnvelope),
    conversation: turn.conversationContext.map((message) => ({
      role: message.role,
      text: safeText(message.text, 20_000),
    })),
    allowedCapabilityIds: turn.capabilitySchemas.map((capability) => safeText(capability.id, 100)),
  };
}

export function supervisorTraceInput(turn: SupervisorTurn): string {
  return JSON.stringify(buildSupervisorTraceDto(turn));
}

export function validateSupervisorPlan(value: unknown, turn: SupervisorTurn): SupervisorPlan {
  const plan = SupervisorPlanSchema.parse(value);
  const allowed = new Set(turn.capabilitySchemas.map((capability) => capability.id));
  if (plan.selectedCapabilityIds.some((id) => !allowed.has(id))) {
    throw new Error("Supervisor selected a capability that was not supplied");
  }
  return plan;
}
