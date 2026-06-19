import { describe, it, expect } from "vitest";
import {
  resizeBetween, resizeZone, collapseZone, expandZone, toggleZone,
  clampWindow, moveWindow, resizeWindow,
  type Zone, type FloatWin, type Bounds,
} from "./dockLayout";

const zone = (size: number, min = 100, max = 400): Zone => ({ id: "z", size, min, max });
const win = (over: Partial<FloatWin> = {}): FloatWin => ({ id: "w", x: 100, y: 100, w: 300, h: 200, minW: 120, minH: 80, ...over });
const B: Bounds = { w: 1000, h: 600 };

describe("resizeBetween", () => {
  it("trades pixels between adjacent zones (conserves total)", () => {
    const [a, b] = resizeBetween(zone(200), zone(200), 40);
    expect([a.size, b.size]).toEqual([240, 160]);
    expect(a.size + b.size).toBe(400);
  });
  it("stops at the growing zone's max", () => {
    const [a, b] = resizeBetween(zone(380, 100, 400), zone(300), 999);
    expect(a.size).toBe(400);          // a capped at max
    expect(b.size).toBe(280);          // b shrank by the SAME applied delta (20)
  });
  it("stops at the shrinking zone's min", () => {
    const [a, b] = resizeBetween(zone(300), zone(120, 100, 400), 999);
    expect(b.size).toBe(100);          // b floored at min (could give 20)
    expect(a.size).toBe(320);
  });
  it("handles negative delta (grow b, shrink a) symmetrically", () => {
    const [a, b] = resizeBetween(zone(200), zone(200), -50);
    expect([a.size, b.size]).toEqual([150, 250]);
  });
  it("does not mutate the inputs", () => {
    const a = zone(200); const b = zone(200);
    resizeBetween(a, b, 30);
    expect([a.size, b.size]).toEqual([200, 200]);
  });
});

describe("resizeZone", () => {
  it("clamps a single zone's size to [min,max]", () => {
    expect(resizeZone(zone(200, 100, 400), 50).size).toBe(250);
    expect(resizeZone(zone(200, 100, 400), 999).size).toBe(400);  // capped at max
    expect(resizeZone(zone(200, 100, 400), -999).size).toBe(100); // floored at min
  });
  it("does not mutate the input", () => {
    const z = zone(200);
    resizeZone(z, 30);
    expect(z.size).toBe(200);
  });
});

describe("collapse / expand / toggle", () => {
  it("collapse remembers the prior size; expand restores it", () => {
    const c = collapseZone(zone(260), 0);
    expect(c.collapsed).toBe(true);
    expect(c.size).toBe(0);
    expect(c.prevSize).toBe(260);
    const e = expandZone(c);
    expect(e.collapsed).toBe(false);
    expect(e.size).toBe(260);
    expect(e.prevSize).toBeUndefined();
  });
  it("toggle round-trips", () => {
    const z = zone(300);
    expect(expandZone(z)).toBe(z);                 // no-op when already expanded
    const there = toggleZone(z);
    const back = toggleZone(there);
    expect(back.collapsed).toBe(false);
    expect(back.size).toBe(300);
  });
  it("expand clamps a stale prevSize into [min,max]", () => {
    const e = expandZone({ id: "z", size: 0, min: 100, max: 400, collapsed: true, prevSize: 999 });
    expect(e.size).toBe(400);
  });
});

describe("clampWindow / moveWindow", () => {
  it("keeps a window fully inside the workspace", () => {
    expect(clampWindow(win({ x: 900, y: 550 }), B)).toMatchObject({ x: 700, y: 400 });
  });
  it("never lets a window exceed bounds or drop below min size", () => {
    const c = clampWindow(win({ w: 5000, h: 5000 }), B);
    expect(c.w).toBe(1000); expect(c.h).toBe(600);
    const small = clampWindow(win({ w: 10, h: 10 }), B);
    expect(small.w).toBe(120); expect(small.h).toBe(80);
  });
  it("moveWindow clamps at the edges", () => {
    expect(moveWindow(win(), -500, -500, B)).toMatchObject({ x: 0, y: 0 });
  });
});

describe("resizeWindow", () => {
  it("east/south grow keep the top-left anchored", () => {
    const r = resizeWindow(win(), "se", 50, 30, B);
    expect(r).toMatchObject({ x: 100, y: 100, w: 350, h: 230 });
  });
  it("west drag keeps the EAST edge anchored", () => {
    const r = resizeWindow(win(), "w", 40, 0, B);     // x:100 w:300 → east=400
    expect(r.w).toBe(260);
    expect(r.x).toBe(140);
    expect(r.x + r.w).toBe(400);                        // east unchanged
  });
  it("north drag keeps the SOUTH edge anchored", () => {
    const r = resizeWindow(win(), "n", 0, 30, B);      // y:100 h:200 → south=300
    expect(r.h).toBe(170);
    expect(r.y).toBe(130);
    expect(r.y + r.h).toBe(300);
  });
  it("enforces min size without drifting the anchored edge", () => {
    const r = resizeWindow(win({ x: 100, w: 300, minW: 120 }), "w", 999, 0, B);
    expect(r.w).toBe(120);
    expect(r.x + r.w).toBe(400);                        // east still anchored at 400
  });
});
