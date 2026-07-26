// The annotation lane — UI-REACH: create_annotation / edit_annotation / move_annotation /
// remove_annotation reaching a mouse-only v2 user for the first time. v2 rendered NO
// annotation surface at all before this; AnnotationRuler.tsx (classic) was the only call
// site, imported solely by classic's Arrange.tsx.
//
// The test that matters here is the same one TempoRibbon.test.ts exists to prove: positions
// come from the piecewise map (time.ts's beatAt/secAtBeat), not v2/timeline/geom.ts's flat
// beatToSec/secToBeat (which SectionRibbon uses and which is only correct while the tempo
// never changes). Building this on geom.ts would place every pin after a tempo change in the
// wrong spot, silently, and no existing test would notice — so the fixture below is
// constructed to actually disagree between the two formulas (guarded, so a coincidence can't
// make this vacuous).

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnotationLane } from "./AnnotationLane";
import { useStore } from "../../store";
import { tempoMapFrom, beatAt, secAtBeat, meterFrom, beatSeconds } from "../../time";
import { FEEL_DEFAULTS } from "../../interaction/feel";
import type { Snapshot, Annotation } from "../../types";

vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}) };
});

const PX = 100; // px per second

const snap = (annotations: Annotation[], tempoMap?: { time: number; bpm: number; curve?: number }[]): Snapshot =>
  ({
    schemaVersion: 1,
    session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, length: 32, ...(tempoMap ? { tempoMap } : {}) },
    tracks: [], sections: [], annotations,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  }) as unknown as Snapshot;

describe("AnnotationLane", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const render = (s: Snapshot) => {
    useStore.setState({ exec, pxPerSec: PX, snapshot: s, mp: { active: false, roomCode: null, selfPeer: null, connected: false }, peers: {} } as never);
    act(() => root.render(React.createElement(AnnotationLane, { snapshot: s, width: 3200 })));
  };
  const lane = () => host.querySelector('[data-testid="v2-annotation-lane"]') as HTMLElement;
  const pins = () => [...host.querySelectorAll('[data-testid="v2-annotation"]')] as HTMLElement[];
  const draftInput = () => host.querySelector('[data-testid="v2-annotation-input"]') as HTMLInputElement | null;
  const editInput = () => host.querySelector('[data-testid="v2-annotation-edit"]') as HTMLInputElement | null;

  const typeInto = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const enterOn = async (input: HTMLInputElement) => {
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  };
  const escapeOn = (input: HTMLInputElement) => {
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  };
  // Click, not pointerdown — matching TempoRibbon: a real mouse press is
  // pointerdown -> mousedown -> mouseup, and opening on pointerdown would have the
  // following mousedown land on the lane and blur the input just focused, whose onBlur
  // commits and closes it before a keystroke lands. jsdom does not reproduce that native
  // focus/blur sequencing (this unit suite would pass either way); the e2e spec, which
  // drives a real mouse, is what actually would catch it.
  const clickLaneAt = (sec: number) => {
    const el = lane();
    act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: sec * PX })); });
  };

  const withBox = (el: HTMLElement, left: number, width: number) => {
    el.getBoundingClientRect = () => ({ left, width, right: left + width, top: 0, bottom: 24, height: 24, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
  };
  const pointer = (el: HTMLElement, type: string, x: number, extra: Record<string, unknown> = {}) =>
    act(() => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, clientX: x, clientY: 12, ...extra })); });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true }));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("renders one pin per annotation, at a position computed from the PIECEWISE map", () => {
    // 120bpm 4/4 -> 0.5s/beat, then a step change to 240bpm at t=4s (bar 2). Beat 12 sits
    // at 5s piecewise (4s to reach the change + 4 more beats at 0.25s/beat) but at 6s under
    // the flat single-tempo formula geom.ts encodes.
    const map = tempoMapFrom({ tempo: 120, tempoMap: [{ time: 0, bpm: 120 }, { time: 4, bpm: 240 }] });
    const piecewiseSec = secAtBeat(map, 12);
    const flatSec = 12 * beatSeconds(meterFrom({ tempo: 120 }));
    expect(piecewiseSec, "fixture does not discriminate piecewise from flat").not.toBeCloseTo(flatSec, 6);

    render(snap([{ id: "a1", text: "fix this", beat: 12 }], [{ time: 0, bpm: 120 }, { time: 4, bpm: 240 }]));
    expect(pins()).toHaveLength(1);
    expect(Number(pins()[0].style.left.replace("px", ""))).toBeCloseTo(piecewiseSec * PX, 3);
  });

  it("click on empty lane space opens a draft input at the piecewise beat, seeded empty", () => {
    render(snap([]));
    clickLaneAt(6);
    const input = draftInput();
    expect(input, "click did not open a draft input").toBeTruthy();
    expect(input!.value).toBe("");
    const expectedBeat = beatAt(tempoMapFrom({ tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 }), 6);
    expect(input!.getAttribute("data-beat")).toBeNull(); // position is via style.left, not an attr on the draft
    expect(Number(input!.style.left.replace("px", ""))).toBeCloseTo(secAtBeat(tempoMapFrom({ tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 }), expectedBeat) * PX, 3);
  });

  it("typing text and pressing Enter commits create_annotation with the clicked beat", async () => {
    render(snap([]));
    clickLaneAt(4); // bar 2 at 120bpm/4/4 -> beat 8
    typeInto(draftInput()!, "tighten this");
    await enterOn(draftInput()!);
    expect(exec).toHaveBeenCalledWith("create_annotation", expect.objectContaining({ text: "tighten this", beat: 8 }));
  });

  it("leaving the draft empty does not create anything", async () => {
    render(snap([]));
    clickLaneAt(4);
    await enterOn(draftInput()!);
    expect(exec).not.toHaveBeenCalled();
  });

  it("Escape cancels the draft without dispatching", () => {
    render(snap([]));
    clickLaneAt(4);
    typeInto(draftInput()!, "abandoned");
    escapeOn(draftInput()!);
    expect(draftInput()).toBeFalsy();
    expect(exec).not.toHaveBeenCalled();
  });

  it("a plain click on an existing pin does not create a second one", () => {
    render(snap([{ id: "a1", text: "note", beat: 4 }]));
    const pin = pins()[0];
    withBox(pin, 400, 40);
    pointer(pin, "pointerdown", 410);
    pointer(pin, "pointerup", 410);
    expect(draftInput()).toBeFalsy();
    expect(exec.mock.calls.some((c) => c[0] === "create_annotation")).toBe(false);
  });

  it("double-clicking the SAME pin opens inline edit; Enter commits edit_annotation", async () => {
    render(snap([{ id: "a1", text: "old text", beat: 4 }]));
    const pin = pins()[0];
    withBox(pin, 400, 40);
    const click = () => { pointer(pin, "pointerdown", 410); pointer(pin, "pointerup", 410); };
    click(); click();
    const input = editInput();
    expect(input, "double-click did not open the inline edit input").toBeTruthy();
    expect(input!.value).toBe("old text");
    typeInto(input!, "new text");
    await enterOn(input!);
    expect(exec).toHaveBeenCalledWith("edit_annotation", { annotationId: "a1", text: "new text" });
  });

  it("double-clicking DIFFERENT pins does not open edit", () => {
    render(snap([{ id: "a1", text: "one", beat: 2 }, { id: "a2", text: "two", beat: 10 }]));
    const [a, b] = pins();
    withBox(a, 200, 40); withBox(b, 1000, 40);
    pointer(a, "pointerdown", 210); pointer(a, "pointerup", 210);
    pointer(b, "pointerdown", 1010); pointer(b, "pointerup", 1010);
    expect(editInput(), "edit opened across two different pins").toBeFalsy();
  });

  it("a drag past the threshold moves the pin, converting through the piecewise map", () => {
    const map = [{ time: 0, bpm: 120 }, { time: 4, bpm: 240 }];
    render(snap([{ id: "a1", text: "note", beat: 4 }], map)); // beat 4 -> 2s -> 200px at PX=100
    const pin = pins()[0];
    withBox(pin, 200, 40);
    const dx = 400; // drag 4s worth of px to the right, landing well past the tempo change
    pointer(pin, "pointerdown", 210);
    pointer(pin, "pointermove", 210 + dx, { buttons: 1 });
    pointer(pin, "pointerup", 210 + dx);
    const call = exec.mock.calls.find((c) => c[0] === "move_annotation");
    expect(call, "no move_annotation dispatched").toBeDefined();
    const tm = tempoMapFrom({ tempo: 120, tempoMap: map });
    const expectedBeat = beatAt(tm, 2 + dx / PX);
    expect((call![1] as { annotationId: string; beat: number }).annotationId).toBe("a1");
    expect((call![1] as { annotationId: string; beat: number }).beat).toBeCloseTo(expectedBeat, 6);
  });

  it("a sub-threshold wobble is a click, not a move", () => {
    render(snap([{ id: "a1", text: "note", beat: 4 }]));
    const pin = pins()[0];
    withBox(pin, 400, 40);
    const dx = Math.max(1, FEEL_DEFAULTS.dragThreshold - 1);
    pointer(pin, "pointerdown", 410);
    pointer(pin, "pointermove", 410 + dx, { buttons: 1 });
    pointer(pin, "pointerup", 410 + dx);
    expect(exec.mock.calls.some((c) => c[0] === "move_annotation"), "a wobble re-timed the annotation").toBe(false);
  });

  it("the remove control deletes the annotation and does not also create/edit", () => {
    render(snap([{ id: "a1", text: "note", beat: 4 }]));
    const rm = host.querySelector('[data-testid="v2-annotation-remove"]') as HTMLElement;
    act(() => { rm.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(exec).toHaveBeenCalledWith("remove_annotation", { annotationId: "a1" });
    expect(exec.mock.calls.some((c) => c[0] === "create_annotation")).toBe(false);
  });

  it("tags a fresh annotation with the local session name (multiplayer author)", async () => {
    render(snap([]));
    act(() => {
      useStore.setState({
        mp: { active: true, roomCode: "abcd", selfPeer: "p1", connected: true },
        peers: { p1: { name: "Jordan", color: "#fff", online: true } },
      } as never);
    });
    clickLaneAt(4);
    typeInto(draftInput()!, "note");
    await enterOn(draftInput()!);
    expect(exec).toHaveBeenCalledWith("create_annotation", expect.objectContaining({ author: "Jordan" }));
  });

  it("falls back to a plain author when not in a multiplayer session", async () => {
    render(snap([]));
    clickLaneAt(4);
    typeInto(draftInput()!, "note");
    await enterOn(draftInput()!);
    expect(exec).toHaveBeenCalledWith("create_annotation", expect.objectContaining({ author: "you" }));
  });

  it("tolerates a snapshot with no annotations array at all", () => {
    const s = snap([]);
    delete (s as { annotations?: unknown }).annotations;
    expect(() => render(s)).not.toThrow();
    expect(pins()).toHaveLength(0);
  });
});
