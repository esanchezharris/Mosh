import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryFlyout } from "./HistoryFlyout";
import { historyRows } from "../ui/commandLogHistory";
import { useV3 } from "./shellState";
import { useStore } from "../store";
import type { CommandLog, CommandResult } from "../types";
import { escapeStackDepth, pushEscapeHandler } from "../hooks/escapeStack";

const log: CommandLog = {
  entries: [
    { command: "set_track_volume", ok: true, undoable: true, ts: 1_700_000_100_000, txn: "s:2" },
    { command: "add_track", ok: true, undoable: true, ts: 1_700_000_000_000, txn: "s:1" },
  ],
  total: 2,
  currentTxn: "s:2",
  restorableTxns: ["s:1", "s:2"],
};

describe("v3 History flyout", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalExec = useStore.getState().exec;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useV3.setState({ historyOpen: true });
    useStore.setState({
      exec: vi.fn(async (command: string): Promise<CommandResult> => {
        if (command === "get_command_log") return { ok: true, command, data: log };
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useV3.setState({ historyOpen: false });
    useStore.setState({ exec: originalExec });
    expect(escapeStackDepth()).toBe(0);
  });

  it("renders historyRows from the command log", async () => {
    await act(async () => {
      root.render(React.createElement(HistoryFlyout));
      await Promise.resolve();
      await Promise.resolve();
    });
    const rows = historyRows(log);
    expect(host.querySelector('[data-testid="v3-history-flyout"]')).not.toBeNull();
    expect(host.textContent).toContain(rows[0]!.entry.command);
    expect(host.textContent).toContain("Cmd+Z · click older");
    expect(host.querySelector('[data-testid="v3-history-undo"]')).not.toBeNull();
  });

  it("dismisses History when Escape is pressed", async () => {
    await act(async () => root.render(React.createElement(HistoryFlyout)));

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(useV3.getState().historyOpen).toBe(false);
    expect(host.querySelector('[data-testid="v3-history-flyout"]')).toBeNull();
  });

  it("leaves a newer overlay above History after the command log arrives", async () => {
    let resolveLog: (result: CommandResult) => void = () => { throw new Error("History load did not start"); };
    useStore.setState({ exec: () => new Promise((resolve) => { resolveLog = resolve; }) });
    act(() => root.render(React.createElement(HistoryFlyout)));
    const upperClose = vi.fn();
    const pop = pushEscapeHandler(upperClose);
    await act(async () => resolveLog({ ok: true, command: "get_command_log", data: log }));

    try {
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

      expect(upperClose).toHaveBeenCalledOnce();
      expect(useV3.getState().historyOpen).toBe(true);
    } finally {
      pop();
    }
  });
});
