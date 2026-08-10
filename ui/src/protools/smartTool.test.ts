import { describe, expect, it } from "vitest";
import { classifyProToolsIntent, type ProToolsHit } from "./smartTool";

const hit = (over: Partial<ProToolsHit>): ProToolsHit => ({
  media: "audio",
  x: 50,
  y: 20,
  width: 100,
  height: 60,
  edgeGrabPx: 6,
  smartToolEnabled: true,
  ...over,
});

describe("Pro Tools Smart Tool intent", () => {
  it("uses Selector on an audio clip's upper half and Grabber on its lower half", () => {
    expect(classifyProToolsIntent(hit({ y: 12 }))).toBe("selector");
    expect(classifyProToolsIntent(hit({ y: 48 }))).toBe("grabber");
  });

  it("reserves audio top corners for fades and other edges for Trimmer", () => {
    expect(classifyProToolsIntent(hit({ x: 2, y: 2 }))).toBe("fade-in");
    expect(classifyProToolsIntent(hit({ x: 98, y: 2 }))).toBe("fade-out");
    expect(classifyProToolsIntent(hit({ x: 2, y: 40 }))).toBe("trimmer");
  });

  it("uses Grabber for MIDI, Trim at edges, Marquee on blank space, and Cmd-hover velocity trim", () => {
    expect(classifyProToolsIntent(hit({ media: "midi" }))).toBe("grabber");
    expect(classifyProToolsIntent(hit({ media: "midi", x: 2 }))).toBe("trimmer");
    expect(classifyProToolsIntent(hit({ media: "midi", blank: true }))).toBe("marquee");
    expect(classifyProToolsIntent(hit({ media: "midi", x: 2, blank: true }))).toBe("trimmer");
    expect(classifyProToolsIntent(hit({ media: "midi", meta: true }))).toBe("velocity-trim");
    expect(classifyProToolsIntent(hit({ media: "midi", x: 2, meta: true }))).toBe("trimmer");
  });

  it("uses Selector in the lower automation band, Trim in the top quarter, and Cmd-click for a breakpoint", () => {
    expect(classifyProToolsIntent(hit({ media: "automation", y: 45 }))).toBe("selector");
    expect(classifyProToolsIntent(hit({ media: "automation", x: 2, y: 45 }))).toBe("selector");
    expect(classifyProToolsIntent(hit({ media: "automation", y: 8 }))).toBe("trimmer");
    expect(classifyProToolsIntent(hit({ media: "automation", meta: true, gesture: "click" }))).toBe("breakpoint");
    expect(classifyProToolsIntent(hit({ media: "automation", y: 8, meta: true, gesture: "drag" }))).toBe("trimmer");
  });

  it("uses the explicit tool everywhere when Smart Tool is off", () => {
    expect(classifyProToolsIntent(hit({ smartToolEnabled: false, activeTool: "pencil", x: 2, y: 2 }))).toBe("pencil");
  });

  it("defaults Smart Tool to enabled when the caller omits the flag", () => {
    expect(classifyProToolsIntent(hit({ smartToolEnabled: undefined, y: 48 }))).toBe("grabber");
  });
});
