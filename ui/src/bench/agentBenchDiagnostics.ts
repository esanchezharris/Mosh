import { commandCatalogPrompt } from "../agent/commands";
import {
  capabilityCatalogPrompt,
  retrieveCapabilities,
} from "../agent/capability";

export type AgentBenchTurnDiagnostic = {
  readonly retrievedCommandCount: number;
  readonly retrievedCatalogCharacterCount: number;
  readonly fullCatalogCharacterCount: number;
  readonly catalogReductionRatio: number;
  readonly toolSuccessRate: number | null;
  readonly modelLatencyMs: number;
  readonly repairCount: number;
};

export type AgentBenchDiagnosticSummary = {
  readonly turnCount: number;
  readonly meanRetrievedCommandCount: number;
  readonly meanRetrievedCatalogCharacterCount: number;
  readonly fullCatalogCharacterCount: number;
  readonly meanCatalogReductionRatio: number;
  readonly toolSuccessRate: number | null;
  readonly meanModelLatencyMs: number;
  readonly repairFrequency: number;
  readonly totalRepairs: number;
};

export function diagnosticForTurn(
  query: string,
  results: readonly { readonly ok: boolean }[],
  modelLatenciesMs: readonly number[],
): AgentBenchTurnDiagnostic {
  const capabilities = retrieveCapabilities(query);
  const retrievedCatalogCharacterCount = capabilityCatalogPrompt(capabilities).length;
  const fullCatalogCharacterCount = commandCatalogPrompt().length;
  const modelLatencyMs = modelLatenciesMs.reduce((total, value) =>
    total + Math.max(0, Math.trunc(value)), 0);
  return {
    retrievedCommandCount: capabilities.length,
    retrievedCatalogCharacterCount,
    fullCatalogCharacterCount,
    catalogReductionRatio: fullCatalogCharacterCount === 0
      ? 0
      : 1 - retrievedCatalogCharacterCount / fullCatalogCharacterCount,
    toolSuccessRate: results.length === 0
      ? null
      : results.filter((result) => result.ok).length / results.length,
    modelLatencyMs,
    repairCount: Math.max(0, modelLatenciesMs.length - 1),
  };
}

export function summarizeAgentDiagnostics(
  turns: readonly AgentBenchTurnDiagnostic[],
): AgentBenchDiagnosticSummary {
  const denominator = Math.max(1, turns.length);
  const toolRates = turns.flatMap((turn) =>
    turn.toolSuccessRate === null ? [] : [turn.toolSuccessRate]);
  return {
    turnCount: turns.length,
    meanRetrievedCommandCount: turns.reduce((total, turn) =>
      total + turn.retrievedCommandCount, 0) / denominator,
    meanRetrievedCatalogCharacterCount: turns.reduce((total, turn) =>
      total + turn.retrievedCatalogCharacterCount, 0) / denominator,
    fullCatalogCharacterCount: turns[0]?.fullCatalogCharacterCount ?? commandCatalogPrompt().length,
    meanCatalogReductionRatio: turns.reduce((total, turn) =>
      total + turn.catalogReductionRatio, 0) / denominator,
    toolSuccessRate: toolRates.length === 0
      ? null
      : toolRates.reduce((total, value) => total + value, 0) / toolRates.length,
    meanModelLatencyMs: turns.reduce((total, turn) =>
      total + turn.modelLatencyMs, 0) / denominator,
    repairFrequency: turns.filter((turn) => turn.repairCount > 0).length / denominator,
    totalRepairs: turns.reduce((total, turn) => total + turn.repairCount, 0),
  };
}
