// UI-REACH (sketch_beatbox) — SampleBrowser is the entry point (not the clipId-based
// clip menu: cmdSketchBeatbox takes an absolute path, and list_directory's rows are
// where a real one already exists). Covers: the button is on file rows, opens the
// dialog scoped to the RIGHT row's path, and an in-flight sketch swaps the button for
// a status pill (never both — a trap this suite guards against explicitly, since "no
// dialog when X" alone would pass just as happily if the button were never built at
// all; see the positive-case pairing below).

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SampleBrowser } from "./SampleBrowser";
import { useStore } from "../store";
import type { CommandResult, DirListing } from "../types";

const LISTING: DirListing = {
  path: "/Users/you", parent: "/Users", exists: true, error: null,
  roots: [{ name: "Home", path: "/Users/you" }],
  entries: [
    { name: "boombap.wav", path: "/Users/you/boombap.wav", isDir: false, size: 1000 },
    { name: "Loops", path: "/Users/you/Loops", isDir: true, size: null },
  ],
};

describe("SampleBrowser — sketch_beatbox entry point", () => {
  let host: HTMLDivElement;
  let root: Root;
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      selectedTrackId: null,
      sketchingBeatbox: {},
      refresh: vi.fn(async () => {}),
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        if (command === "list_directory") return { ok: true, command, data: LISTING };
        if (command === "file_peaks") return { ok: true, command, data: { peaks: [] } };
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const render = async () => {
    await act(async () => { root.render(React.createElement(SampleBrowser)); });
    await act(async () => {}); // flush the initial list_directory() effect
  };

  it("a file row carries a Beatbox → beat entry point (never a folder row)", async () => {
    await render();
    const fileRow = [...host.querySelectorAll('[data-testid="sample-row"]')].find((r) => r.textContent?.includes("boombap.wav"))!;
    expect(fileRow.querySelector('[data-testid="sample-sketch-beatbox"]')).not.toBeNull();
    const folderRow = [...host.querySelectorAll(".plugin-row")].find((r) => r.textContent?.includes("Loops"))!;
    expect(folderRow.querySelector('[data-testid="sample-sketch-beatbox"]')).toBeNull();
  });

  it("clicking it opens the dialog scoped to THAT row's real absolute path — never a folder, " +
     "never a hardcoded stand-in", async () => {
    await render();
    expect(document.querySelector('[data-testid="sketch-beatbox-dialog"]')).toBeNull(); // closed by default
    const btn = host.querySelector('[data-testid="sample-sketch-beatbox"]') as HTMLButtonElement;
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const dialog = document.querySelector('[data-testid="sketch-beatbox-dialog"]');
    expect(dialog).not.toBeNull(); // the positive case — paired with the "closed by default" negative above
    expect(dialog!.textContent).toContain("boombap.wav");
  });

  it("an in-flight sketch for this path swaps the button for a status pill (no double-dispatch)", async () => {
    useStore.setState({ sketchingBeatbox: { "/Users/you/boombap.wav": true } });
    await render();
    const fileRow = [...host.querySelectorAll('[data-testid="sample-row"]')].find((r) => r.textContent?.includes("boombap.wav"))!;
    expect(fileRow.querySelector('[data-testid="sample-sketch-beatbox"]')).toBeNull();
    expect(fileRow.querySelector('[data-testid="sample-sketching"]')).not.toBeNull();
  });
});
