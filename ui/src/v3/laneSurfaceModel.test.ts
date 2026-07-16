import { describe, expect, it } from "vitest";
import { classifyLane, drumVoiceForPitch, visibleLaneClips } from "./laneSurfaceModel";
import type { Clip, Track } from "../types";

const clip = (overrides: Partial<Clip>): Clip => ({
  id: "clip", name: "clip", type: "midi", start: 0, length: 8, offset: 0,
  hasRenderLayer: false, notes: [], ...overrides,
});

const track = (type: string, clips: Clip[]): Track => ({
  id: "track", name: "track", type, index: 0, mute: false, solo: false,
  armed: false, monitor: "off", volumeDb: 0, pan: 0, clips,
});

describe("Open Lanes visual surface model", () => {
  it("classifies drum tracks and drum-note MIDI clips as drums", () => {
    expect(classifyLane(track("drum", []))).toBe("drum");
    expect(classifyLane(track("midi", [clip({ notes: [{ i: 0, pitch: 36, start: 0, length: 0.25, velocity: 100 }] })]))).toBe("drum");
  });

  it("classifies pitched note data as MIDI and audio clips as wave", () => {
    expect(classifyLane(track("instrument", [clip({ notes: [{ i: 0, pitch: 64, start: 0, length: 1, velocity: 90 }] })]))).toBe("midi");
    expect(classifyLane(track("audio", [clip({ type: "wave", notes: undefined })]))).toBe("wave");
  });

  it("keeps an empty audio lane wave-like instead of inventing notes", () => {
    expect(classifyLane(track("audio", []))).toBe("wave");
  });

  it("filters hidden and out-of-window clips while retaining partial intersections", () => {
    const clips = [
      clip({ id: "left", start: -2, length: 4 }),
      clip({ id: "inside", start: 4, length: 2 }),
      clip({ id: "right", start: 20, length: 2 }),
      clip({ id: "hidden", start: 2, length: 2, hidden: true }),
    ];
    expect(visibleLaneClips(clips, { startSec: 0, endSec: 8, spanSec: 8 }).map((item) => item.clip.id)).toEqual(["left", "inside"]);
    expect(visibleLaneClips(clips, { startSec: 0, endSec: 8, spanSec: 8 })[0]?.rect).toEqual({ leftFrac: 0, widthFrac: 0.25 });
  });

  it("groups canonical drum pitches into the four winner rows", () => {
    expect(drumVoiceForPitch(36)).toBe("KICK");
    expect(drumVoiceForPitch(38)).toBe("SNARE");
    expect(drumVoiceForPitch(42)).toBe("HI-HAT");
    expect(drumVoiceForPitch(48)).toBe("PERC");
  });
});
