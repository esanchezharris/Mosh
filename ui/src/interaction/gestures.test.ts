import { describe, it, expect } from "vitest";
import { EditorAction as A } from "./actions";
import {
  resolveGesture,
  regionDepth,
  regionMatches,
  type GestureRule,
  type GestureContext,
} from "./gestures";

// The gesture resolver is the precedence-critical core. It models interaction as
// (region × gesture × modifier [× tool]) → action with CSS-like specificity:
//   most-specific region wins → more modifiers win → tool-conditioned wins →
//   stable source order breaks remaining ties.
// These tests ARE the precedence specification.

const ctx = (over: Partial<GestureContext>): GestureContext => ({
  region: "clip.body",
  gesture: "drag",
  mods: {},
  ...over,
});

describe("region helpers", () => {
  it("regionDepth counts dotted segments; '*' is 0", () => {
    expect(regionDepth("*")).toBe(0);
    expect(regionDepth("empty")).toBe(1);
    expect(regionDepth("clip")).toBe(1);
    expect(regionDepth("clip.header")).toBe(2);
  });

  it("regionMatches is self/ancestor or wildcard, at dot boundaries", () => {
    expect(regionMatches("clip.header", "clip.header")).toBe(true);
    expect(regionMatches("clip", "clip.header")).toBe(true); // ancestor
    expect(regionMatches("*", "clip.header")).toBe(true); // wildcard
    expect(regionMatches("clip.header", "clip")).toBe(false); // not a descendant match
    expect(regionMatches("clip", "clipper")).toBe(false); // boundary, not prefix
    expect(regionMatches("empty", "clip.body")).toBe(false);
  });
});

describe("resolveGesture — basic resolution", () => {
  it("resolves an exact region+gesture rule", () => {
    const t: GestureRule[] = [{ region: "clip.body", gesture: "drag", action: A.MOVE }];
    expect(resolveGesture(t, ctx({}))).toBe(A.MOVE);
  });

  it("returns null when nothing matches", () => {
    const t: GestureRule[] = [{ region: "ruler", gesture: "click", action: A.SEEK }];
    expect(resolveGesture(t, ctx({}))).toBeNull();
  });

  it("matches the gesture exactly (drag rule ignores a click ctx)", () => {
    const t: GestureRule[] = [{ region: "clip.body", gesture: "drag", action: A.MOVE }];
    expect(resolveGesture(t, ctx({ gesture: "click" }))).toBeNull();
  });
});

describe("resolveGesture — region cascade", () => {
  it("falls back to an ancestor-region rule when no exact-region rule exists", () => {
    const t: GestureRule[] = [{ region: "clip", gesture: "drag", action: A.MOVE }];
    expect(resolveGesture(t, ctx({ region: "clip.header" }))).toBe(A.MOVE);
  });

  it("a more-specific region beats an ancestor region", () => {
    const t: GestureRule[] = [
      { region: "clip", gesture: "drag", action: A.MOVE },
      { region: "clip.header", gesture: "drag", action: A.TIME_SELECT },
    ];
    expect(resolveGesture(t, ctx({ region: "clip.header" }))).toBe(A.TIME_SELECT);
  });

  it("the global '*' default is lowest precedence", () => {
    const t: GestureRule[] = [
      { region: "*", gesture: "drag", action: A.MARQUEE },
      { region: "clip.body", gesture: "drag", action: A.MOVE },
    ];
    expect(resolveGesture(t, ctx({ region: "clip.body" }))).toBe(A.MOVE);
    expect(resolveGesture(t, ctx({ region: "ruler" }))).toBe(A.MARQUEE); // only '*' matches
  });

  it("region specificity dominates modifier count", () => {
    const t: GestureRule[] = [
      { region: "clip", gesture: "drag", mods: { shift: true }, action: A.TIME_SELECT },
      { region: "clip.body", gesture: "drag", action: A.MOVE },
    ];
    // clip.body (depth 2, 0 mods) outranks clip+shift (depth 1, 1 mod)
    expect(resolveGesture(t, ctx({ region: "clip.body", mods: { shift: true } }))).toBe(A.MOVE);
  });
});

describe("resolveGesture — modifier precedence", () => {
  const table: GestureRule[] = [
    { region: "clip.header", gesture: "drag", action: A.MOVE }, // region default
    { region: "clip.header", gesture: "drag", mods: { shift: true }, action: A.TIME_SELECT },
  ];

  it("a required modifier beats the region default when present", () => {
    expect(resolveGesture(table, ctx({ region: "clip.header", mods: { shift: true } }))).toBe(A.TIME_SELECT);
  });

  it("falls back to the region default when the modifier is absent", () => {
    expect(resolveGesture(table, ctx({ region: "clip.header", mods: {} }))).toBe(A.MOVE);
  });

  it("shift+drag-on-header is unambiguous in BOTH directions", () => {
    // plain drag → MOVE, shift+drag → TIME_SELECT — no overlap, deterministic
    expect(resolveGesture(table, ctx({ region: "clip.header", mods: {} }))).toBe(A.MOVE);
    expect(resolveGesture(table, ctx({ region: "clip.header", mods: { shift: true } }))).toBe(A.TIME_SELECT);
  });

  it("unrequired modifiers are don't-care (a no-mod rule still matches when meta is held)", () => {
    const t: GestureRule[] = [{ region: "clip.body", gesture: "click", action: A.SELECT }];
    expect(resolveGesture(t, ctx({ gesture: "click", mods: { meta: true } }))).toBe(A.SELECT);
  });

  it("more required modifiers win", () => {
    const t: GestureRule[] = [
      { region: "clip.body", gesture: "click", mods: { shift: true }, action: A.ADDITIVE_SELECT },
      { region: "clip.body", gesture: "click", mods: { shift: true, alt: true }, action: A.DESELECT },
    ];
    expect(resolveGesture(t, ctx({ gesture: "click", mods: { shift: true, alt: true } }))).toBe(A.DESELECT);
  });
});

describe("resolveGesture — tool condition", () => {
  const table: GestureRule[] = [
    { region: "clip.body", gesture: "click", action: A.SELECT },
    { region: "clip.body", gesture: "click", tool: "split", action: A.SPLIT },
  ];

  it("a tool-conditioned rule wins when the tool matches", () => {
    expect(resolveGesture(table, ctx({ gesture: "click", tool: "split" }))).toBe(A.SPLIT);
  });

  it("the tool-conditioned rule is inert when the tool differs", () => {
    expect(resolveGesture(table, ctx({ gesture: "click", tool: "move" }))).toBe(A.SELECT);
    expect(resolveGesture(table, ctx({ gesture: "click" }))).toBe(A.SELECT); // no tool in ctx
  });

  it("a tool condition outranks a same-region modifier rule (modal tool dominates)", () => {
    // split tool + shift-click on a clip must SPLIT (the modal tool wins), not additive-select
    const t: GestureRule[] = [
      { region: "clip", gesture: "click", mods: { shift: true }, action: A.ADDITIVE_SELECT },
      { region: "clip", gesture: "click", tool: "split", action: A.SPLIT },
    ];
    expect(resolveGesture(t, ctx({ region: "clip.body", gesture: "click", mods: { shift: true }, tool: "split" }))).toBe(A.SPLIT);
  });
});

describe("resolveGesture — stable tiebreak", () => {
  it("equally-specific rules resolve to the earlier one", () => {
    const t: GestureRule[] = [
      { region: "clip.body", gesture: "drag", action: A.MOVE },
      { region: "clip.body", gesture: "drag", action: A.TIME_SELECT },
    ];
    expect(resolveGesture(t, ctx({}))).toBe(A.MOVE);
  });
});
