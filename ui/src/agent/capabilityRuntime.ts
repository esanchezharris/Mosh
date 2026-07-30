import {
  DIRECT_SAFE_COMMAND_IDS,
  capabilityCatalogPrompt,
  retrieveCapabilities,
  supervisorCapabilitySchemas,
  type Capability,
  type CapabilityRetrievalOptions,
  type SupervisorCapabilitySchema,
} from "./capability";
import { runAgentBatch, type AgentCommandCall, type ChangeSet, type TurnMeta } from "./executor";

const DIRECT_SAFE_IDS = new Set<string>(DIRECT_SAFE_COMMAND_IDS);

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

export class DirectCapabilityRouteError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(`Command ${command} requires supervisor routing`);
    this.name = "DirectCapabilityRouteError";
    this.command = command;
  }
}

/** Direct tools retain the normal validation, transaction, event, and MoshOps bridge path.
 * This adapter has no native/engine dependency and therefore cannot bypass the executor. */
export async function executeDirectSafeCapabilities(
  label: string,
  calls: readonly AgentCommandCall[],
  meta: TurnMeta = {},
): Promise<ChangeSet> {
  for (const call of calls) if (!DIRECT_SAFE_IDS.has(call.command)) throw new DirectCapabilityRouteError(call.command);
  return runAgentBatch(label, calls, meta);
}
