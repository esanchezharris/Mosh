import { describe, it, expect, beforeEach } from "vitest";
import { useShell } from "./shellState";

// The v2 shell's UI-local view state. These are pure setters (no backend, no commands) —
// the left browser drawer's open/tab state in particular.
describe("v2 shellState — browser drawer", () => {
  beforeEach(() => {
    useShell.setState({ browserOpen: false, browserTab: "sounds" });
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
});
