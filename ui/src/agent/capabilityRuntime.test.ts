import { describe, expect, it, vi } from "vitest";

const { runAgentBatchMock } = vi.hoisted(() => ({ runAgentBatchMock: vi.fn() }));
vi.mock("./executor", () => ({ runAgentBatch: runAgentBatchMock }));

import {
  DirectCapabilityRouteError,
  executeDirectSafeCapabilities,
  prepareSupervisorCapabilities,
  recordCapabilityToolResult,
} from "./capabilityRuntime";

describe("capability runtime", () => {
  it("prepares only the retrieved schemas and privacy-safe telemetry fields", () => {
    const prepared = prepareSupervisorCapabilities("turn on the metronome", "openai", "gpt-test");

    expect(prepared.capabilitySchemas.map((schema) => schema.id)).toEqual(prepared.capabilities.map((capability) => capability.id));
    expect(prepared.telemetry).toMatchObject({
      retrievedCommandCount: prepared.capabilities.length,
      catalogCharacterCount: prepared.catalog.length,
      provider: "openai",
      model: "gpt-test",
      toolSuccess: null,
      repairCount: 0,
    });
    expect(JSON.stringify(prepared.telemetry)).not.toContain("metronome");
  });

  it("records execution outcome without retaining request content", () => {
    const prepared = prepareSupervisorCapabilities("turn on the metronome");
    const telemetry = recordCapabilityToolResult(prepared.telemetry, true, 2, 44);

    expect(telemetry).toMatchObject({ toolSuccess: true, repairCount: 2, latencyMs: 44 });
    expect(JSON.stringify(telemetry)).not.toContain("metronome");
  });

  it("routes only direct-safe commands through the existing executor", async () => {
    runAgentBatchMock.mockResolvedValue({ label: "direct", entries: [], applied: 1 });

    await executeDirectSafeCapabilities("direct", [{ command: "set_metronome", args: { enabled: true } }]);

    expect(runAgentBatchMock).toHaveBeenCalledWith("direct", [{ command: "set_metronome", args: { enabled: true } }], {});
  });

  it("refuses an editing command before it can bypass supervisor routing", async () => {
    await expect(executeDirectSafeCapabilities("edit", [{ command: "remove_track", args: { trackId: "7" } }]))
      .rejects.toBeInstanceOf(DirectCapabilityRouteError);
    expect(runAgentBatchMock).not.toHaveBeenCalledWith("edit", expect.anything(), expect.anything());
  });
});
