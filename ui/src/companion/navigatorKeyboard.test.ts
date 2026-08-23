import { beforeEach, describe, expect, it } from "vitest";
import type { ControllerView } from "./adapter";
import { element } from "./dom";
import { NavigatorKeyboardController } from "./navigatorKeyboard";

const abletonView: ControllerView = {
  mode: "ableton",
  unit: "beats",
  revision: 8,
  position: 6,
  length: 12,
  regions: [],
  statuses: ["pending"],
  seekEnabled: true,
};

const moshView: ControllerView = {
  mode: "mosh",
  unit: "seconds",
  revision: 3,
  position: 30,
  length: 60,
  regions: [],
  statuses: ["paused"],
  seekEnabled: true,
};

function keydown(bar: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  bar.dispatchEvent(event);
  return event;
}

describe("NavigatorKeyboardController", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="nav"></div>';
  });

  it("seeks Ableton one beat backward with ArrowLeft", () => {
    // Given
    const fractions: number[] = [];
    const bar = element("nav");
    const keyboard = new NavigatorKeyboardController(bar, {
      current: () => abletonView,
      seek: (fraction) => fractions.push(fraction),
    });
    keyboard.attach();

    // When
    const event = keydown(bar, "ArrowLeft");

    // Then
    expect(fractions).toEqual([5 / 12]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("seeks Ableton one beat forward with ArrowRight", () => {
    // Given
    const fractions: number[] = [];
    const bar = element("nav");
    const keyboard = new NavigatorKeyboardController(bar, {
      current: () => abletonView,
      seek: (fraction) => fractions.push(fraction),
    });
    keyboard.attach();

    // When
    const event = keydown(bar, "ArrowRight");

    // Then
    expect(fractions).toEqual([7 / 12]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("seeks Mosh to the timeline start with Home", () => {
    // Given
    const fractions: number[] = [];
    const bar = element("nav");
    const keyboard = new NavigatorKeyboardController(bar, {
      current: () => moshView,
      seek: (fraction) => fractions.push(fraction),
    });
    keyboard.attach();

    // When
    keydown(bar, "Home");

    // Then
    expect(fractions).toEqual([0]);
  });

  it("seeks Mosh to the timeline end with End", () => {
    // Given
    const fractions: number[] = [];
    const bar = element("nav");
    const keyboard = new NavigatorKeyboardController(bar, {
      current: () => moshView,
      seek: (fraction) => fractions.push(fraction),
    });
    keyboard.attach();

    // When
    keydown(bar, "End");

    // Then
    expect(fractions).toEqual([1]);
  });

  it("does not seek when the current view disables seeking", () => {
    // Given
    const fractions: number[] = [];
    const bar = element("nav");
    const keyboard = new NavigatorKeyboardController(bar, {
      current: () => ({ ...abletonView, seekEnabled: false }),
      seek: (fraction) => fractions.push(fraction),
    });
    keyboard.attach();

    // When
    const event = keydown(bar, "ArrowRight");

    // Then
    expect(fractions).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});
