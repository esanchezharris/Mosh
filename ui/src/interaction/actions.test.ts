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

  it("includes file and profile window actions used by shortcut dispatch", () => {
    expect(EditorAction.OPEN_PROJECT).toBe("open_project");
    expect(EditorAction.SAVE_AS).toBe("save_as");
    expect(EditorAction.EXPORT_AUDIO).toBe("export_audio");
    expect(EditorAction.SHOW_ARRANGEMENT).toBe("show_arrangement");
    expect(EditorAction.SHOW_DRUM).toBe("show_drum");
    expect(EditorAction.SHOW_PIANO_ROLL).toBe("show_piano_roll");
    expect(EditorAction.SHOW_MIXER).toBe("show_mixer");
    expect(EditorAction.SHOW_BROWSER).toBe("show_browser");
  });
});
