import { describe, it, expect, vi } from "vitest";
import { pushEscapeHandler, escapeStackDepth } from "./escapeStack";

// The bug (AL-001): every overlay registered its own window-level keydown
// listener, so one Escape press closed EVERY open overlay at once. The shared
// escape stack must route a single Escape to ONLY the topmost overlay and leave
// the lower ones untouched. Each test unregisters its own handlers, leaving the
// stack empty for the next one.

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

describe("escapeStack", () => {
  it("closes only the topmost overlay on Escape", () => {
    const closeLower = vi.fn();
    const closeUpper = vi.fn();

    const offLower = pushEscapeHandler(closeLower);
    const offUpper = pushEscapeHandler(closeUpper);

    pressEscape();

    expect(closeUpper).toHaveBeenCalledTimes(1);
    expect(closeLower).not.toHaveBeenCalled();

    offUpper();
    offLower();
  });

  it("falls through to the next overlay once the top is unregistered", () => {
    const closeLower = vi.fn();
    const closeUpper = vi.fn();

    const offLower = pushEscapeHandler(closeLower);
    const offUpper = pushEscapeHandler(closeUpper);

    // Simulate the upper overlay closing (its hook tears down).
    offUpper();

    pressEscape();

    expect(closeLower).toHaveBeenCalledTimes(1);

    offLower();
  });

  it("ignores non-Escape keys", () => {
    const close = vi.fn();
    const off = pushEscapeHandler(close);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(close).not.toHaveBeenCalled();
    off();
  });

  it("shields a legacy bubble-phase Escape listener while an overlay is on top", () => {
    // The PianoRoll keeps its own window-level (bubble-phase) keydown listener
    // for Delete/Backspace + Escape. When a stack-managed overlay opens on top
    // of it, that legacy listener must NOT also see the Escape — the stack's
    // capture-phase + stopPropagation has to win.
    const legacy = vi.fn();
    window.addEventListener("keydown", legacy); // bubble phase, like PianoRoll

    const closeTop = vi.fn();
    const off = pushEscapeHandler(closeTop);

    pressEscape();

    expect(closeTop).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled(); // shielded by the stack

    off();

    // With the stack empty, the legacy listener is reachable again.
    pressEscape();
    expect(legacy).toHaveBeenCalledTimes(1);

    window.removeEventListener("keydown", legacy);
  });

  it("removes the window listener when the stack empties", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const off = pushEscapeHandler(() => {});
    expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function), expect.anything());

    off();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function), expect.anything());
    expect(escapeStackDepth()).toBe(0);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
