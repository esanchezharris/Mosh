import { describe, it, expect, vi } from "vitest";
import {
  builtinEntry, installedEntry, matchEntry, buildPluginRows, visibleRange,
  loadPluginEntry, loadMasterPluginEntry, loadPluginRecents,
  type PluginRow,
} from "./pluginBrowserUtil";
import type { AvailablePlugin, BuiltinPlugin } from "../types";

const bi = (type: string, name: string, category: string, isInstrument = false): BuiltinPlugin =>
  ({ type, name, category, isInstrument, builtin: true });
const vst = (id: string, name: string, manufacturer: string, isInstrument = false): AvailablePlugin =>
  ({ id, name, format: "VST3", manufacturer, isInstrument });

const headers = (rows: PluginRow[]) => rows.filter((r) => r.kind === "header").map((r) => (r as Extract<PluginRow, { kind: "header" }>).label);
const names = (rows: PluginRow[]) => rows.filter((r) => r.kind === "plugin").map((r) => (r as Extract<PluginRow, { kind: "plugin" }>).entry.name);

describe("entry mappers", () => {
  it("builds stable uids and a vendor from category/manufacturer", () => {
    expect(builtinEntry(bi("sampler", "Sampler", "Instrument", true)).uid).toBe("b:sampler");
    expect(installedEntry(vst("abc", "Serum", "Xfer")).uid).toBe("v:abc");
    expect(installedEntry(vst("x", "NoVendor", "")).vendor).toBe("Other");
  });
});

describe("matchEntry", () => {
  const e = installedEntry(vst("1", "Serum", "Xfer Records", true));
  it("filters by kind", () => {
    expect(matchEntry(e, "", "inst")).toBe(true);
    expect(matchEntry(e, "", "fx")).toBe(false);
  });
  it("matches name OR vendor, case-insensitive", () => {
    expect(matchEntry(e, "ser", "all")).toBe(true);
    expect(matchEntry(e, "xfer", "all")).toBe(true);
    expect(matchEntry(e, "zzz", "all")).toBe(false);
    expect(matchEntry(e, "   ", "all")).toBe(true);
  });
});

describe("buildPluginRows", () => {
  const builtins = [builtinEntry(bi("sampler", "Sampler", "Instrument", true)), builtinEntry(bi("comp", "Compressor", "Dynamics"))];
  const installed = [
    installedEntry(vst("s", "Serum", "Xfer", true)),
    installedEntry(vst("o", "OTT", "Xfer")),
    installedEntry(vst("v", "Vital", "Vital Audio", true)),
  ];

  it("sections favorites and recents first, recents excluding favorites", () => {
    const rows = buildPluginRows({ builtins, installed, favorites: ["v:s"], recents: ["v:o", "v:s"], q: "", kind: "all" });
    expect(headers(rows).slice(0, 2)).toEqual(["Favorites", "Recent"]);
    // Serum is a favorite, so it must NOT also appear under Recent.
    const recentIdx = rows.findIndex((r) => r.kind === "header" && r.label === "Recent");
    const recentRow = rows[recentIdx + 1];
    expect(recentRow.kind === "plugin" && recentRow.entry.name).toBe("OTT");
  });

  it("groups installed by vendor (alphabetical, Other last) and sorts within group", () => {
    const rows = buildPluginRows({ builtins: [], installed, favorites: [], recents: [], q: "", kind: "all" });
    // Vital Audio before Xfer; OTT before Serum inside Xfer.
    expect(headers(rows)).toEqual(["Vital Audio", "Xfer"]);
    expect(names(rows)).toEqual(["Vital", "OTT", "Serum"]);
  });

  it("respects the query + kind filter and drops empty sections", () => {
    const rows = buildPluginRows({ builtins, installed, favorites: [], recents: [], q: "", kind: "inst" });
    expect(names(rows)).toEqual(expect.arrayContaining(["Sampler", "Serum", "Vital"]));
    expect(names(rows)).not.toContain("OTT");
    const q = buildPluginRows({ builtins, installed, favorites: [], recents: [], q: "serum", kind: "all" });
    expect(names(q)).toEqual(["Serum"]);
  });

  it("groups the native Mosh FX suite as built-in effects", () => {
    const moshFx = [
      builtinEntry(bi("moshAutoTune", "Mosh AutoTune", "Mosh FX")),
      builtinEntry(bi("moshOTT", "Mosh OTT", "Mosh FX")),
      builtinEntry(bi("moshXFeedback", "Mosh X-FDBK", "Mosh FX")),
    ];
    const rows = buildPluginRows({ builtins: moshFx, installed: [], favorites: [], recents: [], q: "mosh", kind: "fx" });
    expect(headers(rows)).toEqual(["Mosh FX"]);
    expect(names(rows)).toEqual(["Mosh AutoTune", "Mosh OTT", "Mosh X-FDBK"]);
  });

  it("Other vendor sorts after named vendors", () => {
    const list = [installedEntry(vst("a", "Zeta", "")), installedEntry(vst("b", "Alpha", "ACME"))];
    const rows = buildPluginRows({ builtins: [], installed: list, favorites: [], recents: [], q: "", kind: "all" });
    expect(headers(rows)).toEqual(["ACME", "Other"]);
  });
});

describe("visibleRange", () => {
  it("returns the overscanned window for the scroll position", () => {
    // 1000 rows, 40px each, 400px viewport, scrolled to 4000px (row 100).
    const { start, end } = visibleRange(4000, 400, 40, 1000, 6);
    expect(start).toBe(94);            // 100 - 6 overscan
    expect(end).toBe(116);             // ceil((4000+400)/40)=110 + 6
  });
  it("clamps at both ends", () => {
    expect(visibleRange(0, 400, 40, 5, 6)).toEqual({ start: 0, end: 5 });
    expect(visibleRange(0, 400, 0, 100)).toEqual({ start: 0, end: 0 });
  });
});

describe("loadPluginEntry", () => {
  it("dispatches load_builtin vs load_plugin with the right arg shape and records recents", () => {
    localStorage.clear();
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const exec = (command: string, args?: Record<string, unknown>) => { calls.push([command, args]); };
    expect(loadPluginEntry(builtinEntry(bi("sampler", "Sampler", "Instrument", true)), "t1", exec)).toBe(true);
    expect(loadPluginEntry(installedEntry(vst("abc", "Serum", "Xfer", true)), "t1", exec)).toBe(true);
    expect(calls).toEqual([
      ["load_builtin", { trackId: "t1", type: "sampler" }],
      ["load_plugin", { trackId: "t1", pluginId: "abc" }],
    ]);
    expect(loadPluginRecents()).toEqual(["v:abc", "b:sampler"]); // newest first
  });

  it("is a full no-op (returns false, no command, no recent) without a selected track", () => {
    localStorage.clear();
    const exec = vi.fn();
    expect(loadPluginEntry(builtinEntry(bi("comp", "Compressor", "Dynamics")), null, exec)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(loadPluginRecents()).toEqual([]);
  });
});

describe("loadMasterPluginEntry", () => {
  it("dispatches master-only commands for built-in and installed entries", () => {
    localStorage.clear();
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const exec = (command: string, args?: Record<string, unknown>) => { calls.push([command, args]); };

    expect(loadMasterPluginEntry(builtinEntry(bi("comp", "Compressor", "Dynamics")), exec)).toBe(true);
    expect(loadMasterPluginEntry(installedEntry(vst("ott", "OTT", "Xfer")), exec)).toBe(true);
    expect(calls).toEqual([
      ["load_master_builtin", { type: "comp" }],
      ["load_master_plugin", { pluginId: "ott" }],
    ]);
    expect(loadPluginRecents()).toEqual(["v:ott", "b:comp"]);
  });
});
