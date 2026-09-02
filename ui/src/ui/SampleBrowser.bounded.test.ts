import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SampleBrowser } from "./SampleBrowser";
import { useStore } from "../store";
import type { CommandResult, DirListing } from "../types";

const bridge = vi.hoisted(() => ({
  pickFiles: vi.fn(async () => ({ ok: false, files: [] as string[] })),
  addSampleFolder: vi.fn(async (): Promise<{
    ok: boolean; path?: string; name?: string;
  }> => ({ ok: false })),
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, ...bridge };
});

const listing: DirListing = {
  path: "/samples",
  parent: "/",
  exists: true,
  error: null,
  roots: [{ name: "Home", path: "/samples" }],
  entries: [{ name: "pack", path: "/samples/pack", isDir: true, size: null }],
  truncated: true,
  limit: 512,
  visited: 513,
};

describe("SampleBrowser — bounded native listings", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      selectedTrackId: null,
      sketchingBeatbox: {},
      refresh: vi.fn(async () => {}),
      exec: vi.fn(async (command: string): Promise<CommandResult> => {
        if (command === "list_directory") return { ok: true, command, data: listing };
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    bridge.pickFiles.mockReset();
    bridge.pickFiles.mockResolvedValue({ ok: false, files: [] });
    bridge.addSampleFolder.mockReset();
    bridge.addSampleFolder.mockResolvedValue({ ok: false });
  });

  it("explains the native cap instead of silently hiding a large folder's tail", async () => {
    await act(async () => { root.render(React.createElement(SampleBrowser)); });
    await act(async () => {});

    const notice = host.querySelector('[data-testid="sample-browser-limit"]');
    expect(notice).not.toBeNull();
    if (!notice) throw new Error("Sample browser limit notice is missing");
    expect(notice.textContent).toContain("first 512 items");
    expect(notice.textContent).toContain("narrower folder");
  });

  it("imports external samples through the macOS picker only after an explicit click", async () => {
    // Given: the browser is open and the producer has not requested external files.
    bridge.pickFiles.mockResolvedValueOnce({ ok: true, files: ["/picked/kick.wav", "/picked/snare.aif"] });
    await act(async () => { root.render(React.createElement(SampleBrowser)); });
    await act(async () => {});
    expect(bridge.pickFiles).not.toHaveBeenCalled();

    // When: the producer chooses the external-files action.
    const choose = host.querySelector<HTMLButtonElement>('[data-testid="sample-browser-choose-files"]');
    expect(choose).not.toBeNull();
    await act(async () => { choose?.click(); });

    // Then: the native picker supplies the paths and imports each selected sample.
    expect(bridge.pickFiles).toHaveBeenCalledWith({
      multiple: true,
      filters: "*.wav;*.aif;*.aiff;*.flac;*.mp3;*.ogg",
      title: "Choose audio files",
    });
    expect(useStore.getState().exec).toHaveBeenCalledWith("import_clip", { file: "/picked/kick.wav", trackId: undefined });
    expect(useStore.getState().exec).toHaveBeenCalledWith("import_clip", { file: "/picked/snare.aif", trackId: undefined });
  });

  it("adds a persistent sample folder only after an explicit click", async () => {
    bridge.addSampleFolder.mockResolvedValueOnce({ ok: true, path: "/picked/Samples", name: "Samples" });
    await act(async () => { root.render(React.createElement(SampleBrowser)); });
    await act(async () => {});
    expect(bridge.addSampleFolder).not.toHaveBeenCalled();

    const add = host.querySelector<HTMLButtonElement>('[data-testid="sample-browser-add-folder"]');
    expect(add).not.toBeNull();
    await act(async () => { add?.click(); });

    expect(bridge.addSampleFolder).toHaveBeenCalledOnce();
    expect(useStore.getState().exec).toHaveBeenCalledWith(
      "list_directory", { path: "/picked/Samples" });
  });
});
