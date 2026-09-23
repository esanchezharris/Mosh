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

  // Review fix 5: the fallback now shows in every shell, on top of `body { background: var(--ink) }`,
  // which is near-white in the light theme. With a transparent container the #eaeaea heading and
  // the transparent "Reload interface" button were close to invisible there. The fallback paints
  // its own opaque ground so its colours read the same in both themes.
  const rgb = (css: string): [number, number, number] => {
    const m = css.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    if (!m) throw new Error(`not an opaque rgb() colour: "${css}"`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const luminance = ([r, g, b]: [number, number, number]) => {
    const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it("paints its own opaque ground, with readable text and buttons on it in either theme", () => {
    act(() => root.render(React.createElement(ErrorBoundary, { onReload: vi.fn() }, React.createElement(Flaky))));
    const box = host.querySelector<HTMLElement>('[data-testid="ui-error-boundary"]')!;
    const ground = box.style.backgroundColor;
    expect(ground, "an opaque background on the container itself").toMatch(/^rgb\(/);
    expect(box.style.minHeight, "it covers the window, not just its own text").toBe("100vh");
    expect(contrast(box.style.color, ground)).toBeGreaterThanOrEqual(7);
    const reload = buttonNamed("Reload interface")!;
    // a transparent button shows the container's ground behind its text
    const reloadGround = reload.style.backgroundColor === "transparent" ? ground : reload.style.backgroundColor;
    expect(contrast(reload.style.color, reloadGround)).toBeGreaterThanOrEqual(7);
    const retry = buttonNamed("Try again")!;
    expect(contrast(retry.style.color, retry.style.backgroundColor)).toBeGreaterThanOrEqual(7);
  });
});
