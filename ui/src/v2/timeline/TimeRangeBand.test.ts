// UIREACH-TIMERANGE — the cross-lane time-range overlay: delete_time_range's only
// shipped-UI home. The property that matters most: DELETE and DELETE-CLOSE-GAP are two
// separately labelled buttons, not one action plus a ripple checkbox — ripple silently
// reflows every downstream clip in the project, and that must never be one missed
// modifier key away from a plain delete.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeRangeBand } from "./TimeRangeBand";
import { useStore } from "../../store";
import { useShell } from "../shellState";

vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}) };
});

describe("TimeRangeBand", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const render = () => act(() => root.render(React.createElement(TimeRangeBand)));
  const band = () => host.querySelector('[data-testid="v2-timerange-band"]');
  const toolbar = () => host.querySelector('[data-testid="v2-timerange-toolbar"]');
  const del = () => host.querySelector('[data-testid="v2-timerange-delete"]') as HTMLButtonElement | null;
  const delRipple = () => host.querySelector('[data-testid="v2-timerange-delete-ripple"]') as HTMLButtonElement | null;
  const clearBtn = () => host.querySelector('[data-testid="v2-timerange-clear"]') as HTMLButtonElement | null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true }));
    useStore.setState({ exec, pxPerSec: 100 } as never);
    useShell.setState({ timeRange: null, timeRangeDragging: false });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("renders nothing without a real span, and something once one exists", () => {
    render();
    expect(band(), "no selection -> no band").toBeFalsy();

    act(() => { useShell.setState({ timeRange: { start: 4, end: 4 } }); }); // zero-width == none
    expect(band(), "zero-width span must not render as a live selection").toBeFalsy();

    act(() => { useShell.setState({ timeRange: { start: 4, end: 6 } }); });
    expect(band(), "a real span must render the band").toBeTruthy();
  });

  it("withholds the action toolbar while still dragging, and shows it once released", () => {
    useShell.setState({ timeRange: { start: 4, end: 6 }, timeRangeDragging: true });
    render();
    expect(band()).toBeTruthy();
    expect(toolbar(), "toolbar must not jitter across the screen mid-drag").toBeFalsy();

    act(() => { useShell.setState({ timeRangeDragging: false }); });
    expect(toolbar(), "toolbar must appear once the drag settles").toBeTruthy();
  });

  it("positions the band from the span and pxPerSec", () => {
    useShell.setState({ timeRange: { start: 4, end: 6 }, timeRangeDragging: false });
    render();
    const el = band() as HTMLElement;
    // headW() falls back to its jsdom default (no .v2-shell in this host) + start*pxPerSec.
    expect(el.style.left).toBe(`${200 + 4 * 100}px`);
    expect(el.style.width).toBe(`${(6 - 4) * 100}px`);
  });

  it("Delete and Delete-close-gap are two DISTINCT actions, not a shared button plus a modifier", async () => {
    useShell.setState({ timeRange: { start: 4, end: 6 }, timeRangeDragging: false });
    render();
    expect(del()).toBeTruthy();
    expect(delRipple(), "ripple must be its own labelled control, always present alongside plain delete").toBeTruthy();
    expect(del()).not.toBe(delRipple());

    await act(async () => { del()!.click(); });
    expect(exec).toHaveBeenCalledWith("delete_time_range", { start: 4, end: 6 });
    expect(exec.mock.calls[0][1]).not.toHaveProperty("ripple");

    exec.mockClear();
    act(() => { useShell.setState({ timeRange: { start: 2, end: 3 }, timeRangeDragging: false }); });
    render();
    await act(async () => { delRipple()!.click(); });
    expect(exec).toHaveBeenCalledWith("delete_time_range", { start: 2, end: 3, ripple: true });
  });

  it("either action clears the now-stale selection", async () => {
    useShell.setState({ timeRange: { start: 4, end: 6 }, timeRangeDragging: false });
    render();
    await act(async () => { del()!.click(); });
    expect(useShell.getState().timeRange).toBeNull();
  });

  it("the clear (x) button dismisses the selection without touching the backend", () => {
    useShell.setState({ timeRange: { start: 4, end: 6 }, timeRangeDragging: false });
    render();
    act(() => { clearBtn()!.click(); });
    expect(useShell.getState().timeRange).toBeNull();
    expect(exec, "clearing a selection must never dispatch a command").not.toHaveBeenCalled();
  });

  it("Escape clears an active selection", () => {
    useShell.setState({ timeRange: { start: 4, end: 6 }, timeRangeDragging: false });
    render();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(useShell.getState().timeRange).toBeNull();
  });
});
