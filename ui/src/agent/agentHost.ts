import type { SupervisorCapabilitySchema } from "./capability";
import { agentHostSupervisorTurn } from "../bridge";

export type SupervisorTurnRequest = {
  readonly message: string;
  readonly capabilitySchemas: readonly SupervisorCapabilitySchema[];
  readonly stateDigest: Readonly<Record<string, unknown>>;
  readonly recentResults: readonly Readonly<Record<string, unknown>>[];
  readonly conversationContext: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
};

export type SupervisorPlan = {
  readonly intent: string;
  readonly say: string;
  readonly commands: readonly { readonly capabilityId: string; readonly arguments: Readonly<Record<string, unknown>> }[];
  readonly needsClarification: boolean;
  readonly selectedCapabilityIds: readonly string[];
};

export class AgentHostUnavailableError extends Error {
  constructor(message = "agent host unavailable") {
    super(message);
    this.name = "AgentHostUnavailableError";
  }
}

export const AGENT_HOST_TIMEOUT_MS = 15_000;

function parsePlan(value: unknown, allowedIds: ReadonlySet<string>): SupervisorPlan {
  if (!value || typeof value !== "object") throw new AgentHostUnavailableError("agent host returned an invalid supervisor plan");
  const plan = value as { intent?: unknown; say?: unknown; commands?: unknown; needsClarification?: unknown; selectedCapabilityIds?: unknown };
  if (typeof plan.intent !== "string" || typeof plan.say !== "string" || typeof plan.needsClarification !== "boolean" || !Array.isArray(plan.commands) || !Array.isArray(plan.selectedCapabilityIds))
    throw new AgentHostUnavailableError("agent host returned an invalid supervisor plan");
  const selectedCapabilityIds = plan.selectedCapabilityIds.filter((id): id is string => typeof id === "string");
  if (selectedCapabilityIds.length !== plan.selectedCapabilityIds.length || selectedCapabilityIds.some((id) => !allowedIds.has(id)))
    throw new AgentHostUnavailableError("agent host selected an unavailable capability");
  const commands = plan.commands.map((command) => {
    if (!command || typeof command !== "object") throw new AgentHostUnavailableError("agent host returned an invalid command");
    const value = command as { capabilityId?: unknown; arguments?: unknown };
    if (typeof value.capabilityId !== "string" || !selectedCapabilityIds.includes(value.capabilityId) || !value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments))
      throw new AgentHostUnavailableError("agent host returned an invalid command");
    return { capabilityId: value.capabilityId, arguments: value.arguments as Readonly<Record<string, unknown>> };
  });
  return { intent: plan.intent, say: plan.say, commands, needsClarification: plan.needsClarification, selectedCapabilityIds };
}

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new AgentHostUnavailableError("agent host timed out")), AGENT_HOST_TIMEOUT_MS);
    operation.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (reason: unknown) => { window.clearTimeout(timer); reject(reason); },
    );
  });
}

/** Production transport is native-only. The native layer owns the loopback host,
 * generated bearer capability, and playtest; only a bounded plan returns here. */
export async function requestSupervisorTurn(request: SupervisorTurnRequest): Promise<SupervisorPlan> {
  try {
    const plan = await withTimeout(agentHostSupervisorTurn(request));
    return parsePlan(plan, new Set(request.capabilitySchemas.map((capability) => capability.id)));
  } catch (error) {
    if (error instanceof AgentHostUnavailableError) throw error;
    throw new AgentHostUnavailableError();
  }
}
