import { describe, it, expect } from "vitest";
import { EditorAction as A } from "./actions";
import {
  eventToCombo,
  canonicalCombo,
  resolveKey,
  getKeymap,
  KEYMAPS,
  type KeyEventLike,
} from "./keymap";

const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({ key: "a", ...over });

describe("eventToCombo", () => {
  it("folds Cmd and Ctrl into a platform-neutral Mod", () => {
    expect(eventToCombo(ev({ key: "z", metaKey: true }))).toBe("Mod+Z");
    expect(eventToCombo(ev({ key: "z", ctrlKey: true }))).toBe("Mod+Z");
  });

  it("orders modifiers Mod→Shift→Alt and uppercases letters", () => {
    expect(eventToCombo(ev({ key: "z", metaKey: true, shiftKey: true }))).toBe("Mod+Shift+Z");
    expect(eventToCombo(ev({ key: "Z", altKey: true, shiftKey: true }))).toBe("Shift+Alt+Z");
  });

  it("normalises Space and keeps named keys / digits", () => {
    expect(eventToCombo(ev({ key: " " }))).toBe("Space");
    expect(eventToCombo(ev({ key: "Delete" }))).toBe("Delete");
    expect(eventToCombo(ev({ key: "1" }))).toBe("1");
  });

  it("returns an empty combo for a lone modifier press", () => {
    expect(eventToCombo(ev({ key: "Shift", shiftKey: true }))).toBe("");
    expect(eventToCombo(ev({ key: "Meta", metaKey: true }))).toBe("");
  });
});

describe("canonicalCombo", () => {
  it("accepts loose written forms and normalises them", () => {
    expect(canonicalCombo("cmd+z")).toBe("Mod+Z");
    expect(canonicalCombo("Control+Shift+Z")).toBe("Mod+Shift+Z");
    expect(canonicalCombo("Shift+Mod+z")).toBe("Mod+Shift+Z"); // reorders
    expect(canonicalCombo("alt+space")).toBe("Alt+Space");
  });
});

describe("resolveKey — mosh keymap", () => {
  const km = getKeymap("mosh");
  it("resolves the core editor bindings", () => {
    expect(resolveKey(km, ev({ key: "z", metaKey: true }))).toBe(A.UNDO);
    expect(resolveKey(km, ev({ key: "z", metaKey: true, shiftKey: true }))).toBe(A.REDO);
    expect(resolveKey(km, ev({ key: " " }))).toBe(A.PLAY_PAUSE);
    expect(resolveKey(km, ev({ key: "c", metaKey: true }))).toBe(A.COPY);
    expect(resolveKey(km, ev({ key: "1" }))).toBe(A.TOOL_MOVE);
  });

  it("maps both Delete and Backspace to DELETE", () => {
    expect(resolveKey(km, ev({ key: "Delete" }))).toBe(A.DELETE);
    expect(resolveKey(km, ev({ key: "Backspace" }))).toBe(A.DELETE);
  });

  it("returns null for an unbound combo and for lone modifiers", () => {
    expect(resolveKey(km, ev({ key: "k", metaKey: true }))).toBeNull();
    expect(resolveKey(km, ev({ key: "Shift", shiftKey: true }))).toBeNull();
  });
});

describe("per-DAW keymaps", () => {
  it("getKeymap falls back to mosh for an unknown name", () => {
    expect(getKeymap("nope")).toBe(KEYMAPS.mosh);
  });
  it("ableton binds split-at-playhead to Mod+E; mosh leaves Mod+E unbound (split is tool-only)", () => {
    expect(resolveKey(getKeymap("ableton"), ev({ key: "e", metaKey: true }))).toBe(A.SPLIT);
    expect(resolveKey(getKeymap("fl"), ev({ key: "e", metaKey: true }))).toBe(A.SPLIT);
    expect(resolveKey(getKeymap("mosh"), ev({ key: "e", metaKey: true }))).toBeNull();
  });
  it("ableton moves record to F9 (R no longer records there)", () => {
    expect(resolveKey(getKeymap("ableton"), ev({ key: "F9" }))).toBe(A.RECORD);
    expect(resolveKey(getKeymap("ableton"), ev({ key: "r" }))).toBeNull();
    expect(resolveKey(getKeymap("mosh"), ev({ key: "r" }))).toBe(A.RECORD);
  });
  it("fl remaps duplicate to Mod+B (Mod+D no longer duplicates there)", () => {
    expect(resolveKey(getKeymap("fl"), ev({ key: "b", metaKey: true }))).toBe(A.DUPLICATE);
    expect(resolveKey(getKeymap("fl"), ev({ key: "d", metaKey: true }))).toBeNull();
    expect(resolveKey(getKeymap("mosh"), ev({ key: "d", metaKey: true }))).toBe(A.DUPLICATE);
  });
  it("pro tools: ⌘E separates, ⌘Space records, F7/F8 pick Selector/Grabber, Return → start", () => {
    const pt = getKeymap("protools");
    expect(resolveKey(pt, ev({ key: "e", metaKey: true }))).toBe(A.SPLIT);
    expect(resolveKey(pt, ev({ key: " ", metaKey: true }))).toBe(A.RECORD);
    expect(resolveKey(pt, ev({ key: "F7" }))).toBe(A.TOOL_RANGE);
    expect(resolveKey(pt, ev({ key: "F8" }))).toBe(A.TOOL_MOVE);
    expect(resolveKey(pt, ev({ key: "Enter" }))).toBe(A.TO_START);
    // differs from mosh: F7 unbound, Home → start, plain R still records on mosh
    expect(resolveKey(getKeymap("mosh"), ev({ key: "F7" }))).toBeNull();
    expect(resolveKey(getKeymap("mosh"), ev({ key: "Home" }))).toBe(A.TO_START);
  });
  it("logic: ⌘T splits at playhead, Return → start, R still records (from mosh core)", () => {
    const lg = getKeymap("logic");
    expect(resolveKey(lg, ev({ key: "t", metaKey: true }))).toBe(A.SPLIT);
    expect(resolveKey(lg, ev({ key: "Enter" }))).toBe(A.TO_START);
    expect(resolveKey(lg, ev({ key: "r" }))).toBe(A.RECORD);
    // logic does NOT use ⌘E (only ...MOSH, which leaves it unbound)
    expect(resolveKey(lg, ev({ key: "e", metaKey: true }))).toBeNull();
  });
  it("every preset keeps undo on Mod+Z (shared core)", () => {
    for (const name of ["mosh", "ableton", "fl", "protools", "logic"])
      expect(resolveKey(getKeymap(name), ev({ key: "z", metaKey: true }))).toBe(A.UNDO);
  });

  // FU-CLIP-NUDGE — plain arrow keys are unbound everywhere else, so every preset
  // (inherited from the shared MOSH core, none override it) binds them to nudge.
  it("every preset binds plain ArrowLeft/ArrowRight to clip nudge (shared core)", () => {
    for (const name of ["mosh", "ableton", "fl", "protools", "logic"]) {
      expect(resolveKey(getKeymap(name), ev({ key: "ArrowLeft" }))).toBe(A.NUDGE_LEFT);
      expect(resolveKey(getKeymap(name), ev({ key: "ArrowRight" }))).toBe(A.NUDGE_RIGHT);
    }
  });
});

describe("resolveKey — custom keymap overrides", () => {
  it("honours a rebind", () => {
    const km = { ...getKeymap("mosh"), [A.PLAY_PAUSE]: "Mod+P" };
    expect(resolveKey(km, ev({ key: "p", metaKey: true }))).toBe(A.PLAY_PAUSE);
    expect(resolveKey(km, ev({ key: " " }))).toBeNull(); // old binding gone
  });
});
