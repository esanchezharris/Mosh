import {
  DIRECT_CONTROL_COMMAND_IDS,
  DIRECT_SAFE_COMMAND_IDS,
  capabilityCatalogPrompt,
  retrieveCapabilities,
  supervisorCapabilitySchemas,
  type Capability,
  type CapabilityRetrievalOptions,
  type SupervisorCapabilitySchema,
} from "./capability";
import { runAgentBatch, type AgentCommandCall, type ChangeSet, type TurnMeta } from "./executor";
import { requestSupervisorTurn, type SupervisorPlan, type SupervisorTurnRequest } from "./agentHost";

const DIRECT_SAFE_IDS = new Set<string>(DIRECT_SAFE_COMMAND_IDS);
const DIRECT_CONTROL_IDS = new Set<string>(DIRECT_CONTROL_COMMAND_IDS);

/** Aggregate-only telemetry: never contains the user's wording, a project value, or audio. */
export type CapabilityTelemetry = {
  readonly retrievedCommandCount: number;
  readonly catalogCharacterCount: number;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly toolSuccess: boolean | null;
  readonly repairCount: number;
};

export type PreparedSupervisorCapabilities = {
  readonly capabilities: readonly Capability[];
  readonly catalog: string;
  readonly capabilitySchemas: readonly SupervisorCapabilitySchema[];
  readonly telemetry: CapabilityTelemetry;
};

/** The Task 1 host receives these schemas only; query text remains at its own typed boundary. */
export function prepareSupervisorCapabilities(
  query: string,
  provider = "openai",
  model = "configured-by-proxy",
  options: CapabilityRetrievalOptions = {},
): PreparedSupervisorCapabilities {
  const capabilities = retrieveCapabilities(query, options);
  const catalog = capabilityCatalogPrompt(capabilities);
  return {
    capabilities,
    catalog,
    capabilitySchemas: supervisorCapabilitySchemas(capabilities),
    telemetry: {
      retrievedCommandCount: capabilities.length,
      catalogCharacterCount: catalog.length,
      provider,
      model,
      latencyMs: 0,
      toolSuccess: null,
      repairCount: 0,
    },
  };
}

export function recordCapabilityToolResult(
  telemetry: CapabilityTelemetry,
  toolSuccess: boolean,
  repairCount: number,
  latencyMs: number,
): CapabilityTelemetry {
  return {
    ...telemetry,
    toolSuccess,
    repairCount: Math.max(0, Math.trunc(repairCount)),
    latencyMs: Math.max(0, Math.trunc(latencyMs)),
  };
}

export type SupervisedTurn = {
  readonly plan: SupervisorPlan;
  readonly calls: readonly AgentCommandCall[];
  readonly telemetry: CapabilityTelemetry;
};

export async function requestCapabilitySupervisor(
  query: string,
  stateDigest: Readonly<Record<string, unknown>>,
  recentResults: SupervisorTurnRequest["recentResults"] = [],
  conversationContext: SupervisorTurnRequest["conversationContext"] = [],
): Promise<SupervisedTurn> {
  const prepared = prepareSupervisorCapabilities(query, "openai", "configured-by-host");
  const startedAt = Date.now();
  const plan = await requestSupervisorTurn({
    message: query,
    capabilitySchemas: prepared.capabilitySchemas,
    stateDigest,
    recentResults,
    conversationContext,
  });
  return {
    plan,
    calls: plan.commands.map((command) => ({ command: command.capabilityId, args: { ...command.arguments } })),
    telemetry: { ...prepared.telemetry, latencyMs: Math.max(0, Date.now() - startedAt), repairCount: 0 },
  };
}

export function emitCapabilityTelemetry(telemetry: CapabilityTelemetry): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("mosh:agent-telemetry", { detail: telemetry }));
}

export class DirectCapabilityRouteError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(`Command ${command} requires supervisor routing`);
    this.name = "DirectCapabilityRouteError";
    this.command = command;
  }
}

export function isDirectSafeCall(call: AgentCommandCall): boolean {
  if (!DIRECT_SAFE_IDS.has(call.command)) return false;
  if (call.command !== "set_transport") return true;
  const action = call.args?.action;
  return action === undefined || action === "play" || action === "toggle" || action === "stop" || action === "to_start" || action === "to_end";
}

export function isDirectControlCall(call: AgentCommandCall): boolean {
  return DIRECT_CONTROL_IDS.has(call.command) && isDirectSafeCall(call);
}

/** Direct tools retain the normal validation, transaction, event, and MoshOps bridge path.
 * This adapter has no native/engine dependency and therefore cannot bypass the executor. */
export async function executeDirectSafeCapabilities(
  label: string,
  calls: readonly AgentCommandCall[],
  meta: TurnMeta = {},
): Promise<ChangeSet> {
  for (const call of calls) if (!isDirectSafeCall(call)) throw new DirectCapabilityRouteError(call.command);
  return runAgentBatch(label, calls, meta);
}
