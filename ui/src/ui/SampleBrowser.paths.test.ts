import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SampleBrowser } from "./SampleBrowser";
import { useStore } from "../store";
import type { CommandResult, DirListing } from "../types";

// A23 (demo readiness) — the V3 Files tab is on a screen share: it shows file and folder NAMES
// only, never an absolute home path (the path bar, row meta, recents, or tooltips). Every other
// shell keeps the full paths (the prop defaults off).

const listing: DirListing = {
  path: "/Users/owner/Library/Mosh/session/imports",
  parent: "/Users/owner/Library/Mosh/session",
  exists: true,
  error: null,
  roots: [{ name: "Home", path: "/Users/owner" }],
  entries: [
    { name: "Loops", path: "/Users/owner/Library/Mosh/session/imports/Loops", isDir: true, size: null },
    { name: "kick.wav", path: "/Users/owner/Library/Mosh/session/imports/kick.wav", isDir: false, size: 1000 },
  ],
};
const RECENT = "/Users/owner/Music/private-bounce.wav";

describe("SampleBrowser — private paths", () => {
  let host: HTMLDivElement;
  let root: Root;
  const everyText = () => [host.textContent ?? "", ...[...host.querySelectorAll("[title]")].map((el) => el.getAttribute("title") ?? "")].join("\n");

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem("mosh.recentSamples.v2", JSON.stringify([RECENT]));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      selectedTrackId: null,
      sketchingBeatbox: {},
      refresh: vi.fn(async () => {}),
      exec: vi.fn(async (command: string): Promise<CommandResult> =>
        command === "list_directory" ? { ok: true, command, data: listing } : { ok: true, command }),
    });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.removeItem("mosh.recentSamples.v2"); });

  it("by default (every other shell) shows the full paths", async () => {
    await act(async () => { root.render(React.createElement(SampleBrowser)); });
    await act(async () => {});
    expect(host.querySelector(".sb-path")?.textContent).toBe(listing.path);
    expect(everyText()).toContain(RECENT);
    expect(everyText()).toContain("/Users/owner/Library/Mosh/session/imports/kick.wav");
  });

  it("with hidePaths shows names only: no absolute path anywhere, text or tooltip", async () => {
    await act(async () => { root.render(React.createElement(SampleBrowser, { hidePaths: true })); });
    await act(async () => {});
    const all = everyText();
    for (const name of ["imports", "Loops", "kick.wav", "private-bounce.wav", "Home"]) expect(all).toContain(name);
    expect(host.querySelector(".sb-path")?.textContent).toBe("imports");
    expect(all).not.toMatch(/\/Users\//);
    expect(host.querySelectorAll(".sb-row-meta")).toHaveLength(0);
  });
});
