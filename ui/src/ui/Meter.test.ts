import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MasterMeter } from "./Meter";
import { useStore } from "../store";

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
});
