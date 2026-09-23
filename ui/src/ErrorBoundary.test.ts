import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

// The root boundary (main.tsx) is the last thing between one component's render error and
// a blank window. On a live screen share the old one printed a raw stack and offered no
// way back; this pins the friendly copy, the two ways out, and the stack kept out of sight.

let shouldThrow = true;
function Flaky() {
  if (shouldThrow) throw new Error("render exploded in a child");
  return React.createElement("p", { "data-testid": "child-ok" }, "child rendered");
}

describe("ErrorBoundary — a render error never blanks the window", () => {
  let host: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    shouldThrow = true;
    // React reports every caught render error to console.error; keep the run quiet.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    consoleError.mockRestore();
  });

  const buttonNamed = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;

  it("renders its children untouched when nothing throws", () => {
    shouldThrow = false;
    act(() => root.render(React.createElement(ErrorBoundary, null, React.createElement(Flaky))));
    expect(host.querySelector('[data-testid="child-ok"]')).not.toBeNull();
    expect(buttonNamed("Try again")).toBeNull();
    expect(buttonNamed("Reload interface")).toBeNull();
  });

  it("shows friendly copy, Try again, Reload interface, and keeps the stack in a collapsed <details>", () => {
    const onReload = vi.fn();
    act(() => root.render(React.createElement(ErrorBoundary, { onReload }, React.createElement(Flaky))));

    expect(host.querySelector('[data-testid="child-ok"]')).toBeNull();
    expect(host.textContent).toContain("Something in the interface broke — your session is safe; the engine keeps it.");
    const retry = buttonNamed("Try again");
    const reload = buttonNamed("Reload interface");
    expect(retry, "the primary action").not.toBeNull();
    expect(reload).not.toBeNull();

    // The stack is present for diagnosis but NOT on screen until asked for.
    const details = host.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.textContent).toContain("render exploded in a child");
    // …and nowhere outside the <details>: no raw <pre> in the main body.
    const outside = [...host.querySelectorAll("pre")].filter((pre) => !details!.contains(pre));
    expect(outside).toHaveLength(0);

    expect(onReload).not.toHaveBeenCalled();
    act(() => reload!.click());
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("Try again re-mounts the children once the cause is gone", () => {
    act(() => root.render(React.createElement(ErrorBoundary, { onReload: vi.fn() }, React.createElement(Flaky))));
    expect(buttonNamed("Try again")).not.toBeNull();

    shouldThrow = false;
    act(() => buttonNamed("Try again")!.click());
    expect(host.querySelector('[data-testid="child-ok"]')).not.toBeNull();
    expect(buttonNamed("Try again")).toBeNull();
  });

  it("Try again with the cause still present lands back on the error screen, not a blank one", () => {
    act(() => root.render(React.createElement(ErrorBoundary, { onReload: vi.fn() }, React.createElement(Flaky))));
    act(() => buttonNamed("Try again")!.click());
    expect(host.querySelector('[data-testid="child-ok"]')).toBeNull();
    expect(buttonNamed("Try again")).not.toBeNull();
    expect(buttonNamed("Reload interface")).not.toBeNull();
  });
});
