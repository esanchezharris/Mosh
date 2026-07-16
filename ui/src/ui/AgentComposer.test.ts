import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { AgentComposer, type AgentTalkTargetProps } from "./AgentComposer";

const agentMocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({ intent: "ACK_GOT_IT", say: "on it", commands: [] })),
}));

vi.mock("../agent/brain", () => ({ createBrain: () => ({ send: agentMocks.send }) }));

class SpeechRecognitionStub {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
}

describe("AgentComposer talk target", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    agentMocks.send.mockClear();
    useStore.setState({ agentBusy: false, agentListening: false, handsFreeOn: false });
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: SpeechRecognitionStub });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(window, "webkitSpeechRecognition");
    vi.restoreAllMocks();
  });

  it("keeps the default mic when no talk target is supplied", () => {
    act(() => root.render(React.createElement(AgentComposer)));
    expect(host.querySelector('[data-testid="agent-mic"]')).not.toBeNull();
  });

  it("renders the v3 talk target and stops listening on pointer cancellation", () => {
    const renderTalkTarget = (props: AgentTalkTargetProps) => React.createElement("button", {
      "data-testid": "custom-talk",
      "data-listening": String(props.listening),
      onPointerDown: props.onPointerDown,
      onPointerUp: props.onPointerUp,
      onPointerCancel: props.onPointerCancel,
    });
    act(() => root.render(React.createElement(AgentComposer, { renderTalkTarget })));
    const target = host.querySelector<HTMLButtonElement>('[data-testid="custom-talk"]');
    if (!target) throw new TypeError("custom talk target did not render");
    act(() => target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 9 })));
    expect(target.dataset.listening).toBe("true");
    act(() => target.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 9 })));
    expect(target.dataset.listening).toBe("false");
    expect(useStore.getState().agentListening).toBe(false);
  });

  it("submits typed text through the existing brain funnel", async () => {
    act(() => root.render(React.createElement(AgentComposer)));
    const input = host.querySelector<HTMLInputElement>('[data-testid="agent-input"]');
    if (!input) throw new TypeError("agent input did not render");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "paint it ultraviolet");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(agentMocks.send).toHaveBeenCalledWith("paint it ultraviolet");
  });
});
