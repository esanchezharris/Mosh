import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconciledRange } from "./ReconciledRange";
import type { CommandResult } from "../types";

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
function setInputValue(input: HTMLInputElement, value: number): void {
  nativeInputValueSetter.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ReconciledRange", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("keeps rapid native steps local until every command settles, then adopts the refreshed value", async () => {
    const commits = [deferred<CommandResult>(), deferred<CommandResult>(), deferred<CommandResult>()];
    const sent: number[] = [];
    const reconcile = vi.fn(async () => -1.5);
    act(() => {
      root.render(React.createElement(ReconciledRange, {
        min: -48, max: 6, step: 0.5, value: 0,
        onCommit: (next) => { sent.push(next); return commits[sent.length - 1].promise; },
        reconcile,
      }));
    });
    const input = host.querySelector("input")!;

    for (let i = 0; i < 3; i++) act(() => setInputValue(input, Number(input.value) - 0.5));
    expect(sent).toEqual([-0.5, -1, -1.5]);
    expect(input.value).toBe("-1.5");

    await act(async () => {
      commits.forEach((pending) => pending.resolve({ ok: true, command: "set_master_volume" }));
      await Promise.all(commits.map((pending) => pending.promise));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("-1.5");
  });

  it("rolls back to the authoritative value after a failed command", async () => {
    const reconcile = vi.fn(async () => -6);
    act(() => {
      root.render(React.createElement(ReconciledRange, {
        min: -48, max: 6, step: 0.5, value: -6,
        onCommit: async () => ({ ok: false, command: "set_master_volume", error: "rejected" }),
        reconcile,
      }));
    });
    const input = host.querySelector("input")!;

    await act(async () => {
      setInputValue(input, -5.5);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("-6");
  });

  it("does not let an intermediate snapshot overwrite the gesture, but adopts it after reconciliation", async () => {
    const pending = deferred<CommandResult>();
    const commit = vi.fn(() => pending.promise);
    const reconcile = vi.fn(async () => -0.25);
    act(() => {
      root.render(React.createElement(ReconciledRange, {
        min: -48, max: 6, step: 0.5, value: 0, onCommit: commit, reconcile,
      }));
    });
    const input = host.querySelector("input")!;
    act(() => setInputValue(input, -0.5));

    act(() => {
      root.render(React.createElement(ReconciledRange, {
        min: -48, max: 6, step: 0.5, value: -0.25, onCommit: commit, reconcile,
      }));
    });
    expect(input.value).toBe("-0.5");

    await act(async () => {
      pending.resolve({ ok: true, command: "set_master_volume" });
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input.value).toBe("-0.25");
  });

  it("accepts external snapshot and undo changes while idle", () => {
    const commit = vi.fn(async () => ({ ok: true, command: "set_master_volume" }));
    const reconcile = vi.fn(async () => -3);
    act(() => {
      root.render(React.createElement(ReconciledRange, {
        min: -48, max: 6, step: 0.5, value: -3, onCommit: commit, reconcile,
      }));
    });
    const input = host.querySelector("input")!;
    expect(input.value).toBe("-3");

    act(() => {
      root.render(React.createElement(ReconciledRange, {
        min: -48, max: 6, step: 0.5, value: -9, onCommit: commit, reconcile,
      }));
    });
    expect(input.value).toBe("-9");
    expect(commit).not.toHaveBeenCalled();
  });
});
