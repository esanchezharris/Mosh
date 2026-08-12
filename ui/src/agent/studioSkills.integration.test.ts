import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests } from "../bridge.mock";
import { useStore } from "../store";
import { runAgentBatch } from "./executor";
import { runStudioSkill } from "./studioSkills";

describe("named plug-in studio skill integration", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("queries, resolves, loads, and reverses the load in one undo step", async () => {
    const track = useStore.getState().snapshot?.tracks.find((candidate) => candidate.type === "audio");
    if (!track) throw new Error("mock session has no audio track");
    useStore.getState().setSelectedTrack(track.id);

    const outcome = await runStudioSkill("load CLA-2A Stereo", {
      context: () => {
        const state = useStore.getState();
        return {
          projectEpoch: state.projectEpoch,
          selectedTrackId: state.selectedTrackId,
          tracks: (state.snapshot?.tracks ?? []).map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
          })),
        };
      },
      exec: (command, args) => useStore.getState().exec(command, args),
      runBatch: (label, calls) => runAgentBatch(label, calls, {
        utterance: "load CLA-2A Stereo",
        source: "studio_skill_test",
      }),
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    if (!outcome.changes) throw new Error("same-project load omitted its undoable change set");
    expect(outcome.changes.entries).toHaveLength(1);
    expect(outcome.changes.entries[0]?.command).toBe("load_plugin");
    expect(outcome.changes.applied).toBe(1);
    expect(useStore.getState().snapshot?.tracks.find((candidate) => candidate.id === track.id)?.plugins)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "CLA-2A Stereo" })]));

    expect((await useStore.getState().exec("undo", {})).ok).toBe(true);
    await useStore.getState().refresh();
    expect(useStore.getState().snapshot?.tracks.find((candidate) => candidate.id === track.id)?.plugins)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "CLA-2A Stereo" })]));
  });
});
