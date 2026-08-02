import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SampleBrowser } from "./SampleBrowser";
import { useStore } from "../store";
import type { CommandResult, DirListing } from "../types";

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
  });

  it("explains the native cap instead of silently hiding a large folder's tail", async () => {
    await act(async () => { root.render(React.createElement(SampleBrowser)); });
    await act(async () => {});

    const notice = host.querySelector('[data-testid="sample-browser-limit"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("first 512 items");
    expect(notice!.textContent).toContain("narrower folder");
  });
});
