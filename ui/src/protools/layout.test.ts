import { describe, expect, it } from "vitest";
import {
  formatMinutesSeconds,
  formatSamples,
  formatTimecode,
  linearRulerTicks,
  secondsAtClientX,
  timelineSeconds,
} from "./layout";
import type { Snapshot } from "../types";

describe("Pro Tools ruler geometry", () => {
  it("maps the transformed full-width field back to timeline seconds", () => {
    expect(secondsAtClientX(250, -250, 1_000, 20)).toBe(10);
    expect(secondsAtClientX(-500, 0, 1_000, 20)).toBe(0);
    expect(secondsAtClientX(2_000, 0, 1_000, 20)).toBe(20);
  });

  it("formats each linear timebase without borrowing musical labels", () => {
    expect(formatTimecode(3_661.5)).toBe("01:01:01:15");
    expect(formatMinutesSeconds(61.25)).toBe("01:01.250");
    expect(formatSamples(1.5, 48_000)).toBe("72,000");
  });

  it("keeps generated ruler ticks finite and bounded", () => {
    const ticks = linearRulerTicks(10_000_000, 320, String);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(2_048);
    expect(ticks.every((tick) => Number.isFinite(tick.seconds))).toBe(true);
  });

  it("extends the timeline so late Memory Locations remain reachable", () => {
    const snapshot: Snapshot = {
      schemaVersion: 1,
      session: {
        sampleRate: 48_000,
        tempo: 120,
        editFile: "/tmp/protools-late-marker.mosh",
        key: { tonic: "C", mode: "major" },
      },
      tracks: [],
      transport: {
        playing: false,
        recording: false,
        position: 0,
        looping: false,
        loopStart: 0,
        loopEnd: 0,
      },
      annotations: [{ id: "late", text: "Outro", beat: 80 }],
    };

    expect(timelineSeconds(snapshot)).toBe(44);
  });
});
