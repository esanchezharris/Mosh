import { describe, it, expect } from "vitest";
import {
  SEND_DB_MIN,
  SEND_DB_MAX,
  clampSendDb,
  busesOf,
  returnStripsOf,
  channelTracksOf,
  findSend,
  addBusCommand,
  addSendCommand,
  setSendLevelCommand,
  removeSendCommand,
} from "./mixerSendUtil";
import { validateCommand } from "../agent/commands";
import type { Snapshot, Track, Bus } from "../types";

const track = (over: Partial<Track> = {}): Track =>
  ({ id: "t1", index: 0, name: "Drums", type: "audio", clips: [], ...over });

const snap = (over: Partial<Snapshot> = {}): Snapshot =>
  ({
    tracks: [],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    ...over,
  }) as unknown as Snapshot;

describe("mixerSendUtil — db clamps", () => {
  it("clamps the send level into the backend-honoured range", () => {
    expect(clampSendDb(0)).toBe(0);
    expect(clampSendDb(999)).toBe(SEND_DB_MAX);
    expect(clampSendDb(-999)).toBe(SEND_DB_MIN);
  });
});

describe("mixerSendUtil — snapshot selectors", () => {
  const buses: Bus[] = [{ bus: 0, name: "Reverb", trackId: "r0" }];
  const channel = track({ id: "t1", sends: [{ bus: 0, db: -6, mute: false }] });
  const ret = track({ id: "r0", name: "Reverb", isReturn: true, returnBus: 0 });
  const s = snap({ tracks: [channel, ret], buses });

  it("busesOf returns the snapshot's buses (empty when absent)", () => {
    expect(busesOf(s)).toEqual(buses);
    expect(busesOf(snap())).toEqual([]);
  });
  it("returnStripsOf returns only isReturn tracks", () => {
    expect(returnStripsOf(s).map((t) => t.id)).toEqual(["r0"]);
  });
  it("channelTracksOf excludes return tracks", () => {
    expect(channelTracksOf(s).map((t) => t.id)).toEqual(["t1"]);
  });
  it("findSend locates a track's send to a bus", () => {
    expect(findSend(channel, 0)?.db).toBe(-6);
    expect(findSend(channel, 1)).toBeUndefined();
    expect(findSend(ret, 0)).toBeUndefined();
  });
});

describe("mixerSendUtil — command builders feed the seam", () => {
  it("addBusCommand → create_bus (name optional)", () => {
    expect(addBusCommand()).toEqual({ command: "create_bus", args: {} });
    expect(addBusCommand("Delay")).toEqual({ command: "create_bus", args: { name: "Delay" } });
  });
  it("addSendCommand → add_send with clamped db", () => {
    expect(addSendCommand("t1", 0, -6)).toEqual({ command: "add_send", args: { trackId: "t1", bus: 0, db: -6 } });
    expect(addSendCommand("t1", 0, 999).args.db).toBe(SEND_DB_MAX);
  });
  it("setSendLevelCommand → set_send_level with clamped db (the slider round-trip)", () => {
    expect(setSendLevelCommand("t1", 0, -3)).toEqual({ command: "set_send_level", args: { trackId: "t1", bus: 0, db: -3 } });
    expect(setSendLevelCommand("t1", 0, -999).args.db).toBe(SEND_DB_MIN);
  });
  it("removeSendCommand → remove_send", () => {
    expect(removeSendCommand("t1", 0)).toEqual({ command: "remove_send", args: { trackId: "t1", bus: 0 } });
  });

  // The acceptance round-trip: a slider gesture's command+args MUST be a valid,
  // catalog-allowed call (the same path the seam/agent validate against).
  it("every builder produces a catalog-VALID command (slider→exec round-trip)", () => {
    expect(validateCommand("create_bus", addBusCommand("Reverb").args)).toBeNull();
    expect(validateCommand("add_send", addSendCommand("t1", 0, -6).args)).toBeNull();
    expect(validateCommand("set_send_level", setSendLevelCommand("t1", 0, -3).args)).toBeNull();
    expect(validateCommand("remove_send", removeSendCommand("t1", 0).args)).toBeNull();
  });
});

describe("agent catalog — bus/send commands exposed", () => {
  it("create_bus accepts an optional name", () => {
    expect(validateCommand("create_bus", {})).toBeNull();
    expect(validateCommand("create_bus", { name: "Reverb" })).toBeNull();
    expect(validateCommand("create_bus", { name: 7 })).not.toBeNull();
  });
  it("add_send requires trackId + bus (+ optional db)", () => {
    expect(validateCommand("add_send", { trackId: "t1", bus: 0 })).toBeNull();
    expect(validateCommand("add_send", { trackId: "t1", bus: 0, db: -6 })).toBeNull();
    expect(validateCommand("add_send", { bus: 0 })).not.toBeNull();
    expect(validateCommand("add_send", { trackId: "t1" })).not.toBeNull();
  });
  it("set_send_level requires trackId + bus + db", () => {
    expect(validateCommand("set_send_level", { trackId: "t1", bus: 0, db: -3 })).toBeNull();
    expect(validateCommand("set_send_level", { trackId: "t1", bus: 0 })).not.toBeNull();
  });
  it("remove_send requires trackId + bus", () => {
    expect(validateCommand("remove_send", { trackId: "t1", bus: 0 })).toBeNull();
    expect(validateCommand("remove_send", { trackId: "t1" })).not.toBeNull();
  });
});
