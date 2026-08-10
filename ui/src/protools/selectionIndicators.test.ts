import { describe, expect, it } from "vitest";
import type { Snapshot } from "../types";
import {
  formatSelectionDuration,
  parseSelectionDuration,
} from "./selectionIndicators";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    editFile: "/tmp/protools-selection-indicators.mosh",
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
};

describe("Pro Tools Edit Selection indicator time", () => {
  it("formats and parses a Bars+Beats duration from the selection start", () => {
    expect(formatSelectionDuration({
      seconds: 2, start: 4, scale: "barsBeats", snapshot: SNAPSHOT,
    })).toBe("1.0.0");
    expect(parseSelectionDuration({
      value: "1|0|0", start: 4, scale: "barsBeats", snapshot: SNAPSHOT,
    })).toEqual({
      ok: true,
      seconds: 2,
    });
  });

  it("round-trips whole bars through a tempo change", () => {
    const mapped: Snapshot = {
      ...SNAPSHOT,
      session: {
        ...SNAPSHOT.session,
        tempoMap: [{ time: 0, bpm: 120 }, { time: 2, bpm: 60 }],
      },
    };

    expect(formatSelectionDuration({
      seconds: 6, start: 0, scale: "barsBeats", snapshot: mapped,
    })).toBe("2.0.0");
    expect(parseSelectionDuration({
      value: "2.0.0", start: 0, scale: "barsBeats", snapshot: mapped,
    })).toEqual({
      ok: true,
      seconds: 6,
    });
  });

  it.each([
    ["minutesSeconds", "00:01.250", 1.25],
    ["timecode", "00:00:01:15", 1.5],
    ["samples", "72,000", 1.5],
  ] as const)("reuses the %s absolute-time grammar", (scale, value, seconds) => {
    expect(parseSelectionDuration({ value, start: 2, scale, snapshot: SNAPSHOT }))
      .toEqual({ ok: true, seconds });
    expect(formatSelectionDuration({ seconds, start: 2, scale, snapshot: SNAPSHOT })).toBe(value);
  });

  it("rejects zero duration and noncanonical musical fields", () => {
    expect(parseSelectionDuration({
      value: "0.0.0", start: 0, scale: "barsBeats", snapshot: SNAPSHOT,
    })).toEqual({
      ok: false,
      error: "Length must be greater than zero.",
    });
    expect(parseSelectionDuration({
      value: "0.4.0", start: 0, scale: "barsBeats", snapshot: SNAPSHOT,
    })).toEqual({
      ok: false,
      error: "Beats must be between 0 and 3 at the selection start.",
    });
  });
});
