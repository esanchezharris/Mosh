// Unit pins for the live track-header I/O helpers (TrackIoSection). The underlying
// option builders are covered in settings/routing.test.ts — these pin the
// live-shell composition on top: MIDI inputs join the list only for instrument
// tracks, "None" leads exactly once, and the closed-popup label falls back sanely.

import { describe, expect, it } from "vitest";
import type { MidiInput, WaveInput } from "../types";
import { inputDisplayLabel, inputOptionsFor, optionLabel, PAN_DEFAULT, VOLUME_DEFAULT_DB } from "./trackIo";

const WAVE: WaveInput[] = [
  { deviceID: "in-1-2", name: "Input 1-2", enabled: true, isStereoPair: true },
  { deviceID: "in-5", name: "Input 5", enabled: false, isStereoPair: false },
];
const MIDI: MidiInput[] = [
  { deviceID: "midi-kbd", name: "Mosh Keyboard", alias: "Mosh Keyboard", enabled: true, monitor: "automatic" },
  { deviceID: "midi-dead", name: "Launchkey", alias: "Launchkey", enabled: false, monitor: "off" },
];

describe("inputOptionsFor", () => {
  it("audio track: wave inputs only, 'None' leads", () => {
    const opts = inputOptionsFor(WAVE, MIDI, false);
    expect(opts.map((o) => o.value)).toEqual(["", "in-1-2", "in-5"]);
    expect(opts[0].label).toBe("None");
    expect(opts[2].label).toBe("Input 5 (disabled)");
  });

  it("instrument track: MIDI inputs appended after wave, still one 'None'", () => {
    const opts = inputOptionsFor(WAVE, MIDI, true);
    expect(opts.map((o) => o.value)).toEqual(["", "in-1-2", "in-5", "midi-kbd", "midi-dead"]);
    expect(opts.filter((o) => o.value === "")).toHaveLength(1);
  });

  it("null catalogs collapse to just 'None' (headless boot before the lazy load)", () => {
    expect(inputOptionsFor(null, null, false)).toEqual([{ value: "", label: "None" }]);
    expect(inputOptionsFor(null, null, true)).toEqual([{ value: "", label: "None" }]);
  });
});

describe("optionLabel", () => {
  const opts = [{ value: "in-1-2", label: "Input 1-2" }];
  it("empty value shows the empty label (Live's 'No Input')", () => {
    expect(optionLabel(opts, "", "No Input")).toBe("No Input");
  });
  it("a known value shows its option label", () => {
    expect(optionLabel(opts, "in-1-2", "No Input")).toBe("Input 1-2");
  });
  it("a value missing from the catalog shows the raw id (never blank)", () => {
    expect(optionLabel(opts, "in-9-10", "No Input")).toBe("in-9-10");
  });
});

describe("inputDisplayLabel", () => {
  const opts = [{ value: "wavein_abc", label: "Input 1" }];
  it("stored ID resolves through the catalog when it's there", () => {
    expect(inputDisplayLabel({ input: { deviceID: "wavein_abc", name: "Stale Name" } }, opts)).toBe("Input 1");
  });
  it("a restored session falls back to the SNAPSHOT's resolved name while the catalog is unloaded", () => {
    // the restore bug: catalog still empty (lazy load), snapshot carries the name
    expect(inputDisplayLabel({ input: { deviceID: "wavein_abc", name: "Input 1" } }, [])).toBe("Input 1");
  });
  it("a genuinely-gone device shows the raw ID", () => {
    expect(inputDisplayLabel({ input: { deviceID: "wavein_gone" } }, opts)).toBe("wavein_gone");
  });
  it("no input shows No Input", () => {
    expect(inputDisplayLabel({}, opts)).toBe("No Input");
  });
});

describe("slider reset defaults", () => {
  it("volume resets to unity, pan to centre", () => {
    expect(VOLUME_DEFAULT_DB).toBe(0);
    expect(PAN_DEFAULT).toBe(0);
  });
});
