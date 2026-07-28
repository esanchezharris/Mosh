import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach } from "vitest";
import { instrumentOf } from "./InstrumentSlot";
import { Rack } from "../../ui/Dock";

// The slot's whole job is answering "does this track have a synth, and which one".
// That lookup is the part worth pinning; the buttons are thin exec wrappers.
describe("instrumentOf", () => {
  const fx = { index: 0, name: "OTT", enabled: true, external: true, isInstrument: false } as never;
  const synth = { index: 1, name: "Vital", enabled: true, external: true, isInstrument: true } as never;

  it("finds the instrument among effects", () => {
    expect(instrumentOf({ plugins: [fx, synth] } as never)?.name).toBe("Vital");
  });
  it("returns null on a bare track", () => {
    expect(instrumentOf({ plugins: [fx] } as never)).toBeNull();
  });
  it("returns null when the track has no plugin array at all", () => {
    expect(instrumentOf({} as never)).toBeNull();
  });
});

describe("Rack hideInstrument", () => {
  let host: HTMLDivElement;
  let root: Root;
  const track = {
    id: "t1", name: "Inst", type: "audio", clips: [],
    plugins: [
      { index: 0, name: "OTT", enabled: true, external: true, isInstrument: false },
      { index: 1, name: "Vital", enabled: true, external: true, isInstrument: true },
    ],
  } as never;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const cardNames = () =>
    [...host.querySelectorAll('[data-testid="plugin-card"] .pname')].map((n) => n.textContent);

  it("v2 hides the instrument — the slot above already shows it", async () => {
    await act(async () => { root.render(React.createElement(Rack, { track, hideInstrument: true })); });
    expect(cardNames()).toEqual(["OTT"]);
  });

  it("classic passes no flag and keeps the flat chain it always had", async () => {
    await act(async () => { root.render(React.createElement(Rack, { track })); });
    expect(cardNames()).toEqual(["OTT", "Vital"]);
  });
});
