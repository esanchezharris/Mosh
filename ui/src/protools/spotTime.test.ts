import { describe, expect, it } from "vitest";
import type { Snapshot } from "../types";
import { parseSpotTime } from "./spotTime";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    editFile: "/tmp/protools-spot-time.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

describe("Pro Tools Spot time parsing", () => {
  it.each([
    ["3.1.1", "barsBeats", 4],
    ["00:00:05:15", "timecode", 5.5],
    ["01:02.500", "minutesSeconds", 62.5],
    ["96,000", "samples", 2],
  ] as const)("parses %s in the %s scale", (value, scale, seconds) => {
    // Given: a precise location expressed in one supported Spot Time Scale.
    // When: the dialog parses the user-entered value at the project rate and tempo.
    const result = parseSpotTime(value, scale, SNAPSHOT);

    // Then: the result is a typed non-negative timeline position in seconds.
    expect(result).toEqual({ ok: true, seconds });
  });

  it("rejects a Samples value that cannot become a finite timeline position", () => {
    // Given: a syntactically numeric value beyond JavaScript's finite number range.
    const value = "9".repeat(400);

    // When: the Samples parser converts it at the project sample rate.
    const result = parseSpotTime(value, "samples", SNAPSHOT);

    // Then: the boundary is rejected before it can reach a move command.
    expect(result.ok).toBe(false);
  });
});
