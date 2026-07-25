// Characterization test for SectionRibbon, written BEFORE mounting it.
//
// The component has been complete and unmounted since PR #183 removed it from the nav
// strip ("the old SectionRibbon in the nav was misread as section editing"). Nothing has
// exercised it since, so "does it still work?" had to be answered before wiring it back
// in — otherwise mounting it would be the thing that discovers the rot.
//
// This file is NOT imported by AppV2, so it does not enter the module graph the
// reachability probe walks: the four *_section gaps stay declared until the real mount.
//
// NOTE: vitest.config.ts includes `src/**/*.test.ts` — .ts, not .tsx — so elements are
// built with createElement rather than JSX.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SectionRibbon } from "./SectionRibbon";
import { useStore } from "../../store";
import { FEEL_DEFAULTS } from "../../interaction/feel";
import type { Snapshot } from "../../types";

vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

const BPB = 4;          // 4/4
const PX_PER_SEC = 80;
const BEAT_SEC = 0.5;   // 120bpm
const BEAT_PX = BEAT_SEC * PX_PER_SEC;   // 40px per beat
const BAR_PX = BEAT_PX * BPB;            // 160px per bar

function snap(sections = [
  { id: "s1", name: "Intro", startBeat: 0, endBeat: 8, color: "#9fe1cb" },
  { id: "s2", name: "Verse", startBeat: 8, endBeat: 24, color: "#b5d4f4" },
]): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: BPB, timeSigDenominator: 4,
      metronome: false, length: 64, editFile: "/mock/s.mosh", key: { tonic: "A", mode: "minor" },
    },
    tracks: [],
    sections,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  } as unknown as Snapshot;
}

describe("SectionRibbon (characterization — the orphan still works)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const mount = (s: Snapshot = snap()) => {
    useStore.setState({ snapshot: s, exec, pxPerSec: PX_PER_SEC });
    act(() => root.render(React.createElement(SectionRibbon, { snapshot: s, width: 2000 })));
  };
  const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
  const call = (name: string) => exec.mock.calls.find((c) => c[0] === name)?.[1] as Record<string, unknown> | undefined;

  /** jsdom has no layout, so getBoundingClientRect() is all zeros — which makes
   *  `localX >= rect.width - EDGE_PX` true for any x and turns EVERY drag into an
   *  edge-resize. Give the segment a real box so the move path is the one exercised. */
  const withBox = (el: HTMLElement, left: number, width: number) => {
    el.getBoundingClientRect = () => ({ left, width, right: left + width, top: 0, bottom: 24, height: 24, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
  };

  /** Each pointer event in its OWN act(): in a browser these are separate tasks, so React
   *  flushes between them and pointerup reads a current `preview`. Firing all three in one
   *  act() batches the updates and pointerup sees the stale value — a harness artifact,
   *  not a component bug. */
  const pointer = (el: HTMLElement, type: string, x: number, extra: Record<string, unknown> = {}) =>
    act(() => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, clientX: x, clientY: 12, ...extra })); });

  /** React tracks an input's value on the node, so assigning `.value` directly and firing
   *  `input` does NOT produce a change event. Go through the native setter. */
  const typeInto = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true, data: { sectionId: "new-1" } }));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("renders one segment per section", () => {
    mount();
    expect(host.querySelectorAll('[data-testid="v2-section"]')).toHaveLength(2);
    expect(q('[data-testid="v2-section-ribbon"]')).toBeTruthy();
  });

  it("+ appends a section after the last one, bar-aligned", () => {
    mount();
    act(() => { q('[data-testid="v2-section-add"]')!.click(); });
    const args = call("create_section");
    expect(args, "no create_section dispatched").toBeDefined();
    // last section ends at beat 24; a fresh one spans 4 bars = 16 beats.
    expect(args!.startBeat).toBe(24);
    expect(args!.endBeat).toBe(24 + 4 * BPB);
  });

  it("a single click seeks instead of editing", () => {
    mount();
    const seg = q('[data-testid="v2-section"]')!;
    withBox(seg, 0, 320);
    pointer(seg, "pointerdown", 60);
    pointer(seg, "pointerup", 60);
    expect(call("set_transport"), "a click on a section should seek").toBeDefined();
    expect(exec.mock.calls.some((c) => c[0] === "move_section")).toBe(false);
  });

  it("a drag past the threshold moves the section, snapped to the bar", () => {
    mount();
    const seg = q('[data-testid="v2-section"]')!;
    withBox(seg, 0, 320);
    const dx = BAR_PX + 10; // one bar plus a nudge — must snap back to exactly one bar
    pointer(seg, "pointerdown", 60);
    pointer(seg, "pointermove", 60 + dx, { buttons: 1 });
    pointer(seg, "pointerup", 60 + dx);
    const args = call("move_section");
    expect(args, "no move_section dispatched").toBeDefined();
    expect(args!.startBeat).toBe(BPB);          // moved exactly one bar
    expect(args!.endBeat).toBe(8 + BPB);
  });

  it("a sub-threshold wobble is a click, not a move", () => {
    mount();
    const seg = q('[data-testid="v2-section"]')!;
    withBox(seg, 0, 320);
    const dx = Math.max(1, FEEL_DEFAULTS.dragThreshold - 1);
    pointer(seg, "pointerdown", 60);
    pointer(seg, "pointermove", 60 + dx, { buttons: 1 });
    pointer(seg, "pointerup", 60 + dx);
    expect(exec.mock.calls.some((c) => c[0] === "move_section"), "a wobble re-timed the section").toBe(false);
  });

  it("✕ removes the section and does not also seek", () => {
    mount();
    act(() => { q('[data-testid="v2-section-remove"]')!.click(); });
    expect(call("remove_section")).toEqual({ sectionId: "s1" });
    expect(exec.mock.calls.some((c) => c[0] === "set_transport"), "remove bubbled into a seek").toBe(false);
  });

  it("double-clicking the SAME segment opens rename; Enter commits it", () => {
    mount();
    const seg = q('[data-testid="v2-section"]')!;
    withBox(seg, 0, 320);
    const click = () => { pointer(seg, "pointerdown", 60); pointer(seg, "pointerup", 60); };
    click(); click();
    const input = q('[data-testid="v2-section-rename"]') as HTMLInputElement | null;
    expect(input, "double-click did not open the rename input").toBeTruthy();
    typeInto(input!, "Bridge");
    act(() => { input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(call("rename_section")).toMatchObject({ sectionId: "s1", name: "Bridge" });
  });

  it("double-clicking DIFFERENT segments does not open rename", () => {
    // All segments share one ribbon instance, so the double-click detector has to key on
    // the section id or two quick clicks across neighbours would open an editor.
    mount();
    const segs = host.querySelectorAll('[data-testid="v2-section"]');
    const [a, b] = [segs[0] as HTMLElement, segs[1] as HTMLElement];
    withBox(a, 0, 160); withBox(b, 160, 320);
    pointer(a, "pointerdown", 60); pointer(a, "pointerup", 60);
    pointer(b, "pointerdown", 200); pointer(b, "pointerup", 200);
    expect(q('[data-testid="v2-section-rename"]'), "rename opened across two different sections").toBeFalsy();
  });
});
