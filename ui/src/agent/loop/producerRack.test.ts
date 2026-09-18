import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../../bridge.mock";
import type { Plugin, Snapshot, Track } from "../../types";
import type { AgentCommandCall } from "../destructiveScreen";
import { producerRackPrompt, useProducerRack, validateProducerRack } from "./producerRack";
import type { ProducerRack } from "./producerRack";

const rack: ProducerRack = { projectId: "project-1", leadTrackId: "lead", roomTrackId: "room", pluginIndex: 3 };
const highpass: Plugin = { index: 3, name: "High-Pass", type: "highpass", enabled: false, external: false, builtin: true, isInstrument: false,
  params: [{ index: 0, name: "Frequency", value: 70 / 21990, display: "80 Hz", min: 10, max: 22000, automated: false }] };
function track(id: string, index: number): Track {
  return { id, index, name: id, type: "audio", clips: [], active: true, automationMode: "read", plugins: id === "lead" ? [structuredClone(highpass)] : [],
    mixerPlugins: [{ index: 2, name: "Volume & Pan Plugin", type: "volume", enabled: true, external: false, isInstrument: false,
      params: [{ index: 0, name: "Volume", value: 0.740818202495575, display: "+0.00 dB", automated: false }] }] };
}
async function fixture(): Promise<Snapshot> {
  const snapshot = await mockSnapshot<Snapshot>();
  return { ...snapshot, tracks: [track("lead", 0), track("room", 1), track("protected", 2)], trackGroups: [] };
}
const volume = (trackId: string, db: number) => ({ command: "set_track_volume", args: { trackId, db } });
const frequency = (hz: number) => ({ command: "set_plugin_param", args: { trackId: "lead", index: 3, paramIndex: 0, value: (hz - 10) / 21990 } });

describe("Producer v0 allowed controls", () => {
  beforeEach(() => { __resetMockForTests(); useProducerRack.getState().setRack(null); });
  it("permits only the selected qualified lead and printed-room settings", async () => {
    const snapshot = await fixture();

    const result = validateProducerRack(snapshot, rack, [volume("lead", 3), frequency(80), volume("room", -6)], "initial");

    expect(result).toBeNull();
    expect(producerRackPrompt(rack, "initial")).toContain("lead");
  });

  it.each([-6, 0, 3])("permits qualified lead level %s", async (db) => {
    expect(validateProducerRack(await fixture(), rack, [volume("lead", db)], "initial")).toBeNull();
  });
  it.each([80, 120])("permits source-backed high-pass setting %s Hz", async (hz) => {
    expect(validateProducerRack(await fixture(), rack, [frequency(hz)], "initial")).toBeNull();
  });
  it.each([
    volume("protected", -6), volume("lead", 6), volume("room", 3), frequency(180),
    { command: "set_plugin_param", args: { trackId: "lead", index: 4, paramIndex: 0, value: 70 / 21990 } },
    { command: "set_plugin_param", args: { trackId: "lead", index: 3, paramIndex: 1, value: 70 / 21990 } },
    { command: "set_track_volume", args: { trackId: "room", db: -6, trackIds: ["protected"] } },
    { command: "bypass_plugin", args: { trackId: "room", index: 3, bypassed: false } },
    { command: "set_track_mute", args: { trackId: "lead", mute: true } },
  ] satisfies AgentCommandCall[])("rejects unqualified command %j", async (command) => {
    expect(validateProducerRack(await fixture(), rack, [command], "initial")).not.toBeNull();
  });

  it("limits the ordinary room revision to its printed-room fader", async () => {
    const snapshot = await fixture();
    expect(validateProducerRack(snapshot, rack, [volume("room", -6)], "room")).toBeNull();
    for (const call of [volume("lead", 3), frequency(80), { command: "bypass_plugin", args: { trackId: "lead", index: 3, bypassed: true } }])
      expect(validateProducerRack(snapshot, rack, [call], "room")).not.toBeNull();
    const prompt = producerRackPrompt(rack, "room");
    expect(prompt).toContain("only the printed-room fader");
    expect(prompt).not.toContain("set_plugin_param");
  });

  it.each(["write", "touch", "latch"] as const)("refuses %s automation mode", async (mode) => {
    const snapshot = await fixture();
    const lead = snapshot.tracks.find((track) => track.id === "lead");
    if (!lead) throw new TypeError("fixture lead missing");
    lead.automationMode = mode;
    expect(validateProducerRack(snapshot, rack, [], "initial")).toContain("read automation mode");
  });

  it.each(["frequency", "fader"] as const)("refuses automated %s parameters", async (target) => {
    const snapshot = await fixture();
    const lead = snapshot.tracks.find((track) => track.id === "lead");
    const param = target === "frequency" ? lead?.plugins?.[0]?.params[0] : lead?.mixerPlugins?.[0]?.params[0];
    if (!param) throw new TypeError("fixture parameter missing");
    param.automated = true;
    expect(validateProducerRack(snapshot, rack, [], "initial")).toContain("automation");
    param.automated = false;
    param.points = [{ t: 0, v: 0.5 }];
    expect(validateProducerRack(snapshot, rack, [], "initial")).toContain("automation");
  });

  it("refuses group fan-out, including legacy groups with default volume linkage", async () => {
    const snapshot = await fixture();
    snapshot.trackGroups = [{ id: "g", name: "Linked", trackIds: ["lead", "protected"], kind: "mix", enabled: true }];
    expect(validateProducerRack(snapshot, rack, [], "initial")).toContain("linked fader");
    snapshot.trackGroupsSuspended = true;
    expect(validateProducerRack(snapshot, rack, [], "initial")).toBeNull();
    snapshot.trackGroupsSuspended = false;
    const group = snapshot.trackGroups[0];
    if (!group) throw new TypeError("fixture group missing");
    group.mixAttributes = ["main_pan"];
    expect(validateProducerRack(snapshot, rack, [], "initial")).toBeNull();
  });

  it("refuses missing or replaced selected plugin identity and limits", async () => {
    const snapshot = await fixture();
    const plugin = snapshot.tracks.find((track) => track.id === "lead")?.plugins?.[0];
    if (!plugin) throw new TypeError("fixture plugin missing");
    plugin.external = true;
    expect(validateProducerRack(snapshot, rack, [], "initial")).toContain("native high-pass");
    plugin.external = false;
    const param = plugin.params[0];
    if (!param) throw new TypeError("fixture parameter missing");
    param.min = -60;
    expect(validateProducerRack(snapshot, rack, [], "initial")).toContain("physical limits");
    expect(validateProducerRack(snapshot, { ...rack, leadTrackId: "missing" }, [], "initial")).toContain("no longer exists");
  });

  it("requires a qualified frequency before enabling a previously unqualified setting", async () => {
    const snapshot = await fixture();
    const param = snapshot.tracks.find((track) => track.id === "lead")?.plugins?.[0]?.params[0];
    if (!param) throw new TypeError("fixture parameter missing");
    param.value = 170 / 21990;
    param.display = "180 Hz";
    const enable = { command: "bypass_plugin", args: { trackId: "lead", index: 3, bypassed: false } };
    expect(validateProducerRack(snapshot, rack, [enable], "initial")).toContain("before enabling");
    expect(validateProducerRack(snapshot, rack, [enable, frequency(80)], "initial")).toContain("before enabling");
    expect(validateProducerRack(snapshot, rack, [frequency(80), enable], "initial")).toBeNull();
  });

  it("stores explicit project identity without modifying session snapshots", async () => {
    const snapshot = await fixture();
    const before = JSON.stringify(snapshot);
    useProducerRack.getState().setRack(rack);
    expect(useProducerRack.getState().rack).toEqual(rack);
    expect(JSON.stringify(snapshot)).toBe(before);
    useProducerRack.getState().setRack(null);
    expect(useProducerRack.getState().rack).toBeNull();
  });
});
