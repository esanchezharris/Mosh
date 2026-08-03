// CONF-MASTER-VOL — the v2 master bus fader/pan. set_master_volume/set_master_pan
// existed natively (and agent-callable) with no UI surface anywhere in v2; MasterCard
// (in RightRail.tsx) is that surface. Pure command-surface assertions (store.exec) —
// no engine concepts leak. Rendered standalone (not the whole RightRail) to avoid
// pulling in Moshi's WebGL mount / video / multiplayer deps that live alongside it.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MasterCard } from "./RightRail";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";

// React wraps HTMLInputElement.prototype's value setter to track whether a subsequent
// native "input" event represents a real change. Route through the ORIGINAL
// (unwrapped) native setter so React sees the DOM value diverge from what it last
// tracked — exactly like a real drag (mirrors Inspector.clip.test.ts's helper).
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
function setInputValue(input: HTMLInputElement, value: string): void {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushRangeReconcile(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeSnapshot(master?: { volumeDb: number; pan: number }): Snapshot {
  return { schemaVersion: 1, session: {}, tracks: [], master } as unknown as Snapshot;
}

describe("v2 RightRail MasterCard", () => {
  let host: HTMLDivElement;
  let root: Root;
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(snap: Snapshot) {
    act(() => {
      useStore.setState({ snapshot: snap });
      root.render(React.createElement(MasterCard));
    });
  }

  it("reflects the snapshot's master volume and pan", () => {
    render(makeSnapshot({ volumeDb: -6, pan: 0.3 }));
    const vol = host.querySelector<HTMLInputElement>('[data-testid="v2-master-volume"]');
    const pan = host.querySelector<HTMLInputElement>('[data-testid="v2-master-pan"]');
    expect(vol!.value).toBe("-6");
    expect(pan!.value).toBe("0.3");
    expect(host.textContent).toContain("-6.0");
  });

  it("falls back to 0 dB / 0 pan when the snapshot carries no master field", () => {
    render(makeSnapshot(undefined));
    const vol = host.querySelector<HTMLInputElement>('[data-testid="v2-master-volume"]');
    const pan = host.querySelector<HTMLInputElement>('[data-testid="v2-master-pan"]');
    expect(vol!.value).toBe("0");
    expect(pan!.value).toBe("0");
  });

  it("dragging the volume slider execs set_master_volume with the new dB value", async () => {
    render(makeSnapshot({ volumeDb: 0, pan: 0 }));
    const vol = host.querySelector<HTMLInputElement>('[data-testid="v2-master-volume"]');
    act(() => setInputValue(vol!, "-9.5"));
    const call = execCalls.find((c) => c.command === "set_master_volume");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ db: -9.5 });
    await flushRangeReconcile();
  });

  it("keeps rapid native volume steps cumulative while the snapshot is stale", async () => {
    render(makeSnapshot({ volumeDb: 0, pan: 0 }));
    const vol = host.querySelector<HTMLInputElement>('[data-testid="v2-master-volume"]')!;

    // macOS AXIncrement/AXDecrement derives the next step from the range element's
    // current DOM value. A snapshot-controlled range used to snap back to 0 after
    // every event, so three decrements dispatched -0.5 three times instead of
    // continuing to -1 and -1.5 (#597).
    for (let i = 0; i < 3; i++) {
      act(() => setInputValue(vol, String(Number(vol.value) - 0.5)));
    }

    expect(execCalls.filter((c) => c.command === "set_master_volume").map((c) => c.args?.db))
      .toEqual([-0.5, -1, -1.5]);
    await flushRangeReconcile();
  });

  it("keeps rapid native pan steps cumulative while the snapshot is stale", async () => {
    render(makeSnapshot({ volumeDb: 0, pan: 0 }));
    const pan = host.querySelector<HTMLInputElement>('[data-testid="v2-master-pan"]')!;
    for (let i = 0; i < 3; i++) {
      act(() => setInputValue(pan, String(Number(pan.value) - 0.02)));
    }
    expect(execCalls.filter((c) => c.command === "set_master_pan").map((c) => c.args?.pan))
      .toEqual([-0.02, -0.04, -0.06]);
    await flushRangeReconcile();
  });
});
