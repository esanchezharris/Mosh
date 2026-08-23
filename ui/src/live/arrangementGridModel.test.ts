import { describe, expect, it } from "vitest";
import {
  barPosToSec,
  gridLines,
  tempoMapFrom,
  type SnapDiv,
} from "../time";
import {
  ARRANGEMENT_GRID_MAX_LINES,
  arrangementGridLines,
} from "./arrangementGridModel";

const secondsOf = (lines: ReturnType<typeof arrangementGridLines>, kind: "bar" | "beat" | "subdivision") =>
  lines.filter((line) => line.kind === kind).map((line) => line.sec);

describe("arrangementGridLines", () => {
  it("maps fractional BPM subdivisions without rounding shared-helper times", () => {
    // Given a non-integer tempo where a rounded CSS repeat would drift.
    const tempo = 123.456;
    const map = tempoMapFrom({ tempo, timeSigNumerator: 4, timeSigDenominator: 4 });
    const quarter = 60 / tempo;

    // When an eighth-note grid is requested for one bar.
    const lines = arrangementGridLines(map, 0, quarter * 4, "1/8", false);

    // Then musical boundaries retain their exact mapped seconds and hierarchy.
    expect(secondsOf(lines, "bar")).toEqual([0, quarter * 4]);
    expect(secondsOf(lines, "beat")).toEqual([quarter, quarter * 2, quarter * 3]);
    expect(secondsOf(lines, "subdivision")).toEqual([
      quarter / 2,
      quarter * 1.5,
      quarter * 2.5,
      quarter * 3.5,
    ]);
  });

  it.each([
    [3, 4, 1.5, 2],
    [4, 4, 2, 3],
    [5, 4, 2.5, 4],
  ] as const)("classifies one %i/%i bar with bar precedence", (num, den, barSec, interiorBeats) => {
    // Given a constant 120 BPM meter, When one complete bar is mapped.
    const map = tempoMapFrom({ tempo: 120, timeSigNumerator: num, timeSigDenominator: den });
    const lines = arrangementGridLines(map, 0, barSec, "1/4", false);

    // Then bar endpoints replace coincident beat/subdivision lines.
    expect(secondsOf(lines, "bar")).toEqual([0, barSec]);
    expect(secondsOf(lines, "beat")).toHaveLength(interiorBeats);
    expect(secondsOf(lines, "subdivision")).toEqual([]);
  });

  it("uses exact helper boundaries through tempo and meter changes", () => {
    // Given explicit changes that restart the shared continuous bar map.
    const map = tempoMapFrom({
      tempo: 120,
      timeSigNumerator: 4,
      timeSigDenominator: 4,
      tempoMap: [{ time: 0, bpm: 120 }, { time: 4, bpm: 90.5 }],
      timeSigMap: [{ time: 0, numerator: 4, denominator: 4 }, { time: 8, numerator: 5, denominator: 4 }],
    });
    const expected = gridLines(map, 0, 12, ARRANGEMENT_GRID_MAX_LINES);

    // When the arrangement model maps the same range.
    const lines = arrangementGridLines(map, 0, 12, "1/8", false);

    // Then its bar and beat seconds are byte-identical to the shared ruler helper.
    expect(secondsOf(lines, "bar")).toEqual(expected.bars.map((bar) => bar.sec));
    expect(secondsOf(lines, "beat")).toEqual(expected.beats);
    for (const bar of expected.bars) {
      expect(lines.find((line) => line.sec === bar.sec)?.kind).toBe("bar");
    }
  });

  it.each([
    ["bar", 0],
    ["1/4", 0],
    ["1/8", 4],
    ["1/16", 12],
    ["1/32", 28],
  ] satisfies readonly (readonly [SnapDiv, number])[])(
    "renders fixed or adaptive-derived %s divisions",
    (division, subdivisions) => {
      // Given one 4/4 bar, When the already-resolved division is mapped.
      const map = tempoMapFrom({ tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 });
      const lines = arrangementGridLines(map, 0, 2, division, false);

      // Then only the selected subdivision density changes; bars and beats remain.
      expect(secondsOf(lines, "bar")).toEqual([0, 2]);
      expect(secondsOf(lines, "beat")).toEqual([0.5, 1, 1.5]);
      expect(secondsOf(lines, "subdivision")).toHaveLength(subdivisions);
    },
  );

  it("changes subdivision sequence for triplets while preserving beat precedence", () => {
    // Given a straight and triplet quarter grid over one 4/4 bar.
    const map = tempoMapFrom({ tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 });

    // When triplet mode is enabled.
    const straight = arrangementGridLines(map, 0, 2, "1/4", false);
    const triplet = arrangementGridLines(map, 0, 2, "1/4", true);

    // Then new thirds appear, while coincident quarters remain beats rather than duplicates.
    expect(secondsOf(straight, "subdivision")).toEqual([]);
    const expectedTriplets = [
      1 / 3,
      2 / 3,
      4 / 3,
      5 / 3,
    ];
    expect(secondsOf(triplet, "subdivision")).toHaveLength(expectedTriplets.length);
    secondsOf(triplet, "subdivision").forEach((sec, index) => {
      expect(Math.abs(sec - (expectedTriplets[index] ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
    });
    expect(triplet.filter((line) => Math.abs(line.sec - 1) < 1e-9)).toEqual([{ sec: 1, kind: "beat" }]);
  });

  it("normalizes range edges and returns sorted finite deduplicated lines", () => {
    // Given a range that begins and ends exactly on authoritative boundaries.
    const map = tempoMapFrom({ tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 });

    // When negative, reversed, and non-finite ranges are requested.
    const clipped = arrangementGridLines(map, -2, 0.5, "1/16", false);

    // Then only the inclusive non-negative range is emitted and invalid ranges are empty.
    expect(clipped[0]).toEqual({ sec: 0, kind: "bar" });
    expect(clipped.at(-1)).toEqual({ sec: 0.5, kind: "beat" });
    expect(clipped.every((line, index) => Number.isFinite(line.sec) && (index === 0 || line.sec > (clipped[index - 1]?.sec ?? Number.POSITIVE_INFINITY)))).toBe(true);
    expect(arrangementGridLines(map, 2, 1, "1/8", false)).toEqual([]);
    expect(arrangementGridLines(map, 0, Number.POSITIVE_INFINITY, "1/8", false)).toEqual([]);
  });

  it("caps pathological subdivision density deterministically without dropping bar or beat priority", () => {
    // Given a visible-sized high-tempo 1/32-triplet range with more than 4096 candidates.
    const map = tempoMapFrom({ tempo: 999, timeSigNumerator: 4, timeSigDenominator: 4 });
    const authoritative = gridLines(map, 0, 30, ARRANGEMENT_GRID_MAX_LINES);

    // When the capped model is evaluated twice.
    const first = arrangementGridLines(map, 0, 30, "1/32", true);
    const second = arrangementGridLines(map, 0, 30, "1/32", true);

    // Then output is bounded and stable, with every authoritative bar/beat retained.
    expect(first.length).toBeLessThanOrEqual(ARRANGEMENT_GRID_MAX_LINES);
    expect(first).toEqual(second);
    expect(secondsOf(first, "bar")).toEqual(authoritative.bars.map((bar) => bar.sec));
    expect(secondsOf(first, "beat")).toEqual(authoritative.beats);
  });

  it("uses shared bar inversion exactly at fractional range boundaries", () => {
    // Given boundaries produced by the shared bar-position inverse.
    const map = tempoMapFrom({ tempo: 137.25, timeSigNumerator: 3, timeSigDenominator: 4 });
    const from = barPosToSec(map, 1 / 3);
    const to = barPosToSec(map, 4 / 3);

    // When the exact helper range is mapped, Then both endpoints survive within 1e-9.
    const lines = arrangementGridLines(map, from, to, "1/4", false);
    expect(Math.abs((lines[0]?.sec ?? Number.NaN) - from)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs((lines.at(-1)?.sec ?? Number.NaN) - to)).toBeLessThanOrEqual(1e-9);
  });
});
