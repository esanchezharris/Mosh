// G5 — sends / returns / aux buses. Exercises the SAME execute_command seam the v2
// Inspector's Sends section drives (create_bus → add_send → level/mute/pan/pre-fader → remove_send)
// against the in-memory dev backend, plus the agent-catalog exposure of the family.
// Mirrors the native contract (src/moshops/MoshOps.cpp cmdCreateBus/cmdAddSend/…):
//   • snapshot.buses[]      = { bus, name, trackId } — one per AuxReturn-carrying track
//   • track.sends[]         = { bus, db, mute, pan, preFader }
//   • create_bus result     = { busNumber, trackId, name }
import { describe, it, expect, beforeEach } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import { validateCommand, AGENT_COMMAND_MAP } from "./agent/commands";
import type { CommandResult, Snapshot } from "./types";

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

describe("sends / returns / buses — mock backend", () => {
  beforeEach(() => __resetMockForTests());

  it("create_bus adds a return track + a bus entry, defaulting the name", async () => {
    const nTracks = (await snap()).tracks.length;
    const r = await exec("create_bus", {});
    expect(r.ok).toBe(true);
    const d = r.data as { busNumber: number; trackId: string; name: string };
    expect(d.busNumber).toBe(0);
    expect(d.name).toBe("Bus 1"); // native defaults an empty name to "Bus <n+1>"

    const s = await snap();
    expect(s.buses?.length).toBe(1);
    expect(s.buses?.[0]).toMatchObject({ bus: 0, name: "Bus 1", trackId: d.trackId });
    expect(s.tracks.length).toBe(nTracks + 1);
    const rt = s.tracks.find((t) => t.id === d.trackId);
    expect(rt?.isReturn).toBe(true);
    expect(rt?.returnBus).toBe(0);
  });

  it("create_bus honours a given name and allocates the next free bus number", async () => {
    const a = await exec("create_bus", { name: "Reverb" });
    const b = await exec("create_bus", { name: "Delay" });
    expect((a.data as { busNumber: number }).busNumber).toBe(0);
    expect((b.data as { busNumber: number }).busNumber).toBe(1);
    expect((await snap()).buses?.map((x) => x.name)).toEqual(["Reverb", "Delay"]);
  });

  it("add_send routes a track to a bus; duplicates and unknown targets are rejected", async () => {
    await exec("create_bus", { name: "Reverb" }); // bus 0
    const track = (await snap()).tracks[0];

    const r = await exec("add_send", { trackId: track.id, bus: 0, db: -6 });
    expect(r.ok).toBe(true);
    const t = (await snap()).tracks.find((x) => x.id === track.id)!;
    expect(t.sends?.length).toBe(1);
    expect(t.sends?.[0]).toMatchObject({
      bus: 0,
      db: -6,
      mute: false,
      pan: 0,
      preFader: false,
    });

    expect((await exec("add_send", { trackId: track.id, bus: 0 })).ok).toBe(false);  // duplicate
    expect((await exec("add_send", { trackId: track.id, bus: 99 })).ok).toBe(false); // unknown bus
    expect((await exec("add_send", { trackId: "nope", bus: 0 })).ok).toBe(false);    // unknown track
  });

  it("set_send_level changes an existing send's level and rejects a missing send", async () => {
    await exec("create_bus", {});
    const track = (await snap()).tracks[0];
    await exec("add_send", { trackId: track.id, bus: 0, db: 0 });

    expect((await exec("set_send_level", { trackId: track.id, bus: 0, db: -12 })).ok).toBe(true);
    expect((await snap()).tracks.find((x) => x.id === track.id)!.sends?.[0].db).toBe(-12);

    expect((await exec("set_send_level", { trackId: track.id, bus: 5, db: -3 })).ok).toBe(false);
  });

  it("persists independent send mute, pan, and pre-fader state", async () => {
    await exec("create_bus", {});
    const track = (await snap()).tracks[0];
    await exec("add_send", { trackId: track.id, bus: 0, db: -8 });

    expect((await exec("set_send_mute", { trackId: track.id, bus: 0, mute: true })).ok).toBe(true);
    expect((await exec("set_send_pan", { trackId: track.id, bus: 0, pan: 0.75 })).ok).toBe(true);
    expect((await exec("set_send_pre_fader", { trackId: track.id, bus: 0, preFader: true })).ok).toBe(true);

    const send = (await snap()).tracks.find((candidate) => candidate.id === track.id)!.sends?.[0];
    expect(send).toMatchObject({ db: -8, mute: true, pan: 0.75, preFader: true });
    expect((await exec("set_send_pan", { trackId: track.id, bus: 0, pan: -2 })).ok).toBe(true);
    expect((await snap()).tracks.find((candidate) => candidate.id === track.id)!.sends?.[0].pan).toBe(-1);
    expect((await exec("set_send_mute", { trackId: track.id, bus: 9, mute: true })).ok).toBe(false);
  });

  it("remove_send drops the send", async () => {
    await exec("create_bus", {});
    const track = (await snap()).tracks[0];
    await exec("add_send", { trackId: track.id, bus: 0 });
    expect((await exec("remove_send", { trackId: track.id, bus: 0 })).ok).toBe(true);
    expect((await snap()).tracks.find((x) => x.id === track.id)!.sends?.length ?? 0).toBe(0);
  });
});

describe("sends / returns / buses — agent catalog", () => {
  it("exposes the complete send-control command family", () => {
    for (const c of [
      "create_bus", "add_send", "set_send_level", "set_send_mute", "set_send_pan", "set_send_pre_fader",
    ])
      expect(AGENT_COMMAND_MAP.has(c)).toBe(true);
  });

  it("validates their required args", () => {
    expect(validateCommand("create_bus", {})).toBeNull();
    expect(validateCommand("add_send", { trackId: "t", bus: 0 })).toBeNull();
    expect(validateCommand("add_send", { trackId: "t" })).not.toBeNull();          // missing bus
    expect(validateCommand("set_send_level", { trackId: "t", bus: 0, db: -6 })).toBeNull();
    expect(validateCommand("set_send_level", { trackId: "t", bus: 0 })).not.toBeNull(); // missing db
    expect(validateCommand("set_send_mute", { trackId: "t", bus: 0, mute: true })).toBeNull();
    expect(validateCommand("set_send_pan", { trackId: "t", bus: 0, pan: -0.5 })).toBeNull();
    expect(validateCommand("set_send_pre_fader", { trackId: "t", bus: 0, preFader: true })).toBeNull();
  });
});
