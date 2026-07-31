import { afterEach, describe, expect, it, vi } from "vitest";

const { nativeSupervisorTurnMock } = vi.hoisted(() => ({ nativeSupervisorTurnMock: vi.fn() }));
vi.mock("../bridge", () => ({ agentHostSupervisorTurn: nativeSupervisorTurnMock }));

import { AGENT_HOST_TIMEOUT_MS, AgentHostUnavailableError, requestSupervisorTurn } from "./agentHost";

const request = {
  message: "turn on the metronome",
  capabilitySchemas: [{ id: "set_metronome", description: "Toggle click", inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const } }],
  stateDigest: { metronomeEnabled: false },
  recentResults: [],
  conversationContext: [],
};

describe("Agent Host supervisor transport", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); nativeSupervisorTurnMock.mockReset(); });

  it("uses the native bridge and returns its bounded plan", async () => {
    nativeSupervisorTurnMock.mockResolvedValue({ intent: "ACK_GOT_IT", say: "click on", commands: [{ capabilityId: "set_metronome", arguments: { enabled: true } }], needsClarification: false, selectedCapabilityIds: ["set_metronome"] });

    const plan = await requestSupervisorTurn(request);

    expect(plan.commands[0]).toEqual({ capabilityId: "set_metronome", arguments: { enabled: true } });
    expect(nativeSupervisorTurnMock).toHaveBeenCalledWith(request);
  });

  it("normalizes a rejected native call as unavailable", async () => {
    nativeSupervisorTurnMock.mockRejectedValue(new Error("connection refused"));
    await expect(requestSupervisorTurn(request)).rejects.toBeInstanceOf(AgentHostUnavailableError);
  });

  it("normalizes a hung native host as unavailable", async () => {
    vi.useFakeTimers();
    nativeSupervisorTurnMock.mockReturnValue(new Promise(() => {}));
    const result = requestSupervisorTurn(request);
    const unavailable = expect(result).rejects.toBeInstanceOf(AgentHostUnavailableError);
    await vi.advanceTimersByTimeAsync(AGENT_HOST_TIMEOUT_MS);
    await unavailable;
  });

  it("requires no browser bearer configuration", async () => {
    nativeSupervisorTurnMock.mockResolvedValue({ intent: "ACK_GOT_IT", say: "click on", commands: [], needsClarification: false, selectedCapabilityIds: [] });
    await expect(requestSupervisorTurn(request)).resolves.toMatchObject({ intent: "ACK_GOT_IT" });
    expect(nativeSupervisorTurnMock).toHaveBeenCalledWith(request);
  });
});
