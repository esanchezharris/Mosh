import { describe, expect, it } from "vitest";
import type { Snapshot } from "../types";
import {
  adjacentMemoryLocation,
  filterMemoryLocations,
  memoryLocationAtNumber,
  numberedMemoryLocations,
} from "./memoryLocations";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-memory-locations.mosh",
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
  annotations: [
    { id: "outro", text: "Outro", beat: 16, color: "#9868d8" },
    { id: "verse", text: "Verse In", beat: 4, color: "#4a90d9" },
    { id: "hook", text: "Hook", beat: 8, color: "#d9904a" },
  ],
};

describe("Pro Tools Memory Locations", () => {
  it("numbers marker locations in timeline order using the tempo map", () => {
    expect(numberedMemoryLocations(SNAPSHOT).map((location) => ({
      id: location.annotation.id,
      number: location.number,
      seconds: location.seconds,
    }))).toEqual([
      { id: "verse", number: 1, seconds: 2 },
      { id: "hook", number: 2, seconds: 4 },
      { id: "outro", number: 3, seconds: 8 },
    ]);
  });

  it("filters by marker name or displayed number", () => {
    const locations = numberedMemoryLocations(SNAPSHOT);

    expect(filterMemoryLocations(locations, "hook").map((location) => location.number)).toEqual([2]);
    expect(filterMemoryLocations(locations, "3").map((location) => location.annotation.text)).toEqual(["Outro"]);
  });

  it("recalls exact, next, and previous locations without wrapping", () => {
    const locations = numberedMemoryLocations(SNAPSHOT);

    expect(memoryLocationAtNumber(locations, 2)?.annotation.id).toBe("hook");
    expect(adjacentMemoryLocation(locations, 2.1, 1)?.annotation.id).toBe("hook");
    expect(adjacentMemoryLocation(locations, 7, -1)?.annotation.id).toBe("hook");
    expect(adjacentMemoryLocation(locations, 8, 1)).toBeNull();
  });
});
