import { describe, expect, it } from "vitest";
import { EditorAction as A } from "../interaction/actions";
import { resolveGesture } from "../interaction/gestures";
import { proToolsGestureTable } from "./proToolsGestureTable";

const resolve = (
  media: "audio" | "midi",
  smart: boolean,
  tool: "selector" | "grabber" | "trimmer",
  region: string,
) => resolveGesture(proToolsGestureTable(media, smart, tool), {
  region,
  gesture: "drag",
  mods: {},
});

describe("Pro Tools clip gesture tables", () => {
  it("maps Smart Tool audio upper/lower/edge to Selector, Grabber, and Trimmer", () => {
    expect(resolve("audio", true, "selector", "clip.header")).toBe(A.TIME_SELECT);
    expect(resolve("audio", true, "selector", "clip.body")).toBe(A.MOVE);
    expect(resolve("audio", true, "selector", "clip.edge")).toBe(A.TRIM);
  });

  it("maps Smart Tool MIDI body to Grabber while keeping edge Trim", () => {
    expect(resolve("midi", true, "selector", "clip.body")).toBe(A.MOVE);
    expect(resolve("midi", true, "selector", "clip.edge")).toBe(A.TRIM);
  });

  it("uses the explicit tool when Smart Tool is disabled", () => {
    expect(resolve("audio", false, "selector", "clip.body")).toBe(A.TIME_SELECT);
    expect(resolve("audio", false, "grabber", "clip.header")).toBe(A.MOVE);
    expect(resolve("audio", false, "trimmer", "clip.edge")).toBe(A.TRIM);
    expect(resolve("audio", false, "trimmer", "clip.body")).toBeNull();
  });
});
