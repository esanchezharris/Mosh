import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../bridge.mock";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { runAgentBatch, undoAgentBatch } from "./executor";
import { runSkill, type SkillHarnessDeps } from "./skillHarness";
import {
  ADD_VOCAL_WITH_LYRICS_SKILL,
  ARRANGE_BEAT_SKILL,
  AUTOMATE_PARAMETER_SKILL,
  BUILD_DRUM_PATTERN_SKILL,
  HOST_PLUGIN_SKILL,
  REIMAGINE_CLIP_SKILL,
  SET_TRACK_LEVEL_SKILL,
  WARP_LOOP_TO_GRID_SKILL,
  type SkillDefinition,
  type SkillSlotValues,
} from "./skills";

const mockDeps: SkillHarnessDeps = {
  snapshot: () => mockSnapshot<Snapshot>(),
  runBatch: runAgentBatch,
  rollbackBatch: undoAgentBatch,
};

async function snapshot(): Promise<Snapshot> {
  return mockSnapshot<Snapshot>();
}

function firstTrack(value: Snapshot) {
  const track = value.tracks[0];
  if (!track) throw new Error("fixture has no track");
  return track;
}

function trackById(value: Snapshot, trackId: string) {
  const track = value.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`fixture is missing track ${trackId}`);
  return track;
}

describe("skill harness", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("runs set_track_level end-to-end through the mock-backed MoshOps batch", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const seen: string[] = [];
    const deps: SkillHarnessDeps = {
      ...mockDeps,
      runBatch: async (label, calls) => {
        seen.push(...calls.map((call) => call.command));
        return runAgentBatch(label, calls);
      },
    };

    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -6, mute: true },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual(["set_track_volume", "set_track_mute"]);
    const afterTrack = trackById(await snapshot(), track.id);
    expect(afterTrack.volumeDb).toBe(-6);
    expect(afterTrack.mute).toBe(true);
  });

  it("treats mute:false as present and executes the conditional command", async () => {
    const track = firstTrack(await snapshot());
    await useStore.getState().exec("set_track_mute", { trackId: track.id, mute: true });
    await useStore.getState().refresh();

    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -4.5, mute: false },
      mockDeps,
    );

    expect(result.ok).toBe(true);
    const afterTrack = trackById(await snapshot(), track.id);
    expect(afterTrack.volumeDb).toBe(-4.5);
    expect(afterTrack.mute).toBe(false);
  });

  it("skips the conditional command when mute is omitted and preserves prior mute state", async () => {
    const track = firstTrack(await snapshot());
    await useStore.getState().exec("set_track_mute", { trackId: track.id, mute: true });
    await useStore.getState().refresh();

    const seen: string[] = [];
    const deps: SkillHarnessDeps = {
      ...mockDeps,
      runBatch: async (label, calls) => {
        seen.push(...calls.map((call) => call.command));
        return runAgentBatch(label, calls);
      },
    };
    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: track.id, db: -9 },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual(["set_track_volume"]);
    const afterTrack = trackById(await snapshot(), track.id);
    expect(afterTrack.volumeDb).toBe(-9);
    expect(afterTrack.mute).toBe(true);
  });

  it.each([
    ["missing required slot", { trackId: "11" }],
    ["unknown slot", { trackId: "11", db: -6, surprise: true }],
    ["wrong primitive type", { trackId: "11", db: "-6" }],
    ["non-finite number", { trackId: "11", db: Number.NaN }],
    ["number below range", { trackId: "11", db: -61 }],
    ["number above range", { trackId: "11", db: 6.5 }],
  ])("rejects %s before execution", async (_label, rawSlots) => {
    const before = await snapshot();
    const runBatch = vi.fn();
    const rollbackBatch = vi.fn();

    const result = await runSkill(SET_TRACK_LEVEL_SKILL, rawSlots, {
      snapshot,
      runBatch,
      rollbackBatch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("validation");
    expect(runBatch).not.toHaveBeenCalled();
    expect(rollbackBatch).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a failed precondition before execution", async () => {
    const before = await snapshot();
    const runBatch = vi.fn();
    const rollbackBatch = vi.fn();

    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: "missing-track", db: -6 },
      { snapshot, runBatch, rollbackBatch },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("precondition");
      expect(result.reason).toContain("missing-track");
    }
    expect(runBatch).not.toHaveBeenCalled();
    expect(rollbackBatch).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("preflights expanded MoshOps calls before execution", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const runBatch = vi.fn();
    const invalidTemplate: SkillDefinition = {
      ...SET_TRACK_LEVEL_SKILL,
      name: "invalid_template",
      template: [{ kind: "command", command: "not_a_moshops_command", args: {} }],
    };

    const result = await runSkill(
      invalidTemplate,
      { trackId: track.id, db: -6 },
      { snapshot, runBatch, rollbackBatch: vi.fn() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("template");
      expect(result.reason).toContain("not an allowed command");
    }
    expect(runBatch).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects group tracks before execution", async () => {
    const member = firstTrack(await snapshot());
    await useStore.getState().exec("create_group_track", { trackIds: [member.id] });
    await useStore.getState().refresh();
    const group = (await snapshot()).tracks.find((track) => track.isGroup);
    if (!group) throw new Error("fixture did not create a group track");
    const runBatch = vi.fn();

    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: group.id, db: -6, mute: true },
      { snapshot, runBatch, rollbackBatch: async () => false },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("precondition");
      expect(result.reason).toContain("group");
    }
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("allows a volume-only skill on a group track", async () => {
    const member = firstTrack(await snapshot());
    await useStore.getState().exec("create_group_track", { trackIds: [member.id] });
    await useStore.getState().refresh();
    const group = (await snapshot()).tracks.find((track) => track.isGroup);
    if (!group) throw new Error("fixture did not create a group track");

    const result = await runSkill(
      SET_TRACK_LEVEL_SKILL,
      { trackId: group.id, db: -8 },
      mockDeps,
    );

    expect(result.ok).toBe(true);
    expect(trackById(await snapshot(), group.id).volumeDb).toBe(-8);
  });

  it("accepts a typed slot record without mutating the caller's values", async () => {
    const track = firstTrack(await snapshot());
    const slots: SkillSlotValues = { trackId: track.id, db: -3, mute: false };
    const copy = { ...slots };

    expect((await runSkill(SET_TRACK_LEVEL_SKILL, slots, mockDeps)).ok).toBe(true);
    expect(slots).toEqual(copy);
  });
});

describe("workflow skill catalog", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("runs arrange_beat end-to-end: tempo, time signature, and a starter groove", async () => {
    const before = await snapshot();

    const result = await runSkill(
      ARRANGE_BEAT_SKILL,
      { bpm: 140, numerator: 3, denominator: 4, pattern: "kick: x...x...x...x...", metronome: true },
      mockDeps,
    );

    expect(result.ok).toBe(true);
    const after = await snapshot();
    expect(after.session.tempo).toBe(140);
    expect(after.session.timeSigNumerator).toBe(3);
    expect(after.session.timeSigDenominator).toBe(4);
    expect(after.session.metronome).toBe(true);
    expect(after.tracks.length).toBe(before.tracks.length + 1);
  });

  it("runs build_drum_pattern end-to-end and force-unmutes the target track", async () => {
    const before = await snapshot();
    const track = before.tracks[1];
    if (!track) throw new Error("fixture is missing a second track");
    await useStore.getState().exec("set_track_mute", { trackId: track.id, mute: true });
    await useStore.getState().refresh();

    const seen: string[] = [];
    const deps: SkillHarnessDeps = {
      ...mockDeps,
      runBatch: async (label, calls) => {
        seen.push(...calls.map((call) => call.command));
        return runAgentBatch(label, calls);
      },
    };

    const result = await runSkill(
      BUILD_DRUM_PATTERN_SKILL,
      { trackId: track.id, pattern: "hat: x.x.x.x.x.x.x.x.", unmute: true },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual(["add_drum_pattern", "set_track_mute"]);
    const afterTrack = trackById(await snapshot(), track.id);
    expect(afterTrack.mute).toBe(false);
    expect(
      afterTrack.clips.filter((clip) => clip.type === "midi" && (clip.notes?.length ?? 0) > 0).length,
    ).toBeGreaterThan(0);
  });

  it("rejects build_drum_pattern on a track that holds wave audio", async () => {
    const before = await snapshot();
    const waveTrack = before.tracks.find((track) => track.clips.some((clip) => clip.type === "wave"));
    if (!waveTrack) throw new Error("fixture is missing a wave-audio track");
    const runBatch = vi.fn();

    const result = await runSkill(
      BUILD_DRUM_PATTERN_SKILL,
      { trackId: waveTrack.id, pattern: "kick: x..." },
      { snapshot, runBatch, rollbackBatch: vi.fn() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("precondition");
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("runs add_vocal_with_lyrics end-to-end: sheet + seeded first line", async () => {
    const before = await snapshot();
    const track = before.tracks[2];
    if (!track) throw new Error("fixture is missing a third track");

    const result = await runSkill(
      ADD_VOCAL_WITH_LYRICS_SKILL,
      {
        trackId: track.id,
        seedText: "on my own ___ tonight",
        role: "hook",
        topic: "heartbreak",
        mood: "defiant",
      },
      mockDeps,
    );

    expect(result.ok).toBe(true);
    const afterTrack = trackById(await snapshot(), track.id);
    const sheet = afterTrack.lyricSheet;
    expect(sheet?.topic).toBe("heartbreak");
    expect(sheet?.mood).toBe("defiant");
    const firstLine = sheet?.lines.find((line) => line.index === 0);
    expect(firstLine?.seedText).toBe("on my own ___ tonight");
    expect(firstLine?.role).toBe("hook");
  });

  it("runs reimagine_clip end-to-end: layer, noise, render, accept", async () => {
    const before = await snapshot();
    const track = before.tracks.find((candidate) => candidate.clips.some((clip) => clip.type === "wave"));
    const clip = track?.clips.find((candidate) => candidate.type === "wave");
    if (!track || !clip) throw new Error("fixture is missing a wave clip");

    const result = await runSkill(
      REIMAGINE_CLIP_SKILL,
      { clipId: clip.id, nl: 0.6, prompt: "lo-fi tape", autoAccept: true },
      mockDeps,
    );

    expect(result.ok).toBe(true);
    const afterTrack = trackById(await snapshot(), track.id);
    const afterClip = afterTrack.clips.find((candidate) => candidate.id === clip.id);
    expect(afterClip?.renderLayer?.nl).toBeCloseTo(0.6);
    expect(afterClip?.renderLayer?.prompt).toBe("lo-fi tape");
    expect(afterClip?.renderLayer?.hasArtifact).toBe(true);
    expect(afterClip?.renderLayer?.userKept).toBe(true);
  });

  it("runs host_plugin end-to-end: load, set a param, bypass", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const startIndex = track.plugins?.length ?? 0;

    const result = await runSkill(
      HOST_PLUGIN_SKILL,
      { trackId: track.id, pluginId: "vital", index: startIndex, paramIndex: 0, value: 0.75, bypassed: true },
      mockDeps,
    );

    expect(result.ok).toBe(true);
    const afterTrack = trackById(await snapshot(), track.id);
    const plugin = afterTrack.plugins?.find((candidate) => candidate.index === startIndex);
    expect(plugin?.enabled).toBe(false);
    const param = plugin?.params.find((candidate) => candidate.index === 0);
    expect(param?.value).toBeCloseTo(0.75);
  });

  it("runs warp_loop_to_grid end-to-end: detect + stretch + rename", async () => {
    const before = await snapshot();
    const track = before.tracks.find((candidate) => candidate.clips.some((clip) => clip.type === "wave"));
    const clip = track?.clips.find((candidate) => candidate.type === "wave");
    if (!track || !clip) throw new Error("fixture is missing a wave clip");

    const result = await runSkill(
      WARP_LOOP_TO_GRID_SKILL,
      { clipId: clip.id, bars: 4, rename: "Keys Loop" },
      mockDeps,
    );

    expect(result.ok).toBe(true);
    const afterTrack = trackById(await snapshot(), track.id);
    const afterClip = afterTrack.clips.find((candidate) => candidate.id === clip.id);
    expect(afterClip?.autoTempo).toBe(true);
    expect(afterClip?.sourceBpm).toBeGreaterThan(0);
    expect(afterClip?.name).toBe("Keys Loop");
  });

  it("rejects warp_loop_to_grid on a MIDI clip", async () => {
    const before = await snapshot();
    const track = before.tracks.find((candidate) => candidate.clips.some((clip) => clip.type === "midi"));
    const clip = track?.clips.find((candidate) => candidate.type === "midi");
    if (!clip) throw new Error("fixture is missing a MIDI clip");
    const runBatch = vi.fn();

    const result = await runSkill(
      WARP_LOOP_TO_GRID_SKILL,
      { clipId: clip.id, bars: 4 },
      { snapshot, runBatch, rollbackBatch: vi.fn() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("precondition");
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("runs automate_parameter end-to-end: arm write mode + a param tweak captures a point", async () => {
    const before = await snapshot();
    const track = firstTrack(before);
    const index = track.plugins?.length ?? 0;
    await useStore.getState().exec("load_plugin", { trackId: track.id, pluginId: "vital", index });
    await useStore.getState().refresh();

    const seen: string[] = [];
    const deps: SkillHarnessDeps = {
      ...mockDeps,
      runBatch: async (label, calls) => {
        seen.push(...calls.map((call) => call.command));
        return runAgentBatch(label, calls);
      },
    };

    const result = await runSkill(
      AUTOMATE_PARAMETER_SKILL,
      { trackId: track.id, index, paramIndex: 0, value: 0.65 },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual(["set_track_automation_mode", "set_plugin_param"]);
    const afterTrack = trackById(await snapshot(), track.id);
    expect(afterTrack.automationMode).toBe("write");
    const plugin = afterTrack.plugins?.find((candidate) => candidate.index === index);
    const param = plugin?.params.find((candidate) => candidate.index === 0);
    expect(param?.value).toBeCloseTo(0.65);
    expect(param?.points?.length).toBeGreaterThan(0);
    expect(param?.points?.[param.points.length - 1]?.v).toBeCloseTo(0.65);
  });

  it("rejects automate_parameter when the plugin chain position doesn't exist", async () => {
    const track = firstTrack(await snapshot());
    const runBatch = vi.fn();

    const result = await runSkill(
      AUTOMATE_PARAMETER_SKILL,
      { trackId: track.id, index: 0, paramIndex: 0, value: 0.5 },
      { snapshot, runBatch, rollbackBatch: vi.fn() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("precondition");
    expect(runBatch).not.toHaveBeenCalled();
  });
});
