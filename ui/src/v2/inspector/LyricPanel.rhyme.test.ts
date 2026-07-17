// The Lyrics tab's rhyme tool (RhymeTool) — the failed-lookup error state. A get_rhymes
// failure reuses the faint .rack-empty class and, without a role, is silent to assistive
// tech (unlike the top-level v2-errbar). Asserts it announces via role="alert" — the
// shell's error convention, matching how status surfaces announce via role="status".

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LyricPanel } from "./LyricPanel";
import { useStore } from "../../store";
import type { CommandResult, LyricSheet, Track } from "../../types";

function sheet(): LyricSheet {
  return {
    id: "ls1", grid: "1/8", language: "en", topic: "", mood: "",
    explicit: "allow", rhymeStrictness: "slant", specVersion: 1, lines: [],
  };
}
function track(): Track {
  return { id: "t1", index: 0, name: "Vocals", type: "audio",
    volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
    lyricSheet: sheet() } as unknown as Track;
}

// Bypass React's controlled-input value tracker so an onChange fires (the fireEvent trick).
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("v2 RhymeTool error announcement", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      exec: vi.fn(async (command: string): Promise<CommandResult> =>
        command === "get_rhymes" ? { ok: false, command, error: "boom" } : { ok: true, command }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("announces a failed get_rhymes as role=alert with the error text", async () => {
    act(() => { root.render(React.createElement(LyricPanel, { track: track() })); });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Rhyme word"]')!;
    expect(input).not.toBeNull();
    act(() => typeInto(input, "flame"));
    const go = host.querySelector<HTMLButtonElement>('[data-testid="rhyme-go"]')!;
    expect(go).not.toBeNull();
    await act(async () => { go.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const err = host.querySelector('[data-testid="rhyme-error"]');
    expect(err).not.toBeNull();
    expect(err!.getAttribute("role")).toBe("alert");
    expect(err!.textContent).toBe("boom");
  });
});
