import { describe, expect, it, vi } from "vitest";

const { requestSupervisorTurnMock } = vi.hoisted(() => ({ requestSupervisorTurnMock: vi.fn() }));
vi.mock("./agentHost", () => ({ requestSupervisorTurn: requestSupervisorTurnMock }));

import { requestCapabilitySupervisor } from "./capabilityRuntime";

describe("production capability supervisor entry point", () => {
  it("sends retrieved schemas to the host and returns only its selected commands", async () => {
    requestSupervisorTurnMock.mockResolvedValue({
      intent: "ACK_GOT_IT",
      say: "click on",
      commands: [{ capabilityId: "set_metronome", arguments: { enabled: true } }],
      needsClarification: false,
      selectedCapabilityIds: ["set_metronome"],
    });

    const turn = await requestCapabilitySupervisor("turn on the metronome", { metronomeEnabled: false });

    expect(requestSupervisorTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      message: "turn on the metronome",
      capabilitySchemas: expect.arrayContaining([expect.objectContaining({ id: "set_metronome" })]),
    }));
    expect(turn.calls).toEqual([{ command: "set_metronome", args: { enabled: true } }]);
    expect(turn.telemetry.retrievedCommandCount).toBe(4);
  });
});
