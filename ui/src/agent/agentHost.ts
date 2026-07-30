import type { SupervisorCapabilitySchema } from "./capability";

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

type AgentHostConfig = { readonly url: string; readonly capability: string; readonly playtestId: string };

function configuredAgentHost(): AgentHostConfig | null {
  const url = import.meta.env.VITE_MOSH_AGENT_HOST_URL;
  const capability = import.meta.env.VITE_MOSH_AGENT_HOST_CAPABILITY;
  const playtestId = import.meta.env.VITE_MOSH_AGENT_HOST_PLAYTEST_ID;
  return url && capability && playtestId ? { url, capability, playtestId } : null;
}

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

/** Reachable production transport. Task 3 supplies the native launch configuration. */
export async function requestSupervisorTurn(request: SupervisorTurnRequest): Promise<SupervisorPlan> {
  const config = configuredAgentHost();
  if (!config) throw new AgentHostUnavailableError();
  const response = await fetch(`${config.url.replace(/\/$/, "")}/v1/supervisor/turns`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${config.capability}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, playtestId: config.playtestId }),
  });
  let body: unknown;
  try { body = await response.json(); } catch { throw new AgentHostUnavailableError("agent host returned invalid JSON"); }
  if (!response.ok) throw new AgentHostUnavailableError();
  return parsePlan(body, new Set(request.capabilitySchemas.map((capability) => capability.id)));
}
