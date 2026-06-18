import { describe, it, expect } from "vitest";
import { filterEntries, pushRecent } from "./sampleBrowserUtil";
import type { DirEntry } from "../types";

const e = (name: string, isDir = false): DirEntry => ({
  name, path: `/x/${name}`, isDir, size: isDir ? null : 100,
});

describe("filterEntries", () => {
  const entries = [e("Kicks", true), e("kick_01.wav"), e("snare.wav"), e("Hat.aiff")];
  it("returns everything for an empty/whitespace query", () => {
    expect(filterEntries(entries, "")).toEqual(entries);
    expect(filterEntries(entries, "   ")).toEqual(entries);
  });
  it("matches name by case-insensitive substring (files and folders)", () => {
    expect(filterEntries(entries, "kick").map((x) => x.name)).toEqual(["Kicks", "kick_01.wav"]);
    expect(filterEntries(entries, "WAV").map((x) => x.name)).toEqual(["kick_01.wav", "snare.wav"]);
  });
  it("returns [] when nothing matches", () => {
    expect(filterEntries(entries, "zzz")).toEqual([]);
  });
});

describe("pushRecent", () => {
  it("prepends the newest path", () => {
    expect(pushRecent(["/a", "/b"], "/c")).toEqual(["/c", "/a", "/b"]);
  });
  it("dedupes (moves an existing path to the front)", () => {
    expect(pushRecent(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
  });
  it("caps the list at max (default 8)", () => {
    const many = ["/1", "/2", "/3", "/4", "/5", "/6", "/7", "/8"];
    expect(pushRecent(many, "/new")).toEqual(["/new", "/1", "/2", "/3", "/4", "/5", "/6", "/7"]);
    expect(pushRecent(many, "/new")).toHaveLength(8);
  });
});
