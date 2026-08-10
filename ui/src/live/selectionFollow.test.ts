// Unit pins for followSelection (selectionFollow.ts) — the selection → clip-view
// matrix, owner-confirmed Live 12 behaviour.

import { describe, it, expect } from "vitest";
import { followSelection } from "./selectionFollow";

describe("followSelection", () => {
  it("clicking a clip opens its view (single-select emits a fresh set)", () => {
    expect(followSelection(new Set(), new Set(["c1"]), null, false)).toEqual({ open: "c1" });
  });

  it("the click that starts a drag also opens (select happens at pointer-down)", () => {
    expect(followSelection(new Set(["c2"]), new Set(["c1"]), "c2", false)).toEqual({ open: "c1" });
  });

  it("additive-ADD opens the added clip's view", () => {
    expect(followSelection(new Set(["c1"]), new Set(["c1", "c2"]), "c1", false)).toEqual({ open: "c2" });
  });

  it("additive removal of the SHOWN clip closes the view", () => {
    expect(followSelection(new Set(["c1", "c2"]), new Set(["c2"]), "c1", false)).toBe("close");
  });

  it("additive removal of some OTHER clip keeps the shown view", () => {
    expect(followSelection(new Set(["c1", "c2"]), new Set(["c1"]), "c1", false)).toBeNull();
  });

  it("clearing the selection (track header / empty-lane click) closes the view", () => {
    expect(followSelection(new Set(["c1"]), new Set(), "c1", false)).toBe("close");
  });

  it("empty-lane DRAG does not close (the in-flight suppress)", () => {
    expect(followSelection(new Set(["c1"]), new Set(), "c1", true)).toBeNull();
  });

  it("nothing to close when no view is open and the selection empties", () => {
    expect(followSelection(new Set(["c1"]), new Set(), null, false)).toBeNull();
  });

  it("re-affirm: the same selected clip clicked after a manual close re-opens", () => {
    // select() emits a fresh set for the click; membership is unchanged and the
    // view was closed via the editor's ✕ (editingClipId null).
    expect(followSelection(new Set(["c1"]), new Set(["c1"]), null, false)).toEqual({ open: "c1" });
  });

  it("no churn: re-clicking the clip whose view is already open is a no-op", () => {
    expect(followSelection(new Set(["c1"]), new Set(["c1"]), "c1", false)).toBeNull();
  });
});
