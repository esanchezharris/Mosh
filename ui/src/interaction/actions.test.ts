import { describe, it, expect } from "vitest";
import { EditorAction } from "./actions";
import { getKeymap, resolveKey, type KeyEventLike } from "./keymap";

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

  it("uses the shared file and window vocabulary in FL shortcut resolution", () => {
    const keymap = getKeymap("fl");
    const cases: [KeyEventLike, string][] = [
      [{ key: "o", metaKey: true }, EditorAction.OPEN_PROJECT],
      [{ key: "s", metaKey: true, shiftKey: true }, EditorAction.SAVE_AS],
      [{ key: "r", metaKey: true }, EditorAction.EXPORT_AUDIO],
      [{ key: "F5" }, EditorAction.SHOW_ARRANGEMENT],
      [{ key: "F6" }, EditorAction.SHOW_DRUM],
      [{ key: "F7" }, EditorAction.SHOW_PIANO_ROLL],
      [{ key: "F9" }, EditorAction.SHOW_MIXER],
      [{ key: "F8", altKey: true }, EditorAction.SHOW_BROWSER],
    ];
    expect(cases.map(([event]) => resolveKey(keymap, event))).toEqual(cases.map(([, action]) => action));
  });
});
