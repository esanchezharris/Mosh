import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrumsClip, MelodyClip } from "./MidiClips";

describe("v3 MIDI accent ink", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("paints drum and melody notes with var(--accent)", () => {
    act(() => {
      root.render(React.createElement("div", null,
        React.createElement(DrumsClip, { notes: [{ i: 0, pitch: 36, start: 0, length: 0.25, velocity: 100 }] }),
        React.createElement(MelodyClip, { notes: [{ i: 1, pitch: 60, start: 1, length: 1, velocity: 90 }] }),
      ));
    });
    const fills = [...host.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((f) => f === "var(--accent)")).toBe(true);
  });
});
