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

export class OpenAIAgentsSupervisorAdapter implements SupervisorModelAdapter {
  private readonly runner = new Runner({
    tracingDisabled: false,
    traceIncludeSensitiveData: true,
    workflowName: "mosh-owner-playtest-supervisor",
    traceMetadata: { service: "mosh-agent-host" },
  });
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
const forbiddenKeyPattern = /(?:api.?key|authorization|secret|raw.?audio|audio.?data|project.?file|screenshot.?data|binary)/i;

function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(secretPattern, "[REDACTED]").replace(bearerPattern, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !forbiddenKeyPattern.test(key))
        .map(([key, child]) => [key, scrub(child)]),
    );
  }
  return value;
}

export function supervisorTraceInput(turn: SupervisorTurn): string {
  const capabilityIds = new Set(turn.capabilitySchemas.map((capability) => capability.id));
  const safe = scrub({
    message: turn.message,
    capabilitySchemas: turn.capabilitySchemas,
    stateDigest: turn.stateDigest,
    recentResults: turn.recentResults,
    conversationContext: turn.conversationContext,
  });
  return JSON.stringify({ ...safe as object, allowedCapabilityIds: [...capabilityIds] });
}

export function validateSupervisorPlan(value: unknown, turn: SupervisorTurn): SupervisorPlan {
  const plan = SupervisorPlanSchema.parse(value);
  const allowed = new Set(turn.capabilitySchemas.map((capability) => capability.id));
  if (plan.selectedCapabilityIds.some((id) => !allowed.has(id))) {
    throw new Error("Supervisor selected a capability that was not supplied");
  }
  return plan;
}
