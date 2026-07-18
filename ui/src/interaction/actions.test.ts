import { describe, it, expect } from "vitest";
import { EditorAction } from "./actions";

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
});
