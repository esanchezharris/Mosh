// AL-019 — CommandLogTool must not load the command log as a render-time side
// effect. The load (which calls setLoading/setLog) has to run from an effect, not
// from inside the Pop children render function. These specs open the popover and
// assert (1) React never warns about a setState-during-render, and (2) a failed
// load recovers cleanly to the empty state instead of getting stuck on "Loading…".

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandLogTool } from "../ui/TopbarTools";
import { useStore } from "../store";
import type { CommandResult } from "../types";

type ExecFn = (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;

describe("CommandLogTool — no render-time side effects (AL-019)", () => {
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
    // Capture (and silence) React dev warnings so we can assert on them.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  function setExec(fn: ExecFn) {
    useStore.setState({ exec: vi.fn(fn) });
  }

  async function openLog() {
    await act(async () => {
      root.render(React.createElement(CommandLogTool));
    });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Command log"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Flush the async load() continuation (exec promise → setLoading(false)).
    await act(async () => {});
  }

  it("opening the log loads via get_command_log without a setState-during-render warning", async () => {
    setExec(async (command, args) => {
      execCalls.push({ command, args });
      return { ok: true, command, data: { entries: [], total: 0 } };
    });

    await openLog();

    expect(execCalls.some((c) => c.command === "get_command_log")).toBe(true);
    const renderWarning = consoleError.mock.calls.find((c) =>
      String(c[0]).includes("while rendering a different component"),
    );
    expect(renderWarning).toBeUndefined();
  });

  it("recovers to the empty state when the load fails (loading-failure path)", async () => {
    setExec(async (command, args) => {
      execCalls.push({ command, args });
      return { ok: false, command, error: "boom" };
    });

    await openLog();

    expect(execCalls.some((c) => c.command === "get_command_log")).toBe(true);
    const note = host.querySelector(".pop-note")?.textContent ?? "";
    expect(note).not.toContain("Loading");
    const list = host.querySelector('[data-testid="command-log"]')?.textContent ?? "";
    expect(list).toContain("no commands yet");
  });
});
