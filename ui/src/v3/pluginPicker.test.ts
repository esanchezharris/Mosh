import { describe, it, expect } from "vitest";
import { buildCollections, rowsForCollection } from "./pluginPicker";
import { builtinEntry, installedEntry } from "../ui/pluginBrowserUtil";
import type { BuiltinPlugin, AvailablePlugin } from "../types";

const builtins = [
  { type: "4osc", name: "4OSC", category: "Instruments", isInstrument: true, builtin: true } as BuiltinPlugin,
  { type: "reverb", name: "Reverb", category: "Effects", isInstrument: false, builtin: true } as BuiltinPlugin,
  { type: "delay", name: "Delay", category: "Effects", isInstrument: false, builtin: true } as BuiltinPlugin,
].map(builtinEntry);

const installed = [
  { id: "vital", name: "Vital", format: "VST3", manufacturer: "Vital Audio", isInstrument: true } as AvailablePlugin,
  { id: "ott", name: "OTT", format: "VST3", manufacturer: "Xfer", isInstrument: false } as AvailablePlugin,
  { id: "serum", name: "Serum", format: "VST3", manufacturer: "Xfer", isInstrument: true } as AvailablePlugin,
].map(installedEntry);

describe("pluginPicker.buildCollections", () => {
  it("lists All + kinds + vendors with counts; omits empty Favorites/Recent", () => {
    const cols = buildCollections({ builtins, installed, favorites: [], recents: [] });
    const byId = Object.fromEntries(cols.map((c) => [c.id, c]));
    expect(byId["all"].count).toBe(6);
    expect(byId["inst"].count).toBe(3); // 4OSC, Vital, Serum
    expect(byId["fx"].count).toBe(3);   // Reverb, Delay, OTT
    expect(byId["fav"]).toBeUndefined();
    expect(byId["recent"]).toBeUndefined();
    // vendor collections present (built-in category + installed manufacturer)
    expect(byId["v:Xfer"].count).toBe(2); // OTT + Serum
    expect(byId["v:Vital Audio"].count).toBe(1);
  });

  it("includes Favorites/Recent when non-empty (recent excludes favorites)", () => {
    const cols = buildCollections({ builtins, installed, favorites: ["v:vital"], recents: ["v:vital", "v:ott"] });
    const byId = Object.fromEntries(cols.map((c) => [c.id, c]));
    expect(byId["fav"].count).toBe(1);
    expect(byId["recent"].count).toBe(1); // ott only — vital is a favorite
  });
});

describe("pluginPicker.rowsForCollection", () => {
  const base = { builtins, installed, favorites: ["v:vital"], recents: ["v:ott"] };

  it("all → vendor-grouped with header rows", () => {
    const rows = rowsForCollection({ ...base, collection: "all", q: "" });
    const headers = rows.filter((r) => r.kind === "header").map((r) => (r as { label: string }).label);
    expect(headers).toContain("Xfer");
    expect(rows.filter((r) => r.kind === "plugin")).toHaveLength(6);
  });

  it("inst → only instruments", () => {
    const rows = rowsForCollection({ ...base, collection: "inst", q: "" });
    const names = rows.filter((r) => r.kind === "plugin").map((r) => (r as { entry: { name: string } }).entry.name);
    expect(names.sort()).toEqual(["4OSC", "Serum", "Vital"]);
  });

  it("a vendor collection → flat, that vendor only", () => {
    const rows = rowsForCollection({ ...base, collection: "v:Xfer", q: "" });
    expect(rows.every((r) => r.kind === "plugin")).toBe(true);
    expect(rows.map((r) => (r as { entry: { name: string } }).entry.name)).toEqual(["OTT", "Serum"]);
  });

  it("favorites → flat in favorite order; recent excludes favorites", () => {
    const fav = rowsForCollection({ ...base, collection: "fav", q: "" });
    expect(fav.map((r) => (r as { entry: { name: string } }).entry.name)).toEqual(["Vital"]);
    const rec = rowsForCollection({ ...base, collection: "recent", q: "" });
    expect(rec.map((r) => (r as { entry: { name: string } }).entry.name)).toEqual(["OTT"]);
  });

  it("the query filters within the collection", () => {
    const rows = rowsForCollection({ ...base, collection: "all", q: "vit" });
    const names = rows.filter((r) => r.kind === "plugin").map((r) => (r as { entry: { name: string } }).entry.name);
    expect(names).toEqual(["Vital"]);
  });
});
