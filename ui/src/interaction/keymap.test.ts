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
  it("ableton binds split-at-playhead to Mod+E", () => {
    expect(resolveKey(getKeymap("ableton"), ev({ key: "e", metaKey: true }))).toBe(A.SPLIT);
  });
  it("every preset keeps undo on Mod+Z (shared core)", () => {
    for (const name of ["mosh", "ableton", "fl"])
      expect(resolveKey(getKeymap(name), ev({ key: "z", metaKey: true }))).toBe(A.UNDO);
  });
});

describe("resolveKey — custom keymap overrides", () => {
  it("honours a rebind", () => {
    const km = { ...getKeymap("mosh"), [A.PLAY_PAUSE]: "Mod+P" };
    expect(resolveKey(km, ev({ key: "p", metaKey: true }))).toBe(A.PLAY_PAUSE);
    expect(resolveKey(km, ev({ key: " " }))).toBeNull(); // old binding gone
  });
});
