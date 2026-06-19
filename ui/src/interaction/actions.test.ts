import { describe, it, expect } from "vitest";
import {
  EditorAction,
  ALL_ACTIONS,
  isEditorAction,
  REGIONS,
  type Region,
} from "./actions";

// The editor-action vocabulary is the shared alphabet both resolvers (keymap +
// gesture table) speak. These tests pin the set's completeness, the uniqueness of
// the string values (they're persisted in templates/localStorage), and the region
// hierarchy used for CSS-like precedence.

describe("EditorAction", () => {
  it("enumerates the editor's action vocabulary", () => {
    // a representative spread the spec calls out — pointer + keyboard
    for (const a of [
      "SELECT", "MOVE", "TIME_SELECT", "OPEN", "TRIM", "SPLIT", "DESELECT",
      "MARQUEE", "SEEK", "LOOP_REGION", "DELETE", "COPY", "PASTE", "UNDO",
      "REDO", "PLAY_PAUSE",
    ]) {
      expect(EditorAction[a as keyof typeof EditorAction], a).toBeTruthy();
    }
  });

  it("has unique string values (they persist in templates/localStorage)", () => {
    const vals = Object.values(EditorAction);
    expect(new Set(vals).size).toBe(vals.length);
  });

  it("ALL_ACTIONS mirrors the value set", () => {
    expect([...ALL_ACTIONS].sort()).toEqual(Object.values(EditorAction).sort());
  });

  it("isEditorAction recognises members and rejects strangers", () => {
    expect(isEditorAction("move")).toBe(true);
    expect(isEditorAction(EditorAction.LOOP_REGION)).toBe(true);
    expect(isEditorAction("frobnicate")).toBe(false);
    expect(isEditorAction("")).toBe(false);
  });
});

describe("REGIONS", () => {
  it("names the formalised DOM regions, dotted for hierarchy", () => {
    const r = REGIONS as readonly Region[];
    expect(r).toContain("clip.header");
    expect(r).toContain("clip.body");
    expect(r).toContain("clip.edge");
    expect(r).toContain("empty");
    expect(r).toContain("ruler");
  });
});
