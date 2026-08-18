// GEN-WARMUP — the drawer's cold-start UI, distinct from a genuine terminal error (see
// store/jobs.ts's genServiceState). Uses the same rendering harness as
// GenDrawer.bypass.test.ts, but stubs the store's genServiceState directly rather than
// exercising loadColors' real retry loop (that loop has its own coverage in
// store/jobs.warmup.test.ts) — this file is purely "does the drawer render the right thing
// for each state."

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenDrawer } from "./GenDrawer";
import { useStore } from "../store";
import type { Clip, Track } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

const clipWith = (): Clip => ({
  id: "c1", name: "take", type: "wave", start: 0, length: 4, offset: 0,
  hasRenderLayer: false, renderLayer: undefined,
} as unknown as Clip);

const trackWith = (clip: Clip): Track => ({
  id: "t1", index: 0, name: "Vox", type: "audio",
  volumeDb: 0, pan: 0, mute: false, solo: false, clips: [clip], plugins: [],
} as unknown as Track);

describe("GenDrawer — cold-start service status (GEN-WARMUP)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let loadColors: ReturnType<typeof vi.fn>;
  let loadTransformTargets: ReturnType<typeof vi.fn>;
  let loadLoras: ReturnType<typeof vi.fn>;

  const render = () =>
    act(() => root.render(React.createElement(GenDrawer, { track: trackWith(clipWith()), selectedClipId: "c1" })));
  const click = (el: HTMLElement) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    loadColors = vi.fn();
    loadTransformTargets = vi.fn();
    loadLoras = vi.fn();
    useStore.setState({
      exec: vi.fn(async () => ({ ok: true })),
      availableColors: [], availableTransformTargets: [], availableLoras: [],
      sa3Available: undefined, qaByClip: {},
      loadColors, loadTransformTargets, loadLoras,
      genServiceState: "idle", genServiceError: null,
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("shows a warming state (not an error) while the service is still a cold start away, with no console-visible failure", () => {
    useStore.setState({ genServiceState: "warming" } as never);
    render();
    expect(host.querySelector('[data-testid="gen-service-warming"]')?.textContent).toMatch(/starting/i);
    expect(host.querySelector('[data-testid="gen-service-error"]')).toBeFalsy();
  });

  it("shows the same warming state at the initial idle tick, before the first response lands", () => {
    // genServiceState starts "idle" (see jobs.ts) — the instant between mount and the first
    // list_colors response resolving. This must NOT look like an error either.
    render();
    expect(host.querySelector('[data-testid="gen-service-warming"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="gen-service-error"]')).toBeFalsy();
  });

  it("shows nothing once colours have actually loaded, even if genServiceState lags at idle/warming", () => {
    useStore.setState({ availableColors: [{ name: "grit" }] as never } as never);
    render();
    expect(host.querySelector('[data-testid="gen-service-warming"]')).toBeFalsy();
  });

  it("shows a genuine, actionable error only once retries are exhausted — with a Retry action", () => {
    useStore.setState({ genServiceState: "error", genServiceError: "spawn failed: no such file" } as never);
    render();
    const err = host.querySelector('[data-testid="gen-service-error"]');
    expect(err?.textContent).toContain("spawn failed: no such file");
    expect(host.querySelector('[data-testid="gen-service-warming"]')).toBeFalsy();

    const retry = host.querySelector('[data-testid="gen-service-retry"]') as HTMLButtonElement;
    expect(retry).toBeTruthy();
    click(retry);
    expect(loadColors).toHaveBeenCalled();
    expect(loadTransformTargets).toHaveBeenCalled();
    expect(loadLoras).toHaveBeenCalled();
  });

  it("shows neither banner once ready", () => {
    useStore.setState({ genServiceState: "ready", availableColors: [{ name: "grit" }] as never } as never);
    render();
    expect(host.querySelector('[data-testid="gen-service-warming"]')).toBeFalsy();
    expect(host.querySelector('[data-testid="gen-service-error"]')).toBeFalsy();
  });
});
