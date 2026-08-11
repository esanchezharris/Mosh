import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MasterMeter, SendMeter } from "./Meter";
import { useStore } from "../store";
import { sendLevelKey } from "../types";

const here = dirname(fileURLToPath(import.meta.url));

describe("MasterMeter clipping state", () => {
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    vi.unstubAllGlobals();
  });

  it("uses a meter-specific clip class so timeline clip CSS cannot reposition it", () => {
    const rafs: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafs.push(cb);
      return rafs.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    useStore.setState({ levels: { tracks: {}, master: { l: 0, r: -3 } } });

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    act(() => {
      root!.render(React.createElement(MasterMeter));
    });
    expect(rafs.length).toBeGreaterThan(0);

    act(() => {
      rafs.shift()!(1000);
    });

    const meter = host.querySelector(".meter.master");
    expect(meter).not.toBeNull();
    expect(meter!.classList.contains("meter-clip")).toBe(true);
    expect(meter!.classList.contains("clip")).toBe(false);
  });

  it("keeps the clip glow selector scoped away from timeline clip CSS", () => {
    const css = readFileSync(join(here, "mosh.css"), "utf8");
    expect(css).toContain(".meter.meter-clip .mbar");
    expect(css).not.toContain(".meter.clip .mbar");
  });

  it("paints an accessible non-focusable stereo send meter from imperative telemetry", () => {
    const rafs: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      rafs.push(callback);
      return rafs.length;
    });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useStore.setState({
      sendLevels: { [sendLevelKey("vocal", 2)]: { l: -12, r: -18 } },
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement(SendMeter, {
      trackId: "vocal",
      bus: 2,
      label: "Plate send output",
    })));

    const meter = host.querySelector<HTMLElement>('[role="meter"]');
    expect(meter?.getAttribute("aria-label")).toBe("Plate send output");
    expect(meter?.getAttribute("aria-valuemin")).toBe("-100");
    expect(meter?.getAttribute("aria-valuemax")).toBe("0");
    expect(meter?.hasAttribute("aria-live")).toBe(false);
    expect(meter?.hasAttribute("tabindex")).toBe(false);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => rafs.shift()!(1_000));

    expect(Array.from(host.querySelectorAll<HTMLElement>(".mmask")).map((mask) => mask.style.width))
      .toEqual(["20%", "30%"]);
    expect(meter?.getAttribute("aria-valuenow")).toBe("-12");
    expect(meter?.getAttribute("aria-valuetext"))
      .toBe("Left -12.0 dBFS, right -18.0 dBFS");
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it("uses the silence floor when a send has no telemetry slot", () => {
    const rafs: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      rafs.push(callback);
      return rafs.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useStore.setState({ sendLevels: {} });

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement(SendMeter, {
      trackId: "vocal",
      bus: 9,
      label: "Missing send output",
    })));
    act(() => rafs.shift()!(1_000));

    expect(Array.from(host.querySelectorAll<HTMLElement>(".mmask")).map((mask) => mask.style.width))
      .toEqual(["100%", "100%"]);
    expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("-100");
  });
});
