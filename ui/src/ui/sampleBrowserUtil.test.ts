import { describe, it, expect } from "vitest";
import { filterEntries, pushRecent, parseSimilarResult, similarityPct } from "./sampleBrowserUtil";
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

describe("parseSimilarResult", () => {
  it("normalizes matches and defaults available to true when absent", () => {
    const r = parseSimilarResult({ matches: [{ path: "/a.wav", distance: 0.1, role_guess: "kick", kind: "one_shot" }] });
    expect(r.available).toBe(true);
    expect(r.matches).toEqual([{ path: "/a.wav", distance: 0.1, role_guess: "kick", kind: "one_shot" }]);
  });
  it("reports available=false (with reason) when the backend says so", () => {
    const r = parseSimilarResult({ available: false, reason: "index_not_built", matches: [] });
    expect(r.available).toBe(false);
    expect(r.reason).toBe("index_not_built");
    expect(r.matches).toEqual([]);
  });
  it("is robust to junk: null data, missing matches, malformed rows", () => {
    expect(parseSimilarResult(null)).toEqual({ available: true, matches: [], reason: undefined });
    expect(parseSimilarResult({}).matches).toEqual([]);
    const r = parseSimilarResult({ matches: [null, { distance: 0.2 }, { path: "/ok.wav", distance: "0.3" }] });
    expect(r.matches).toEqual([{ path: "/ok.wav", distance: 0.3, role_guess: undefined, kind: undefined }]);
  });
});

describe("similarityPct", () => {
  it("maps cosine distance 0..2 to 100..0%", () => {
    expect(similarityPct(0)).toBe(100);
    expect(similarityPct(1)).toBe(50);
    expect(similarityPct(2)).toBe(0);
  });
  it("clamps out-of-range / non-finite distances", () => {
    expect(similarityPct(-0.5)).toBe(100);
    expect(similarityPct(3)).toBe(0);
    expect(similarityPct(NaN)).toBe(0);
  });
});
