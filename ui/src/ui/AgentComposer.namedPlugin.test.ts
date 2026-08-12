import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { AgentComposer } from "./AgentComposer";

const { brainSend } = vi.hoisted(() => ({
  brainSend: vi.fn(async () => ({
    intent: "ACK_GOT_IT",
    say: "listed available plugins",
    commands: [{ command: "list_plugins", args: {} }],
  })),
}));

vi.mock("../agent/brain", () => ({
  createBrain: () => ({ send: brainSend }),
}));

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
    brainSend.mockClear();
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
    expect(brainSend).not.toHaveBeenCalled();
  });

  it("fails closed for an unsupported ask instead of invoking the free-form brain", async () => {
    const input = host.querySelector<HTMLInputElement>("[data-testid=agent-input]");
    const send = host.querySelector<HTMLButtonElement>("[data-testid=agent-send]");
    if (!input || !send) throw new Error("Ask Moshi controls are missing");

    act(() => setInputValue(input, "make the whole mix warmer"));
    await act(async () => send.click());

    expect(exec.mock.calls.map(([command]) => command)).toEqual(["batch_begin", "batch_end"]);
    expect(host.querySelector("[role=status]")?.textContent).toBe("I can't do that reliably yet");
    expect(brainSend).not.toHaveBeenCalled();
  });
});
