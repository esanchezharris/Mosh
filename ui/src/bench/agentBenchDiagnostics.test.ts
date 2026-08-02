import { describe, expect, it } from "vitest";
import { commandCatalogPrompt } from "../agent/commands";
import {
  diagnosticForTurn,
  summarizeAgentDiagnostics,
} from "./agentBenchDiagnostics";

describe("unified agent benchmark diagnostics", () => {
  it("records bounded retrieval, catalog reduction, tool outcome, latency, and repair frequency", () => {
    const first = diagnosticForTurn(
      "turn on the metronome",
      [{ ok: true }, { ok: false }],
      [12, 8],
    );
    const second = diagnosticForTurn("should we change anything?", [], [4]);
    const summary = summarizeAgentDiagnostics([first, second]);

    expect(first.retrievedCommandCount).toBeLessThan(20);
    expect(first.fullCatalogCharacterCount).toBe(commandCatalogPrompt().length);
    expect(first.catalogReductionRatio).toBeGreaterThan(0.5);
    expect(first.toolSuccessRate).toBe(0.5);
    expect(first.modelLatencyMs).toBe(20);
    expect(first.repairCount).toBe(1);
    expect(summary).toMatchObject({
      turnCount: 2,
      meanRetrievedCommandCount: expect.any(Number),
      meanCatalogReductionRatio: expect.any(Number),
      toolSuccessRate: 0.5,
      meanModelLatencyMs: 12,
      repairFrequency: 0.5,
    });
  });
});
