import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppV3 } from "./AppV3";
import { useSettings } from "../settings/store";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, isNative: () => false };
});

describe("v3 shell colorway", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useSettings.getState().set("colorway", "violet");
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("writes data-colorway on the shell", () => {
    act(() => root.render(React.createElement(AppV3)));
    const shell = host.querySelector("[data-testid=v3-shell]");
    expect(shell?.getAttribute("data-colorway")).toBe("violet");
  });
});
