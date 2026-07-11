// G11 — MIDI-input picker surface. The v2 inspector's Mix tab shows a per-instrument-
// track MIDI-input selector. Its options come from the read-only `list_midi_inputs`
// enumeration (CTL-001); choosing one routes it via the existing `set_track_input`
// command (RTG-001 — the "explicitly-chosen input", deviceID-keyed, works for MIDI).
// This covers the four load-bearing seams: the pure option helper, the mock command,
// the store loader, and the routing reflection. The JSX wiring in Inspector.tsx is
// thin glue over these (typecheck + the mock-drift guard keep it honest; e2e renders).

import { describe, it, expect, beforeEach } from "vitest";
import { midiInputOptions, currentTrackInput } from "../../settings/routing";
import { mockExecute, mockSnapshot, __resetMockForTests } from "../../bridge.mock";
import { useStore } from "../../store";
import type { CommandResult, MidiInput, Snapshot, Track } from "../../types";

const track = (over: Partial<Track> = {}): Track =>
  ({ id: "t1", index: 0, name: "Keys", type: "audio", clips: [], isInstrument: true, ...over }) as Track;

const midi = (over: Partial<MidiInput> = {}): MidiInput =>
  ({ deviceID: "midi-akai", name: "Akai MPK Mini", alias: "Akai MPK Mini", enabled: true, monitor: "automatic", ...over });

describe("midiInputOptions — per-track MIDI-input select options", () => {
  it("leads with a None option so a track can clear its MIDI input", () => {
    expect(midiInputOptions(null)).toEqual([{ value: "", label: "None" }]);
    expect(midiInputOptions([])).toEqual([{ value: "", label: "None" }]);
  });

  it("maps enumerated inputs to {value: deviceID, label: name}, flagging disabled ones", () => {
    const opts = midiInputOptions([
      midi(),
      midi({ deviceID: "midi-iac", name: "IAC Bus 1", alias: "IAC Bus 1", enabled: false }),
    ]);
    expect(opts).toEqual([
      { value: "", label: "None" },
      { value: "midi-akai", label: "Akai MPK Mini" },
      { value: "midi-iac", label: "IAC Bus 1 (disabled)" },
    ]);
  });

  it("reflects the track's explicitly-chosen input as the current value (deviceID-keyed)", () => {
    expect(currentTrackInput(track())).toBe("");
    expect(currentTrackInput(track({ input: { deviceID: "midi-akai", name: "Akai MPK Mini" } }))).toBe("midi-akai");
  });
});

describe("list_midi_inputs — mock command (CTL-001)", () => {
  beforeEach(() => __resetMockForTests());

  it("returns a well-formed inputs array + the audioEnabled gate", async () => {
    const res = await mockExecute<CommandResult<{ inputs: MidiInput[]; audioEnabled: boolean }>>({
      command: "list_midi_inputs",
      args: {},
    });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data?.inputs)).toBe(true);
    expect(res.data!.inputs.length).toBeGreaterThan(0);
    expect(res.data).toHaveProperty("audioEnabled");
    for (const mi of res.data!.inputs) {
      expect(typeof mi.deviceID).toBe("string");
      expect(typeof mi.name).toBe("string");
      expect(typeof mi.enabled).toBe("boolean");
    }
  });

  it("is read-only — it does not pollute the command log", async () => {
    await mockExecute({ command: "list_midi_inputs", args: {} });
    const log = await mockExecute<CommandResult<{ entries: { command: string }[] }>>({
      command: "get_command_log",
      args: {},
    });
    expect(log.data!.entries.some((e) => e.command === "list_midi_inputs")).toBe(false);
  });
});

describe("store.loadMidiInputs — lazy enumeration for the picker", () => {
  beforeEach(async () => {
    __resetMockForTests();
    useStore.setState({ midiInputs: null });
    await useStore.getState().refresh();
  });

  it("populates midiInputs from list_midi_inputs", async () => {
    expect(useStore.getState().midiInputs).toBeNull();
    await useStore.getState().loadMidiInputs();
    const inputs = useStore.getState().midiInputs;
    expect(inputs).not.toBeNull();
    expect(inputs!.length).toBeGreaterThan(0);
    expect(inputs![0]).toHaveProperty("deviceID");
  });
});

describe("set_track_input — routes a chosen MIDI input to an instrument track", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("stamps the chosen MIDI deviceID + resolved name on the track (reflected by the picker)", async () => {
    const before = await mockSnapshot<Snapshot>();
    const instrument = before.tracks.find((t) => t.isInstrument);
    expect(instrument).toBeTruthy();

    const list = await mockExecute<CommandResult<{ inputs: MidiInput[] }>>({ command: "list_midi_inputs", args: {} });
    const dev = list.data!.inputs[0];

    const res = await mockExecute<CommandResult>({
      command: "set_track_input",
      args: { trackId: instrument!.id, deviceID: dev.deviceID },
    });
    expect(res.ok).toBe(true);

    const after = await mockSnapshot<Snapshot>();
    const t = after.tracks.find((x) => x.id === instrument!.id)!;
    expect(currentTrackInput(t)).toBe(dev.deviceID);
    expect(t.input?.name).toBe(dev.name);
  });
});
