// The tempo lane.
//
// The test that matters here is "positions come from the piecewise map, not session.tempo".
// v2 has both: BarRuler and clip snapping read time.ts's tempoMapFrom/gridLines, while
// geom.ts derives everything from the single tempo at time zero. Both look identical until
// a tempo change exists — which is precisely what this feature creates. Building the ribbon
// on geom.ts (the obvious move, since SectionRibbon does exactly that) would place every
// marker after the first change in the wrong place, and no existing test would have noticed.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TempoRibbon, tempoPoints, indexOfPointAt } from "./TempoRibbon";
import { useStore } from "../../store";
import { tempoMapFrom, snapTimeMap, meterFrom, barSeconds } from "../../time";
import type { Snapshot } from "../../types";

vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}) };
});

const PX = 100; // px per second — keeps clientX ↔ seconds arithmetic readable

const snap = (tempoMap?: { time: number; bpm: number; curve?: number }[]): Snapshot =>
  ({
    schemaVersion: 1,
    session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, length: 32, ...(tempoMap ? { tempoMap } : {}) },
    tracks: [], sections: [],
  }) as unknown as Snapshot;

describe("TempoRibbon", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const render = (s: Snapshot) => act(() => root.render(React.createElement(TempoRibbon, { snapshot: s, width: 3200 })));
  const points = () => [...host.querySelectorAll('[data-testid="v2-tempo-point"]')] as HTMLElement[];
  const lane = () => host.querySelector('[data-testid="v2-tempo-lane"]') as HTMLElement;
  const input = () => host.querySelector('[data-testid="v2-tempo-input"]') as HTMLInputElement | null;

  // `click`, matching the component. It opens the field on click rather than pointerdown
  // because a real press is pointerdown → mousedown → mouseup, and that mousedown blurs the
  // input pointerdown had just focused — whose onBlur commits and closes it. jsdom does not
  // reproduce that native focus behaviour, so this unit test would pass either way; the e2e
  // (e2e/v2-tempo.spec.ts), which drives a real mouse, is what actually caught it.
  const clickLaneAt = (sec: number) => {
    const el = lane();
    act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: sec * PX })); });
  };
  const type = (v: string) => {
    const el = input()!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => { setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const enter = async () => {
    await act(async () => { input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true }));
    useStore.setState({ exec, pxPerSec: PX, snapshot: snap() } as never);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("draws one marker per tempo point, and the base tempo cannot be removed", () => {
    render(snap([{ time: 0, bpm: 120, curve: 1 }, { time: 8, bpm: 150, curve: 1 }]));
    expect(points()).toHaveLength(2);
    // removeTempo() no-ops on index 0 in the engine — offering an ✕ there would be a control
    // whose only outcome is a rejected command.
    expect(points()[0].querySelector('[data-testid="v2-tempo-remove"]')).toBeFalsy();
    expect(points()[1].querySelector('[data-testid="v2-tempo-remove"]')).toBeTruthy();
  });

  it("shows the session tempo even when the project predates the tempo map", () => {
    render(snap());
    expect(points()).toHaveLength(1);
    expect(points()[0].dataset.bpm).toBe("120");
  });

  it("positions markers on the seconds axis", () => {
    render(snap([{ time: 0, bpm: 120, curve: 1 }, { time: 8, bpm: 150, curve: 1 }]));
    expect(points()[1].style.left).toBe(`${8 * PX}px`);
  });

  it("snaps a new point using the PIECEWISE map, not the tempo at bar 1", () => {
    // 120bpm 4/4 → 2s bars. After the change at t=4 the tempo doubles → 1s bars. So a click
    // at 5.4s snaps to 5.0 piecewise, but to 6.0 under the flat assumption geom.ts encodes.
    const map = [{ time: 0, bpm: 120, curve: 1 }, { time: 4, bpm: 240, curve: 1 }];
    const s = snap(map);
    const piecewise = snapTimeMap(tempoMapFrom(s.session), 5.4, "bar");
    const flatBar = barSeconds(meterFrom(s.session));
    const flat = Math.round(5.4 / flatBar) * flatBar;
    // Guard against a fixture where the two happen to agree — that would make this vacuous.
    expect(piecewise, "fixture does not discriminate piecewise from flat").not.toBeCloseTo(flat, 6);

    render(s);
    clickLaneAt(5.4);
    expect(input()).toBeTruthy();
    expect(Number(input()!.style.left.replace("px", "")) / PX).toBeCloseTo(piecewise, 6);
  });

  it("seeds the field with the tempo governing that spot, so a blind Enter changes nothing", () => {
    render(snap([{ time: 0, bpm: 120, curve: 1 }, { time: 4, bpm: 240, curve: 1 }]));
    clickLaneAt(6);
    expect(input()!.value).toBe("240");
  });

  it("commits a STEP change — never a curve", async () => {
    render(snap());
    clickLaneAt(6);
    type("140");
    await enter();
    // No `curve` key: its default of 1.0 means "hold, then jump". Sending anything inside
    // (-1,1) would silently make it a ramp, and there is no UI to express one.
    expect(exec).toHaveBeenCalledWith("insert_tempo_change", { time: 6, bpm: 140 });
  });

  it("refuses a tempo the engine would reject, without dispatching", async () => {
    render(snap());
    clickLaneAt(6);
    type("5");
    await enter();
    expect(exec, "sent a bpm outside the engine's 20..999 range").not.toHaveBeenCalled();
  });

  it("does not stack a second point on a bar that already has one", () => {
    render(snap([{ time: 0, bpm: 120, curve: 1 }, { time: 6, bpm: 150, curve: 1 }]));
    clickLaneAt(6);
    expect(input()).toBeFalsy();
  });

  it("resolves the remove index from the CURRENT map, not the one it rendered with", async () => {
    // remove_tempo_change takes an array index. If the component captured it at render time,
    // a change landing in between (an agent edit, an undo, another client) would make the ✕
    // delete a different tempo change than the one clicked.
    const rendered = [{ time: 0, bpm: 120, curve: 1 }, { time: 4, bpm: 130, curve: 1 }, { time: 8, bpm: 150, curve: 1 }];
    render(snap(rendered));
    // …the middle point disappears from the live snapshot, so time 8 is now index 1, not 2.
    useStore.setState({ snapshot: snap([{ time: 0, bpm: 120, curve: 1 }, { time: 8, bpm: 150, curve: 1 }]) } as never);

    const rm = points()[2].querySelector('[data-testid="v2-tempo-remove"]') as HTMLElement;
    await act(async () => { rm.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(exec).toHaveBeenCalledWith("remove_tempo_change", { index: 1 });
  });
});

describe("TempoRibbon helpers", () => {
  it("tempoPoints falls back to the session tempo", () => {
    expect(tempoPoints({ tempo: 92 } as Snapshot["session"])).toEqual([{ time: 0, bpm: 92, curve: 1 }]);
  });
  it("tempoPoints prefers a real map", () => {
    const map = [{ time: 0, bpm: 100 }, { time: 2, bpm: 110 }];
    expect(tempoPoints({ tempo: 92, tempoMap: map } as Snapshot["session"])).toBe(map);
  });
  it("indexOfPointAt finds by time, and reports a miss", () => {
    const map = [{ time: 0, bpm: 100 }, { time: 2, bpm: 110 }];
    expect(indexOfPointAt(map, 2)).toBe(1);
    expect(indexOfPointAt(map, 3)).toBe(-1);
  });
});
