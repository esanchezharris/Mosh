import { beforeEach, describe, expect, it } from "vitest";
import { NavigatorDragController } from "./navigatorDrag";

function pointerEvent(type: string, pointerId: number, clientX: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
  });
  return event;
}

function requiredElement(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found;
}

function navigatorDom() {
  const bar = document.createElement("div");
  bar.id = "nav";
  const playhead = document.createElement("div");
  playhead.id = "playhead";
  bar.append(playhead);
  document.body.append(bar);
  const captures: number[] = [];
  const releases: number[] = [];
  Object.defineProperties(bar, {
    getBoundingClientRect: { value: () => ({ left: 100, width: 200 }), configurable: true },
    setPointerCapture: { value: (pointerId: number) => captures.push(pointerId), configurable: true },
    hasPointerCapture: { value: (pointerId: number) => captures.includes(pointerId), configurable: true },
    releasePointerCapture: { value: (pointerId: number) => releases.push(pointerId), configurable: true },
  });
  const controller = new NavigatorDragController(bar, {
    enabled: () => true,
    seek: () => undefined,
    cancel: () => undefined,
  });
  controller.attach();
  return { bar, captures, releases };
}

describe("companion navigator pointer lifecycle", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("moves the playhead immediately and captures the active pointer", () => {
    // Given
    const { bar, captures } = navigatorDom();

    // When
    bar.dispatchEvent(pointerEvent("pointerdown", 7, 150));

    // Then
    expect(requiredElement("playhead").style.left).toBe("25%");
    expect(captures).toEqual([7]);
  });

  it.each([
    { endEvent: "pointercancel", expectedReleases: [8] },
    { endEvent: "lostpointercapture", expectedReleases: [] },
  ])("stops dragging on $endEvent", ({ endEvent, expectedReleases }) => {
    // Given
    const { bar, releases } = navigatorDom();
    bar.dispatchEvent(pointerEvent("pointerdown", 8, 150));

    // When
    bar.dispatchEvent(pointerEvent(endEvent, 8, 150));
    bar.dispatchEvent(pointerEvent("pointermove", 8, 250));

    // Then
    expect(requiredElement("playhead").style.left).toBe("25%");
    expect(releases).toEqual(expectedReleases);
  });
});
