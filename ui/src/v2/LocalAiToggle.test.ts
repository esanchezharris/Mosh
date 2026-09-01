import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainRuntimeStatus } from "../bridge";
import { LocalAiToggle } from "./LocalAiToggle";

const start = vi.fn(async () => undefined);
const stop = vi.fn(async () => undefined);
let status: BrainRuntimeStatus = { configured: true, state: "off" };

vi.mock("../hooks/useBrainRuntime", () => ({
  useBrainRuntime: () => ({ status, start, stop }),
}));

describe("LOCAL AI top-bar control", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    status = { configured: true, state: "off" };
    start.mockClear();
    stop.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = () => act(() => root.render(React.createElement(LocalAiToggle)));
  const button = () => host.querySelector<HTMLButtonElement>('button[aria-label="Local AI"]');

  it.each([
    ["off", "false", false],
    ["starting", "false", true],
    ["ready", "true", false],
    ["stopping", "false", true],
    ["error", "false", false],
  ] as const)("renders %s with accessible pressed and transition state", (state, pressed, disabled) => {
    status = { configured: true, state };
    render();
    expect(button()?.textContent).toContain("LOCAL AI");
    expect(button()?.getAttribute("aria-pressed")).toBe(pressed);
    expect(button()?.disabled).toBe(disabled);
    expect(button()?.dataset.state).toBe(state);
  });

  it("starts while off and stops while on without repeated transition clicks", () => {
    render();
    act(() => button()?.click());
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    status = { configured: true, state: "ready" };
    render();
    act(() => button()?.click());
    expect(stop).toHaveBeenCalledTimes(1);

    status = { configured: true, state: "starting" };
    render();
    act(() => button()?.click());
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("surfaces runtime errors in the tooltip", () => {
    status = { configured: true, state: "error", error: "Port 8091 is already in use" };
    render();
    expect(button()?.title).toBe("Port 8091 is already in use");
  });

  it("is disabled when the local runtime is not configured", () => {
    status = { configured: false, state: "unavailable", error: "Local AI is not configured" };
    render();
    expect(button()?.disabled).toBe(true);
    expect(button()?.getAttribute("aria-pressed")).toBe("false");
  });
});
