import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { MoshiChanges } from "./MoshiChanges";

describe("classic agent change review", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      agentChangeSet: {
        label: "turn the vocal up",
        entries: [{ index: 0, command: "set_track_gain", summary: "Set Vocal gain", ok: true }],
        applied: 1,
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ agentChangeSet: null });
  });

  it("exposes a Moshi-labelled change review that can be kept", () => {
    act(() => root.render(React.createElement(MoshiChanges)));

    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toMatch(/\bMoshi\b/);
    expect(dialog?.textContent).toMatch(/\bMoshi\b/);

    const keep = dialog?.querySelector<HTMLButtonElement>('[data-testid="moshi-changes-keep"]');
    act(() => keep?.click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
