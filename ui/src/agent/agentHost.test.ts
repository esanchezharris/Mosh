import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostUnavailableError, requestSupervisorTurn } from "./agentHost";

const request = {
  message: "turn on the metronome",
  capabilitySchemas: [{ id: "set_metronome", description: "Toggle click", inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const } }],
  stateDigest: { metronomeEnabled: false },
  recentResults: [],
  conversationContext: [],
};

describe("Agent Host supervisor transport", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("posts bounded schemas to the Task 1 supervisor endpoint", async () => {
    vi.stubEnv("VITE_MOSH_AGENT_HOST_URL", "http://127.0.0.1:8787");
    vi.stubEnv("VITE_MOSH_AGENT_HOST_CAPABILITY", "test-capability");
    vi.stubEnv("VITE_MOSH_AGENT_HOST_PLAYTEST_ID", "11111111-1111-4111-8111-111111111111");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ intent: "ACK_GOT_IT", say: "click on", commands: [{ capabilityId: "set_metronome", arguments: { enabled: true } }], needsClarification: false, selectedCapabilityIds: ["set_metronome"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const plan = await requestSupervisorTurn(request);

    expect(plan.commands[0]).toEqual({ capabilityId: "set_metronome", arguments: { enabled: true } });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/v1/supervisor/turns", expect.objectContaining({ method: "POST" }));
  });

  it("reports unavailable when Task 3 has not supplied launch configuration", async () => {
    await expect(requestSupervisorTurn(request)).rejects.toBeInstanceOf(AgentHostUnavailableError);
  });
});
