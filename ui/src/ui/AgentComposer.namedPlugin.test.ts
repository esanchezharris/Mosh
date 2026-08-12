import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { AgentComposer } from "./AgentComposer";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/moshi-named-plugin.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{ id: "synth", index: 0, name: "Synth", type: "midi", clips: [] }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)?.set;

function setInputValue(input: HTMLInputElement, value: string): void {
  if (!nativeInputValueSetter) throw new Error("native input value setter is unavailable");
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AgentComposer named plug-in skill", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: true,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => {
      if (command === "list_plugins") {
        return {
          ok: true,
          command,
          data: {
            plugins: [
              { id: "serum-1", name: "Serum", format: "VST3", manufacturer: "Xfer Records", isInstrument: true },
              { id: "serum-2", name: "Serum 2", format: "VST3", manufacturer: "Xfer Records", isInstrument: true },
              { id: "serum-2-fx", name: "Serum 2 FX", format: "VST3", manufacturer: "Xfer Records", isInstrument: false },
            ],
            counts: { vst3: 3, au: 0, total: 3 },
          },
        };
      }
      return { ok: true, command };
    });
    useStore.setState({
      snapshot: SNAPSHOT,
      projectEpoch: 7,
      selectedTrackId: "synth",
      agentBusy: false,
      agentChangeSet: null,
      exec,
      refresh: vi.fn(async () => {}),
    });
    act(() => root.render(React.createElement(AgentComposer)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      projectEpoch: originalState.projectEpoch,
      selectedTrackId: originalState.selectedTrackId,
      agentBusy: originalState.agentBusy,
      agentChangeSet: originalState.agentChangeSet,
      exec: originalState.exec,
      refresh: originalState.refresh,
    });
  });

  it("loads the unique exact Serum 2 match without asking the cloud brain for an id", async () => {
    const input = host.querySelector<HTMLInputElement>("[data-testid=agent-input]");
    const send = host.querySelector<HTMLButtonElement>("[data-testid=agent-send]");
    if (!input || !send) throw new Error("Ask Moshi controls are missing");

    act(() => setInputValue(input, "can you load serum 2?"));
    await act(async () => send.click());

    expect(exec).toHaveBeenCalledWith("list_plugins", {});
    expect(exec).toHaveBeenCalledWith("load_plugin", { trackId: "synth", pluginId: "serum-2" });
    expect(exec.mock.calls.map(([command]) => command)).toEqual([
      "list_plugins",
      "batch_begin",
      "load_plugin",
      "batch_end",
    ]);
    expect(host.querySelector("[role=status]")?.textContent).toBe("loaded Serum 2 on Synth");
  });

  it("keeps an ambiguous catalog choice and loads the numbered follow-up", async () => {
    exec.mockImplementation(async (command: string): Promise<CommandResult> => {
      if (command === "list_plugins") {
        return {
          ok: true,
          command,
          data: {
            plugins: [
              { id: "serum-au", name: "Serum 2", format: "AudioUnit", manufacturer: "Xfer Records", isInstrument: true },
              { id: "serum-vst3", name: "Serum 2", format: "VST3", manufacturer: "Xfer Records", isInstrument: true },
            ],
          },
        };
      }
      return { ok: true, command };
    });
    const input = host.querySelector<HTMLInputElement>("[data-testid=agent-input]");
    const send = host.querySelector<HTMLButtonElement>("[data-testid=agent-send]");
    if (!input || !send) throw new Error("Ask Moshi controls are missing");

    act(() => setInputValue(input, "load Serum 2"));
    await act(async () => send.click());
    expect(host.querySelector("[role=status]")?.textContent).toContain("choose 1–2");
    expect(exec.mock.calls.map(([command]) => command)).toEqual(["list_plugins"]);

    act(() => setInputValue(input, "2"));
    await act(async () => send.click());
    expect(exec).toHaveBeenCalledWith("load_plugin", { trackId: "synth", pluginId: "serum-vst3" });
    expect(host.querySelector("[role=status]")?.textContent).toBe("loaded Serum 2 on Synth");
  });

  it("fails closed for an unsupported ask instead of invoking the free-form brain", async () => {
    const input = host.querySelector<HTMLInputElement>("[data-testid=agent-input]");
    const send = host.querySelector<HTMLButtonElement>("[data-testid=agent-send]");
    if (!input || !send) throw new Error("Ask Moshi controls are missing");

    act(() => setInputValue(input, "make the whole mix warmer"));
    await act(async () => send.click());

    expect(exec.mock.calls.map(([command]) => command)).toEqual(["batch_begin", "batch_end"]);
    expect(host.querySelector("[role=status]")?.textContent).toBe("I can't do that reliably yet");
  });

  it("records a recognized but unavailable plug-in ask as unserved", async () => {
    exec.mockImplementation(async (command: string): Promise<CommandResult> => {
      if (command === "list_plugins") return { ok: true, command, data: { plugins: [] } };
      return { ok: true, command };
    });
    const input = host.querySelector<HTMLInputElement>("[data-testid=agent-input]");
    const send = host.querySelector<HTMLButtonElement>("[data-testid=agent-send]");
    if (!input || !send) throw new Error("Ask Moshi controls are missing");

    act(() => setInputValue(input, "load Omnisphere"));
    await act(async () => send.click());

    expect(exec.mock.calls.map(([command]) => command)).toEqual([
      "list_plugins",
      "batch_begin",
      "batch_end",
    ]);
    const begin = exec.mock.calls.find(([command]) => command === "batch_begin");
    expect(begin?.[1]).toMatchObject({
      utterance: "load Omnisphere",
      source: "studio_skill_blocked",
    });
    expect(host.querySelector("[role=status]")?.textContent).toContain("open Plug-in Manager or rescan");
  });
});
