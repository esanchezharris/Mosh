import { describe, expect, it, vi } from "vitest";
import { onLevels } from "./events";
import type { MoshEvent } from "../types";

const levelsEvent = (payload: unknown): MoshEvent =>
  ({ type: "levels", payload }) as unknown as MoshEvent;

describe("onLevels send telemetry", () => {
  it("keeps the existing track/master shape and maps optional send readings separately", () => {
    const set = vi.fn();

    onLevels(levelsEvent({
      tracks: [{ id: "vocal", l: -9, r: -10 }],
      master: { l: -3, r: -4 },
      sends: [{ trackId: "vocal", bus: 2, l: -15, r: -18 }],
    }), set);

    expect(set).toHaveBeenCalledWith({
      levels: {
        tracks: { vocal: { l: -9, r: -10 } },
        master: { l: -3, r: -4 },
      },
      sendLevels: { "5:vocal:2": { l: -15, r: -18 } },
    });
  });

  it("uses the last reading for a duplicate track and bus pair", () => {
    const set = vi.fn();

    onLevels(levelsEvent({
      tracks: [],
      master: { l: -100, r: -100 },
      sends: [
        { trackId: "a:b", bus: 4, l: -30, r: -31 },
        { trackId: "a:b", bus: 4, l: -12, r: -13 },
      ],
    }), set);

    expect(set.mock.calls[0][0].sendLevels).toEqual({
      "3:a:b:4": { l: -12, r: -13 },
    });
  });

  it("clears stale send readings when an older payload omits sends", () => {
    const set = vi.fn();

    onLevels(levelsEvent({ tracks: [] }), set);

    expect(set).toHaveBeenCalledWith({
      levels: { tracks: {}, master: { l: -100, r: -100 } },
      sendLevels: {},
    });
  });
});
