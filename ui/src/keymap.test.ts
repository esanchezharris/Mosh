import { describe, it, expect } from "vitest";
import { matchShortcut, DEFAULT_KEYMAP, type KeyEventLike } from "./keymap";

// Build a minimal KeyboardEvent-like object for the pure matcher.
const ev = (key: string, o: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  code: o.code,
  metaKey: o.metaKey ?? false,
  ctrlKey: o.ctrlKey ?? false,
  shiftKey: o.shiftKey ?? false,
});

const id = (e: KeyEventLike) => matchShortcut(e)?.id ?? null;

describe("matchShortcut — File accelerators", () => {
  it("⌘N → new_project, ⌘O → open_project, ⌘E → export_audio", () => {
    expect(id(ev("n", { metaKey: true }))).toBe("new_project");
    expect(id(ev("o", { metaKey: true }))).toBe("open_project");
    expect(id(ev("e", { metaKey: true }))).toBe("export_audio");
  });
  it("⌘S → save but ⇧⌘S → save_as (shift disambiguates)", () => {
    expect(id(ev("s", { metaKey: true }))).toBe("save");
    expect(id(ev("s", { metaKey: true, shiftKey: true }))).toBe("save_as");
  });
});

describe("matchShortcut — Edit accelerators", () => {
  it("⌘Z → undo, ⇧⌘Z → redo", () => {
    expect(id(ev("z", { metaKey: true }))).toBe("undo");
    expect(id(ev("z", { metaKey: true, shiftKey: true }))).toBe("redo");
  });
  it("⌘X/⌘C/⌘V → cut/copy/paste", () => {
    expect(id(ev("x", { metaKey: true }))).toBe("cut");
    expect(id(ev("c", { metaKey: true }))).toBe("copy");
    expect(id(ev("v", { metaKey: true }))).toBe("paste");
  });
  it("Delete and Backspace both → delete", () => {
    expect(id(ev("Delete"))).toBe("delete");
    expect(id(ev("Backspace"))).toBe("delete");
  });
});

describe("matchShortcut — transport + modifiers", () => {
  it("Space (by code) → play_pause", () => {
    expect(id(ev(" ", { code: "Space" }))).toBe("play_pause");
  });
  it("treats Ctrl as a Mod equivalent (cross-platform)", () => {
    expect(id(ev("s", { ctrlKey: true }))).toBe("save");
    expect(id(ev("z", { ctrlKey: true }))).toBe("undo");
  });
  it("requires the Mod key for Mod shortcuts (bare letters do not match)", () => {
    expect(id(ev("s"))).toBe(null);
    expect(id(ev("z"))).toBe(null);
  });
  it("does NOT fire play_pause when a Mod is held (⌘Space stays Spotlight)", () => {
    expect(id(ev(" ", { code: "Space", metaKey: true }))).toBe(null);
  });
  it("returns null for an unbound key", () => {
    expect(id(ev("a"))).toBe(null);
    expect(id(ev("F1"))).toBe(null);
  });
});

describe("DEFAULT_KEYMAP — native-menu ownership", () => {
  const def = (i: string) => DEFAULT_KEYMAP.find((d) => d.id === i)!;
  it("flags File + Edit Mod-accelerators as native-menu-owned (yield in the native app)", () => {
    for (const i of ["new_project", "open_project", "save", "save_as", "export_audio", "undo", "redo", "cut", "copy", "paste"])
      expect(def(i).nativeMenuOwned, `${i} should be native-menu-owned`).toBe(true);
  });
  it("keeps focus-sensitive / non-accelerator shortcuts owned by the web layer", () => {
    // Delete has no native key-equivalent (would hijack ⌫ in text fields); Space stays JS.
    expect(DEFAULT_KEYMAP.filter((d) => d.id === "delete").every((d) => !d.nativeMenuOwned)).toBe(true);
    expect(def("play_pause").nativeMenuOwned).toBe(false);
  });
});
