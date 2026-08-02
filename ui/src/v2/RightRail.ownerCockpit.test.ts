import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ping } from "../bridge";
import { ownerCockpitRuntime } from "../agent/ownerCockpitRuntime";
import { useShell } from "./shellState";
import { RightRail } from "./RightRail";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, ping: vi.fn() };
});

describe("v2 RightRail owner handoff bootstrap", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useShell.setState({ rightOpen: false });
    vi.mocked(ping).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("resumes an installed repair exactly once while the rail remains collapsed", async () => {
    vi.mocked(ping).mockResolvedValue({
      ok: true,
      app: "Mosh",
      version: "test",
      stage: 0,
      backend: "native",
      repairSourceSha: "0123456789abcdef0123456789abcdef01234567",
      repairId: "repair-1",
    });
    const resume = vi.spyOn(ownerCockpitRuntime, "resumeInstalledRepairSession")
      .mockResolvedValue(undefined);

    await act(async () => {
      root.render(React.createElement(RightRail));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="v2-right-pull"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v2-rail"]')).toBeNull();
    expect(ping).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("repair-1");

    await act(async () => {
      root.render(React.createElement(RightRail));
      await Promise.resolve();
    });
    expect(ping).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("surfaces a native launch-identity outage while collapsed", async () => {
    vi.mocked(ping).mockRejectedValue(new Error("Native repair identity unavailable"));
    const surface = vi.spyOn(ownerCockpitRuntime, "surfaceStartupOutage");

    await act(async () => {
      root.render(React.createElement(RightRail));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="v2-right-pull"]')).not.toBeNull();
    expect(surface).toHaveBeenCalledWith(expect.objectContaining({
      message: "Native repair identity unavailable",
    }));
    expect(ownerCockpitRuntime.getSnapshot()).toMatchObject({
      status: "outage",
      error: "Native repair identity unavailable",
    });
  });
});
