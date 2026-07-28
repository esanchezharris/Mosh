import { describe, it, expect } from "vitest";
import { EditorAction as A } from "./actions";
import { resolveGesture, type GestureContext } from "./gestures";
import { getGestureTable, GESTURE_TABLES } from "./gestureTables";

// Behavioural tests: drive the REAL presets through the resolver and assert each
// DAW's documented feel. This is where "ableton header drags-move, fl body
// drags-move, mosh native unchanged" is pinned.

const c = (over: Partial<GestureContext>): GestureContext => ({
  region: "clip.body", gesture: "drag", mods: {}, ...over,
});
const r = (table: string, over: Partial<GestureContext>) => resolveGesture(getGestureTable(table), c(over));

describe("getGestureTable", () => {
  it("returns a table per DAW and falls back to mosh for an unknown name", () => {
    expect(getGestureTable("ableton")).toBe(GESTURE_TABLES.ableton);
    expect(getGestureTable("fl")).toBe(GESTURE_TABLES.fl);
    expect(getGestureTable("mosh")).toBe(GESTURE_TABLES.mosh);
    expect(getGestureTable("protools")).toBe(GESTURE_TABLES.protools);
    expect(getGestureTable("logic")).toBe(GESTURE_TABLES.logic);
    expect(getGestureTable("nope")).toBe(GESTURE_TABLES.mosh);
  });
});

describe("ableton preset", () => {
  it("clip.header → click SELECT, drag MOVE", () => {
    expect(r("ableton", { region: "clip.header", gesture: "click" })).toBe(A.SELECT);
    expect(r("ableton", { region: "clip.header", gesture: "drag" })).toBe(A.MOVE);
  });
  it("clip.body → click SELECT, drag TIME_SELECT, dblclick OPEN", () => {
    expect(r("ableton", { region: "clip.body", gesture: "click" })).toBe(A.SELECT);
    expect(r("ableton", { region: "clip.body", gesture: "drag" })).toBe(A.TIME_SELECT);
    expect(r("ableton", { region: "clip.body", gesture: "dblclick" })).toBe(A.OPEN);
  });
  it("clip.edge → drag TRIM", () => {
    expect(r("ableton", { region: "clip.edge", gesture: "drag" })).toBe(A.TRIM);
  });
  it("empty → click DESELECT, drag MARQUEE", () => {
    expect(r("ableton", { region: "empty", gesture: "click" })).toBe(A.DESELECT);
    expect(r("ableton", { region: "empty", gesture: "drag" })).toBe(A.MARQUEE);
  });
});

describe("fl preset", () => {
  it("clip.body → click SELECT, drag MOVE (the key FL distinction)", () => {
    expect(r("fl", { region: "clip.body", gesture: "click" })).toBe(A.SELECT);
    expect(r("fl", { region: "clip.body", gesture: "drag" })).toBe(A.MOVE);
  });
  it("empty → drag MARQUEE", () => {
    expect(r("fl", { region: "empty", gesture: "drag" })).toBe(A.MARQUEE);
  });
  it("clip.edge → drag TRIM", () => {
    expect(r("fl", { region: "clip.edge", gesture: "drag" })).toBe(A.TRIM);
  });
});

describe("pro tools preset (Smart Tool)", () => {
  it("clip.header drag MOVE; clip.body drag TIME_SELECT, dblclick OPEN; edge TRIM", () => {
    expect(r("protools", { region: "clip.header", gesture: "drag" })).toBe(A.MOVE);
    expect(r("protools", { region: "clip.body", gesture: "drag" })).toBe(A.TIME_SELECT);
    expect(r("protools", { region: "clip.body", gesture: "dblclick" })).toBe(A.OPEN);
    expect(r("protools", { region: "clip.edge", gesture: "drag" })).toBe(A.TRIM);
  });
});

describe("logic preset (Pointer)", () => {
  it("whole clip drag MOVE (the key Logic distinction), edge TRIM, empty MARQUEE", () => {
    expect(r("logic", { region: "clip.body", gesture: "drag" })).toBe(A.MOVE);
    expect(r("logic", { region: "clip.body", gesture: "click" })).toBe(A.SELECT);
    expect(r("logic", { region: "clip.edge", gesture: "drag" })).toBe(A.TRIM);
    expect(r("logic", { region: "empty", gesture: "drag" })).toBe(A.MARQUEE);
  });
});

describe("mosh preset — current behavior preserved", () => {
  it("whole clip (header+body) → click SELECT, drag MOVE", () => {
    for (const region of ["clip.header", "clip.body"]) {
      expect(r("mosh", { region, gesture: "click" })).toBe(A.SELECT);
      expect(r("mosh", { region, gesture: "drag" })).toBe(A.MOVE);
    }
  });
  it("shift/meta click → ADDITIVE_SELECT", () => {
    expect(r("mosh", { region: "clip.body", gesture: "click", mods: { shift: true } })).toBe(A.ADDITIVE_SELECT);
    expect(r("mosh", { region: "clip.body", gesture: "click", mods: { meta: true } })).toBe(A.ADDITIVE_SELECT);
  });
  it("split tool: click on a clip → SPLIT", () => {
    expect(r("mosh", { region: "clip.body", gesture: "click", tool: "split" })).toBe(A.SPLIT);
  });
  it("split tool: shift+click still SPLITs (modal tool beats the additive-select modifier)", () => {
    expect(r("mosh", { region: "clip.body", gesture: "click", mods: { shift: true }, tool: "split" })).toBe(A.SPLIT);
  });
  it("edge drag trims only in the move tool; other tools fall back to MOVE", () => {
    expect(r("mosh", { region: "clip.edge", gesture: "drag", tool: "move" })).toBe(A.TRIM);
    expect(r("mosh", { region: "clip.edge", gesture: "drag", tool: "range" })).toBe(A.MOVE);
  });
  it("meta+edge-drag in the move tool STRETCHes (warp), beating plain-drag TRIM", () => {
    expect(r("mosh", { region: "clip.edge", gesture: "drag", tool: "move", mods: { meta: true } })).toBe(A.STRETCH);
    // plain edge-drag stays TRIM (the extra modifier is what selects stretch)
    expect(r("mosh", { region: "clip.edge", gesture: "drag", tool: "move" })).toBe(A.TRIM);
  });
  it("empty: click DESELECT, drag MARQUEE; range tool drag → TIME_SELECT", () => {
    expect(r("mosh", { region: "empty", gesture: "click" })).toBe(A.DESELECT);
    expect(r("mosh", { region: "empty", gesture: "drag" })).toBe(A.MARQUEE);
    expect(r("mosh", { region: "empty", gesture: "drag", tool: "range" })).toBe(A.TIME_SELECT);
  });
  it("ruler: click SEEK, shift-drag LOOP_REGION, plain drag does nothing", () => {
    expect(r("mosh", { region: "ruler", gesture: "click" })).toBe(A.SEEK);
    expect(r("mosh", { region: "ruler", gesture: "drag", mods: { shift: true } })).toBe(A.LOOP_REGION);
    expect(r("mosh", { region: "ruler", gesture: "drag" })).toBeNull();
  });
  it("clip dblclick → OPEN, contextmenu → CONTEXT_MENU", () => {
    expect(r("mosh", { region: "clip.body", gesture: "dblclick" })).toBe(A.OPEN);
    expect(r("mosh", { region: "clip.body", gesture: "contextmenu" })).toBe(A.CONTEXT_MENU);
  });
  it("empty: dblclick → LANE_NEW, contextmenu → CONTEXT_MENU", () => {
    expect(r("mosh", { region: "empty", gesture: "dblclick" })).toBe(A.LANE_NEW);
    expect(r("mosh", { region: "empty", gesture: "contextmenu" })).toBe(A.CONTEXT_MENU);
  });
  it("the new empty rules do not disturb the existing ones", () => {
    expect(r("mosh", { region: "empty", gesture: "click" })).toBe(A.DESELECT);
    expect(r("mosh", { region: "empty", gesture: "drag" })).toBe(A.MARQUEE);
    expect(r("mosh", { region: "empty", gesture: "drag", tool: "range" })).toBe(A.TIME_SELECT);
  });
  it("clip dblclick still OPENs — the new empty rule does not out-rank it", () => {
    expect(r("mosh", { region: "clip.body", gesture: "dblclick" })).toBe(A.OPEN);
  });
  it("LANE_NEW is mosh-only — other presets leave empty dblclick unbound", () => {
    for (const t of ["ableton", "fl", "protools", "logic"]) {
      expect(r(t, { region: "empty", gesture: "dblclick" })).toBeNull();
      expect(r(t, { region: "empty", gesture: "contextmenu" })).toBeNull();
    }
  });
});

describe("all presets share the ruler transport surface", () => {
  it("seek + loop work in every DAW", () => {
    for (const name of ["mosh", "ableton", "fl", "protools", "logic"]) {
      expect(r(name, { region: "ruler", gesture: "click" })).toBe(A.SEEK);
      expect(r(name, { region: "ruler", gesture: "drag", mods: { shift: true } })).toBe(A.LOOP_REGION);
    }
  });
});
