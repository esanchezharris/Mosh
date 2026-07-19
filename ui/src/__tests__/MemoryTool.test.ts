// AGT-MEM (M3) — the memory panel (MemoryTool/MemoryBody in TopbarTools.tsx). Mirrors
// CommandLogTool.test.ts's real-DOM + act() harness: drive useStore.exec directly (no
// bridge.mock dependency) so this stays a fast, isolated component test.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTool } from "../ui/TopbarTools";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import type { CommandResult, Snapshot } from "../types";

type ExecFn = (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;

const snap = (editFile = ""): Snapshot => ({
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
});

describe("MemoryTool — the memory panel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let execCalls: { command: string; args?: Record<string, unknown> }[];
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    useSettings.getState().set("agentMemory", true);
    useStore.setState({ snapshot: snap() });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    consoleError.mockRestore();
  });

  function setExec(fn: ExecFn) {
    useStore.setState({ exec: vi.fn(fn) });
  }

  async function openPanel() {
    await act(async () => {
      root.render(React.createElement(MemoryTool));
    });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="What Moshi remembers"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {}); // flush the four agent_memory_read continuations
  }

  it("does not render at all when the agentMemory flag is off", async () => {
    useSettings.getState().set("agentMemory", false);
    await act(async () => {
      root.render(React.createElement(MemoryTool));
    });
    expect(host.querySelector('button[aria-label="What Moshi remembers"]')).toBeNull();
  });

  it("opening the panel reads all four tiers (3 global kinds + project)", async () => {
    setExec(async (command, args) => {
      execCalls.push({ command, args });
      return { ok: true, command, data: { items: [] } };
    });

    await openPanel();

    const reads = execCalls.filter((c) => c.command === "agent_memory_read");
    expect(reads).toHaveLength(4);
    expect(reads.map((r) => r.args?.kind)).toEqual(
      expect.arrayContaining(["preference", "drum_pattern", "lyric_framework", undefined]),
    );
    expect(reads.every((r) => r.args?.scope === "global" || r.args?.scope === "project")).toBe(true);
  });

  it("renders items newest-first order as returned, with an explicit badge and item text", async () => {
    setExec(async (command, args) => {
      if (command === "agent_memory_read" && args?.scope === "global" && args?.kind === "preference") {
        return {
          ok: true, command,
          data: { items: [{ ts: 2, kind: "preference", explicit: true, item: "heavy 808s" }, { ts: 1, kind: "preference", explicit: false, item: "wide low end" }] },
        };
      }
      return { ok: true, command, data: { items: [] } };
    });

    await openPanel();

    const tier = host.querySelector('[data-testid="memory-tier-preference"]');
    expect(tier).not.toBeNull();
    const text = tier!.textContent ?? "";
    expect(text).toContain("heavy 808s");
    expect(text).toContain("wide low end");
    expect(text).toContain("★"); // the explicit badge
    // the explicit item is listed first (server already returns newest-first; the panel
    // must not re-sort/reverse it)
    const firstRow = tier!.querySelector(".mem-item-row");
    expect(firstRow?.textContent).toContain("heavy 808s");
  });

  it("clicking Forget on an item calls agent_memory_delete with its exact ts and reloads", async () => {
    let deleted: Record<string, unknown> | undefined;
    let readCount = 0;
    setExec(async (command, args) => {
      if (command === "agent_memory_delete") { deleted = args; return { ok: true, command, data: { count: 0 } }; }
      if (command === "agent_memory_read" && args?.scope === "global" && args?.kind === "preference") {
        readCount++;
        const items = readCount === 1 ? [{ ts: 42, kind: "preference", explicit: false, item: "leans on triplets" }] : [];
        return { ok: true, command, data: { items } };
      }
      return { ok: true, command, data: { items: [] } };
    });

    await openPanel();
    const forgetBtn = host.querySelector<HTMLButtonElement>('[data-testid="memory-tier-preference"] .mem-del');
    expect(forgetBtn).not.toBeNull();
    await act(async () => { forgetBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => {});

    expect(deleted).toEqual({ scope: "global", kind: "preference", ts: 42 });
    // reloaded — the tier is now empty
    const tier = host.querySelector('[data-testid="memory-tier-preference"]');
    expect(tier?.textContent).toContain("nothing yet");
  });

  it("Clear opens a confirm dialog; confirming calls agent_memory_clear and cancelling does not", async () => {
    let cleared: Record<string, unknown> | undefined;
    setExec(async (command, args) => {
      if (command === "agent_memory_clear") { cleared = args; return { ok: true, command, data: { cleared: 1 } }; }
      if (command === "agent_memory_read" && args?.scope === "global" && args?.kind === "drum_pattern") {
        return { ok: true, command, data: { items: [{ ts: 1, kind: "drum_pattern", explicit: true, item: "boom-bap" }] } };
      }
      return { ok: true, command, data: { items: [] } };
    });

    await openPanel();
    const clearBtn = host.querySelector<HTMLButtonElement>('[data-testid="memory-tier-drum_pattern"] .mem-clear');
    expect(clearBtn).not.toBeNull();

    // cancel first — must NOT call agent_memory_clear
    await act(async () => { clearBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const cancelBtn = host.querySelector<HTMLButtonElement>('.modal-backdrop button:not([data-testid])');
    await act(async () => { cancelBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(cleared).toBeUndefined();
    expect(host.querySelector(".modal-backdrop")).toBeNull();

    // now confirm
    await act(async () => { clearBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const confirmBtn = host.querySelector<HTMLButtonElement>('[data-testid="memory-clear-confirm-confirm"]');
    expect(confirmBtn).not.toBeNull();
    await act(async () => { confirmBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => {});

    expect(cleared).toEqual({ scope: "global", kind: "drum_pattern" });
  });

  it("offers a project-path copy action only once an edit file exists", async () => {
    setExec(async (command) => ({ ok: true, command, data: { items: [] } }));
    useStore.setState({ snapshot: snap("") });

    await openPanel();
    expect(host.textContent).not.toContain("Copy this project's memory path");
    expect(host.textContent).toContain("Copy global memory path");

    act(() => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({ snapshot: snap("/Users/e/Music/song.mosh") });
    await openPanel();
    expect(host.textContent).toContain("Copy this project's memory path");
  });
});
