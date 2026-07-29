import { describe, expect, it, vi } from "vitest";
import type { CommandResult, Snapshot } from "../../types";
import {
  deriveLocalAgentJobs,
  runArranger,
  runDrummer,
  runGenerator,
} from "./localAgentJobs";

function snapshotWithClips(): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48_000,
      tempo: 120,
      key: { tonic: "C", mode: "major" },
      editFile: "",
    },
    tracks: [
      {
        id: "drums",
        index: 0,
        name: "Drums",
        type: "drum",
        clips: [{
          id: "beat",
          name: "Beat",
          type: "midi",
          start: 0,
          length: 8,
          offset: 0,
          hasRenderLayer: false,
        }],
      },
      {
        id: "audio",
        index: 1,
        name: "Audio",
        type: "audio",
        clips: [{
          id: "take",
          name: "Take",
          type: "wave",
          start: 0,
          length: 8,
          offset: 0,
          hasRenderLayer: false,
        }],
      },
    ],
    transport: {
      playing: false,
      recording: false,
      position: 0,
      looping: false,
      loopStart: 0,
      loopEnd: 0,
    },
  };
}

function recordingExec() {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const exec = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
    calls.push({ command, args });
    return { ok: true, command };
  });
  return { exec, calls };
}

describe("LocalAgentJobView", () => {
  it("is empty while Mosh is idle", () => {
    expect(deriveLocalAgentJobs(snapshotWithClips(), {}, false)).toEqual([]);
  });

  it("derives only active render jobs and their progress", () => {
    const snapshot = snapshotWithClips();
    snapshot.tracks[0].clips[0].renderLayer = {
      id: "r1",
      status: "rendering",
      adapter: "fake",
      mode: "reimagine",
      seed: 1,
      userKept: false,
      hasArtifact: false,
    };
    snapshot.tracks[1].clips[0].renderLayer = {
      id: "r2",
      status: "queued",
      adapter: "fake",
      mode: "reimagine",
      seed: 2,
      userKept: false,
      hasArtifact: false,
      regionStart: 2,
      regionEnd: 4,
    };

    expect(deriveLocalAgentJobs(snapshot, { beat: 0.62 }, true)).toEqual([
      {
        id: "render:beat",
        worker: "Generator",
        label: "Re-imagining Beat",
        clipId: "beat",
        progress: 0.62,
        status: "running",
      },
      {
        id: "render:take",
        worker: "Arranger",
        label: "Reworking Take",
        clipId: "take",
        progress: 0,
        status: "queued",
      },
    ]);
  });

  it("does not mislabel a whole-clip native render range as Arranger work", () => {
    const snapshot = snapshotWithClips();
    snapshot.tracks[1].clips[0].renderLayer = {
      id: "r1",
      status: "rendering",
      adapter: "fake",
      mode: "reimagine",
      seed: 1,
      userKept: false,
      hasArtifact: false,
      regionStart: 0,
      regionEnd: 8,
    };

    expect(deriveLocalAgentJobs(snapshot, { take: 0.4 }, true)[0]).toMatchObject({
      worker: "Generator",
      label: "Re-imagining Take",
      progress: 0.4,
    });
  });

  it("shows one orchestrator job for a non-render agent batch", () => {
    expect(deriveLocalAgentJobs(snapshotWithClips(), {}, true)).toEqual([
      {
        id: "agent:orchestrator",
        worker: "Mosh",
        label: "Planning the next moves",
        progress: null,
        status: "running",
      },
    ]);
  });
});

describe("Graphite local workers", () => {
  it("Drummer dispatches one add_drum_pattern to the real selected drum clip", async () => {
    const { exec, calls } = recordingExec();
    await runDrummer(exec, snapshotWithClips(), "drums");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "add_drum_pattern",
      args: { clipId: "beat", stepsPerBar: 16, bars: 2 },
    });
  });

  it("Arranger creates, steers, and renders the selected sub-region", async () => {
    const { exec, calls } = recordingExec();
    const result = await runArranger(exec, snapshotWithClips(), "audio", { start: 2, end: 4 });
    expect(result).toBe("started");
    expect(calls.map((call) => call.command)).toEqual([
      "create_render_layer",
      "set_render_param",
      "render_layer",
    ]);
    expect(calls[0].args).toEqual({ clipId: "take", regionStart: 2, regionEnd: 4 });
    expect(calls[2].args).toEqual({ clipId: "take" });
  });

  it("Generator attaches and runs the existing re-imagine flow", async () => {
    const { exec, calls } = recordingExec();
    const result = await runGenerator(exec, snapshotWithClips(), "take", true);
    expect(result).toBe("started");
    expect(calls).toEqual([
      {
        command: "create_render_layer",
        args: {
          clipId: "take",
          adapter: "stable_audio3",
          mode: "reimagine",
          modelVariant: "sa3-medium",
        },
      },
      { command: "render_layer", args: { clipId: "take" } },
    ]);
  });

  it("Arranger stops on a failed layer creation instead of reporting success", async () => {
    const exec = vi.fn(async (command: string): Promise<CommandResult> => ({
      ok: false,
      command,
      error: "layer unavailable",
    }));

    const result = await runArranger(exec, snapshotWithClips(), "audio", { start: 2, end: 4 });

    expect(result).toBe("failed");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("create_render_layer", {
      clipId: "take",
      regionStart: 2,
      regionEnd: 4,
    });
  });

  it("Generator stops on a failed layer creation instead of rendering a missing layer", async () => {
    const exec = vi.fn(async (command: string): Promise<CommandResult> => ({
      ok: false,
      command,
      error: "layer unavailable",
    }));

    const result = await runGenerator(exec, snapshotWithClips(), "take", true);

    expect(result).toBe("failed");
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
