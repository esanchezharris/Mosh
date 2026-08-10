// Unit pins for the live browser's category mapping (browserModel.ts) — the SPEC §4
// contract: Live's categories map onto Mosh's existing data sources.

import { describe, it, expect } from "vitest";
import {
  buildBrowserRows, LIVE_BROWSER_SECTIONS,
  type LiveBrowserSources,
} from "./browserModel";
import type { AvailablePlugin, BuiltinPlugin, DirEntry } from "../types";

const BUILTIN_INST: BuiltinPlugin = { type: "four-osc", name: "4OSC", category: "Synth", isInstrument: true, builtin: true };
const BUILTIN_FX: BuiltinPlugin = { type: "mosh-ott", name: "Mosh OTT", category: "Dynamics", isInstrument: false, builtin: true };
const VST_INST: AvailablePlugin = { id: "vst3:serum", name: "Serum", format: "VST3", manufacturer: "Xfer", isInstrument: true };
const VST_FX: AvailablePlugin = { id: "vst3:ott", name: "OTT", format: "VST3", manufacturer: "Xfer", isInstrument: false };

const SRC: LiveBrowserSources = {
  builtins: [BUILTIN_INST, BUILTIN_FX],
  plugins: [VST_INST, VST_FX],
  kits: [
    { id: "mosh-kit", name: "mosh kit", pads: 8, available: true },
    { id: "ghost-kit", name: "ghost kit", pads: 8, available: false },
  ],
  entries: [
    { name: "kick.wav", path: "/samples/kick.wav", isDir: false, size: 100 } as DirEntry,
    { name: "loops", path: "/samples/loops", isDir: true, size: null } as DirEntry,
  ],
};

describe("LIVE_BROWSER_SECTIONS", () => {
  it("declares the Library categories in SPEC order", () => {
    const lib = LIVE_BROWSER_SECTIONS.find((s) => s.label === "Library");
    expect(lib?.categories.map((c) => c.id)).toEqual(["sounds", "drums", "instruments", "effects", "samples"]);
  });
});

describe("buildBrowserRows", () => {
  it("Sounds = built-in instruments only", () => {
    const rows = buildBrowserRows("sounds", SRC);
    expect(rows.map((r) => r.name)).toEqual(["4OSC"]);
    expect(rows[0]).toMatchObject({ kind: "builtin", payload: "four-osc" });
  });

  it("Instruments / Audio Effects split the scanned catalog on isInstrument", () => {
    expect(buildBrowserRows("instruments", SRC).map((r) => r.name)).toEqual(["Serum"]);
    // Effects = built-in effects AND scanned effects, built-ins first.
    expect(buildBrowserRows("effects", SRC).map((r) => r.name)).toEqual(["Mosh OTT", "OTT"]);
  });

  it("Drums lists available kits; an unavailable kit is not offered", () => {
    const rows = buildBrowserRows("drums", SRC);
    expect(rows.map((r) => r.name)).toEqual(["mosh kit"]);
    expect(rows[0]).toMatchObject({ kind: "kit", payload: "mosh-kit", hint: "8 pads" });
  });

  it("Samples sorts directories before files (navigation first)", () => {
    const rows = buildBrowserRows("samples", SRC);
    expect(rows.map((r) => r.kind)).toEqual(["dir", "sample"]);
    expect(rows[1]).toMatchObject({ name: "kick.wav", payload: "/samples/kick.wav" });
  });

  it("row ids stay unique across sources that share a name", () => {
    const rows = buildBrowserRows("effects", {
      ...SRC,
      builtins: [{ ...BUILTIN_FX, type: "ott", name: "OTT" }],
    });
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("Current Project is an honest empty stub (no per-project sample surface yet)", () => {
    expect(buildBrowserRows("project", SRC)).toEqual([]);
  });
});
