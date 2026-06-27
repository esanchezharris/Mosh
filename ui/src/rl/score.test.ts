import { describe, it, expect } from "vitest";
import { scoreRollout } from "./score";
import type { EvalExample } from "../gepa/evalset";

const tempoTask: EvalExample = {
  id: "t#0",
  utterance: "set the tempo to 120",
  startCommands: [],
  goldCommandNames: ["set_tempo"],
};

describe("scoreRollout (clean-apply reward seam)", () => {
  it("rewards a correct command emission", async () => {
    const reply = JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_tempo", args: { bpm: 120 } }] });
    const r = await scoreRollout(tempoTask, reply);
    expect(r.reward).toBe(1);
    expect(r.deferred).toBe(false);
  });

  it("gives zero reward + deferred=true when the policy acts shy (no commands)", async () => {
    const reply = JSON.stringify({ intent: "ACK_GOT_IT", say: "Sure!", commands: [] });
    const r = await scoreRollout(tempoTask, reply);
    expect(r.reward).toBe(0);
    expect(r.deferred).toBe(true);
  });

  it("penalizes the wrong command (recall miss → reward < 1)", async () => {
    const reply = JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_track_mute", args: { trackId: "nope" } }] });
    const r = await scoreRollout(tempoTask, reply);
    expect(r.reward).toBeLessThan(1);
    expect(r.deferred).toBe(false);
  });
});
