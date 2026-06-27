// G8 — pure routing-selector logic for the Mixer "out:" picker. Mirrors the
// set_track_output / list_track_outputs backend contract (SelfTest.cpp Wave S):
// a track routes to default | another track (destTrackId) | a hardware out
// (deviceID); self is never an option.

import { describe, it, expect } from "vitest";
import { routingOptions, routingArgs, currentRoutingValue } from "./routingUtil";
import type { TrackOutputs, Track } from "../types";

const TO: TrackOutputs = {
  outputs: [
    { deviceID: "out-1-2", name: "Main 1/2", enabled: true },
    { deviceID: "out-3-4", name: "Aux 3/4", enabled: true },
  ],
  tracks: [
    { id: "ta", name: "Drums" },
    { id: "tb", name: "Bass" },
    { id: "tc", name: "Keys" },
  ],
  audioEnabled: true,
};

const track = (over: Partial<Track> = {}): Track =>
  ({ id: "ta", name: "Drums", type: "audio", clips: [], ...over }) as Track;

describe("routingOptions", () => {
  it("leads with Default", () => {
    const opts = routingOptions("ta", TO);
    expect(opts[0]).toEqual({ value: "default", label: "Default" });
  });

  it("lists candidate tracks excluding self, then hardware outputs", () => {
    const opts = routingOptions("ta", TO);
    const values = opts.map((o) => o.value);
    expect(values).toEqual([
      "default",
      "track:tb",
      "track:tc",
      "out:out-1-2",
      "out:out-3-4",
    ]);
    // self never appears
    expect(values).not.toContain("track:ta");
  });

  it("labels tracks and outputs by name", () => {
    const opts = routingOptions("ta", TO);
    expect(opts.find((o) => o.value === "track:tb")?.label).toBe("Bass");
    expect(opts.find((o) => o.value === "out:out-3-4")?.label).toBe("Aux 3/4");
  });

  it("is empty-safe when TrackOutputs is null", () => {
    expect(routingOptions("ta", null)).toEqual([]);
  });
});

describe("routingArgs", () => {
  it("default → output:'default'", () => {
    expect(routingArgs("ta", "default")).toEqual({ trackId: "ta", output: "default" });
  });
  it("track:<id> → destTrackId", () => {
    expect(routingArgs("ta", "track:tb")).toEqual({ trackId: "ta", destTrackId: "tb" });
  });
  it("out:<deviceID> → deviceID", () => {
    expect(routingArgs("ta", "out:out-3-4")).toEqual({ trackId: "ta", deviceID: "out-3-4" });
  });
});

describe("currentRoutingValue", () => {
  it("no output → default", () => {
    expect(currentRoutingValue(track())).toBe("default");
  });
  it("track route → track:<destId>", () => {
    expect(
      currentRoutingValue(track({ output: { isTrack: true, destId: "tb", name: "Bass" } })),
    ).toBe("track:tb");
  });
  it("hardware route → out:<deviceID>", () => {
    expect(
      currentRoutingValue(
        track({ output: { isTrack: false, deviceID: "out-3-4", name: "Aux 3/4" } }),
      ),
    ).toBe("out:out-3-4");
  });
});
