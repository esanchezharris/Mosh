import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MoshiFace } from "./MoshiFace";

// The splat laughs once per celebrate tick. A face that MOUNTS after a celebration (the
// dock re-mounting when the posture changes, the Start page's own face) must not replay
// it: before the fix, lastCelebrate started at 0 and every later mount laughed.
describe("MoshiFace celebrate", () => {
  let host: HTMLDivElement;
  let root: Root;
  const mood = { safe: true, busy: false, listening: false, clarify: false };
  const laughs = () => Number(host.querySelector<HTMLCanvasElement>('[data-testid="v3-moshi-canvas"]')?.dataset.laughs ?? 0);
  const render = (tick: number) => act(() => root.render(React.createElement(MoshiFace, { celebrateTick: tick, mood })));

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("does not laugh on mount for a celebration that happened before it existed", () => {
    render(3);
    expect(laughs()).toBe(0);
  });

  it("laughs once per new tick after mount", () => {
    render(3);
    render(4);
    render(4);
    render(5);
    expect(laughs()).toBe(2);
  });
});
