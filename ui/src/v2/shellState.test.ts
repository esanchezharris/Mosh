import { describe, it, expect, beforeEach } from "vitest";
import { useShell } from "./shellState";

// The v2 shell's UI-local view state. These are pure setters (no backend, no commands) —
// the left browser drawer's open/tab state in particular.
describe("v2 shellState — browser drawer", () => {
  beforeEach(() => {
    useShell.setState({ browserOpen: false, browserTab: "sounds", arrangementToolsOpen: false });
  });

  it("defaults to closed on the Sounds tab", () => {
    const s = useShell.getState();
    expect(s.browserOpen).toBe(false);
    expect(s.browserTab).toBe("sounds");
  });

  it("toggleBrowser flips open/closed", () => {
    useShell.getState().toggleBrowser();
    expect(useShell.getState().browserOpen).toBe(true);
    useShell.getState().toggleBrowser();
    expect(useShell.getState().browserOpen).toBe(false);
  });

  it("setBrowserOpen sets the open state directly", () => {
    useShell.getState().setBrowserOpen(true);
    expect(useShell.getState().browserOpen).toBe(true);
    useShell.getState().setBrowserOpen(false);
    expect(useShell.getState().browserOpen).toBe(false);
  });

  it("openBrowserTab opens the drawer ON the requested tab", () => {
    useShell.getState().openBrowserTab("plugins");
    expect(useShell.getState().browserOpen).toBe(true);
    expect(useShell.getState().browserTab).toBe("plugins");
    // switching tabs while open keeps it open
    useShell.getState().openBrowserTab("sounds");
    expect(useShell.getState().browserOpen).toBe(true);
    expect(useShell.getState().browserTab).toBe("sounds");
  });

  it("reveals the dense arrangement tools only on request", () => {
    expect(useShell.getInitialState().arrangementToolsOpen).toBe(false);
    useShell.getState().toggleArrangementTools();
    expect(useShell.getState().arrangementToolsOpen).toBe(true);
  });
});

describe("v2 shellState — right dock (agent rail)", () => {
  beforeEach(() => {
    useShell.setState({ rightOpen: true, railTab: "track", selectedClipId: null });
  });

  it("defaults to open (the agent is present by default)", () => {
    expect(useShell.getState().rightOpen).toBe(true);
  });

  it("toggleRight flips open/closed", () => {
    useShell.getState().toggleRight();
    expect(useShell.getState().rightOpen).toBe(false);
    useShell.getState().toggleRight();
    expect(useShell.getState().rightOpen).toBe(true);
  });

  it("setRightOpen sets the open state directly", () => {
    useShell.getState().setRightOpen(false);
    expect(useShell.getState().rightOpen).toBe(false);
    useShell.getState().setRightOpen(true);
    expect(useShell.getState().rightOpen).toBe(true);
  });

  it("opens a requested Clip, Track, or Agent tab", () => {
    useShell.getState().setRightOpen(false);
    useShell.getState().openRailTab("agent");
    expect(useShell.getState().rightOpen).toBe(true);
    expect(useShell.getState().railTab).toBe("agent");
    useShell.getState().setRailTab("track");
    expect(useShell.getState().railTab).toBe("track");
  });

  it("selecting a clip opens the Clip tab", () => {
    useShell.getState().setSelectedClip("clip-1");
    expect(useShell.getState().selectedClipId).toBe("clip-1");
    expect(useShell.getState().rightOpen).toBe(true);
    expect(useShell.getState().railTab).toBe("clip");
  });
});

// UIREACH-TIMERANGE — the ruler-drawn time-range span. UI-local like every other
// selection concept here: it never reaches the backend on its own, only via an
// explicit action (delete_time_range / ripple / loop) that reads it.
describe("v2 shellState — time-range span", () => {
  beforeEach(() => {
    useShell.setState({ timeRange: null, timeRangeDragging: false });
  });

  it("defaults to no selection, not dragging", () => {
    expect(useShell.getState().timeRange).toBeNull();
    expect(useShell.getState().timeRangeDragging).toBe(false);
  });

  it("setTimeRange sets and clears the span", () => {
    useShell.getState().setTimeRange({ start: 4, end: 8 });
    expect(useShell.getState().timeRange).toEqual({ start: 4, end: 8 });
    useShell.getState().setTimeRange(null);
    expect(useShell.getState().timeRange).toBeNull();
  });

  it("setTimeRangeDragging flips independently of the span itself", () => {
    useShell.getState().setTimeRange({ start: 1, end: 2 });
    useShell.getState().setTimeRangeDragging(true);
    expect(useShell.getState().timeRangeDragging).toBe(true);
    expect(useShell.getState().timeRange).toEqual({ start: 1, end: 2 });
    useShell.getState().setTimeRangeDragging(false);
    expect(useShell.getState().timeRangeDragging).toBe(false);
    expect(useShell.getState().timeRange).toEqual({ start: 1, end: 2 });
  });
});
