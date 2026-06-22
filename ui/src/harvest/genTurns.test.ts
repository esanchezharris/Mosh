import { describe, it, expect } from "vitest";
import { generateLog, generateTuples, type CallBrain } from "./genTurns";
import { parseLog } from "./harvester";
import type { Snapshot } from "../types";

// A fake brain: deterministic replies keyed by the user utterance. Some replies
// read the injected system prompt to ground on a REAL id, proving progressive
// state build-up + id-grounding without any network call.
function fakeBrain(map: Record<string, (system: string) => unknown>): CallBrain {
  return async (messages) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const reply = map[user]?.(system) ?? { intent: "HUH" };
    return JSON.stringify(reply);
  };
}

// Pull the first track id out of a compactSnapshot system prompt (lines look like
//   `  "<id>" "<name>" 0dB clips:[...]` — ids are quoted so the model emits strings).
function firstTrackId(system: string): string | null {
  const m = system.match(/^\s{2}"([^"]+)"\s+"/m);
  return m ? m[1] : null;
}

describe("generateLog", () => {
  it("emits a tagged batch (begin/commands/end) per turn that produces valid commands", async () => {
    const brain = fakeBrain({
      "add a drum track": () => ({ intent: "ACK_GOT_IT", commands: [{ command: "create_track", args: { name: "Drums" } }] }),
    });
    const log = await generateLog(["add a drum track"], brain, { turnIdFn: (i) => `t${i}`, tsFn: (i) => 100 + i });
    const lines = parseLog(log);
    expect(lines.map((l) => l.command)).toEqual(["batch_begin", "create_track", "batch_end"]);
    const begin = lines[0];
    expect(begin.args.turn_id).toBe("t0");
    expect(begin.args.utterance).toBe("add a drum track");
    expect(begin.args.source).toBe("brain_chat");
  });

  it("builds session state progressively so a later turn can reference a real created id", async () => {
    let sawId: string | null = null;
    const brain = fakeBrain({
      "add a drum track": () => ({ intent: "ACK_GOT_IT", commands: [{ command: "create_track", args: { name: "Drums" } }] }),
      "rename it to 808s": (system) => {
        const id = firstTrackId(system);
        sawId = id;
        return { intent: "ACK_GOT_IT", commands: [{ command: "rename_track", args: { trackId: id, name: "808s" } }] };
      },
    });
    const { tuples } = await generateTuples(["add a drum track", "rename it to 808s"], brain, { cleanStart: true });
    expect(tuples).toHaveLength(2);
    // clean start → turn 1 begins from an empty project, so the only track turn 2
    // can see is the one turn 1 created (proves created-id referenceability, not a seed).
    expect((tuples[0].snapshotBefore as Snapshot).tracks).toHaveLength(0);
    // turn 2 saw a real id in its system prompt (the track turn 1 created)
    expect(sawId).toBeTruthy();
    const before = tuples[1].snapshotBefore as Snapshot;
    expect(before.tracks.some((t) => t.id === sawId)).toBe(true);
    // and the rename command targeted that real id
    expect(tuples[1].commands[0].command).toBe("rename_track");
    expect(tuples[1].commands[0].args.trackId).toBe(sawId);
    expect(tuples[1].outcome.appliedClean).toBe(true);
    expect(tuples[1].outcome.replayClean).toBe(true);
  });

  it("drops commands that fail validation (mirrors runAgentBatch) — never logged", async () => {
    const brain = fakeBrain({
      "do something weird": () => ({ intent: "ACK_GOT_IT", commands: [{ command: "frobnicate", args: {} }] }),
    });
    const log = await generateLog(["do something weird"], brain);
    expect(parseLog(log)).toHaveLength(0); // no valid command → no batch at all
  });

  it("produces no tuple for a deferral (HUH, no commands)", async () => {
    const brain = fakeBrain({ "what's the weather": () => ({ intent: "HUH", say: "?" }) });
    const { tuples } = await generateTuples(["what's the weather"], brain);
    expect(tuples).toHaveLength(0);
  });

  it("is deterministic: identical replies → identical log text", async () => {
    const brain = fakeBrain({
      "add a drum track": () => ({ intent: "ACK_GOT_IT", commands: [{ command: "create_track", args: { name: "Drums" } }] }),
    });
    const a = await generateLog(["add a drum track"], brain, { turnIdFn: (i) => `t${i}`, tsFn: () => 7 });
    const b = await generateLog(["add a drum track"], brain, { turnIdFn: (i) => `t${i}`, tsFn: () => 7 });
    expect(a).toBe(b);
  });

  it("tags every harvested tuple as imitation data", async () => {
    const brain = fakeBrain({
      "add a drum track": () => ({ intent: "ACK_GOT_IT", commands: [{ command: "create_track", args: { name: "Drums" } }] }),
    });
    const { tuples } = await generateTuples(["add a drum track"], brain);
    expect(tuples[0].kind).toBe("imitation");
    expect(tuples[0].commands[0].agentCallable).toBe(true);
  });
});
