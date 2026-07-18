import { describe, it, expect } from "vitest";
import { EditorAction as A } from "./actions";
import {
  eventToCombo,
  canonicalCombo,
  resolveKey,
  getKeymap,
  shortcutRows,
  KEYMAPS,
  type ScopedKeymap,
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

  it("keeps Mosh export on Mod+E", () => {
    expect(resolveKey(km, ev({ key: "e", metaKey: true }))).toBe(A.EXPORT_AUDIO);
  });
});

describe("scoped shortcut resolution", () => {
  it("checks the focused scope before falling back to global", () => {
    const map: ScopedKeymap = {
      global: { [A.EXPORT_AUDIO]: "Mod+B", [A.SAVE]: "Mod+S" },
      arrangement: { [A.DUPLICATE]: "Mod+B" },
    };
    expect(resolveKey(map, ev({ key: "b", metaKey: true }), "arrangement")).toBe(A.DUPLICATE);
    expect(resolveKey(map, ev({ key: "s", metaKey: true }), "arrangement")).toBe(A.SAVE);
    expect(resolveKey(map, ev({ key: "b", metaKey: true }), "pianoRoll")).toBe(A.EXPORT_AUDIO);
  });

  it("produces visible rows from the same effective scoped bindings", () => {
    const rows = shortcutRows(getKeymap("fl"), "arrangement");
    expect(rows.find((row) => row.action === A.DUPLICATE)).toMatchObject({ combo: "Mod+B", label: "Duplicate" });
    expect(rows.find((row) => row.action === A.EXPORT_AUDIO)).toMatchObject({ combo: "Mod+R", label: "Export audio" });
    expect(rows.some((row) => row.combo === "Mod+E")).toBe(false);
  });
});

describe("per-DAW keymaps", () => {
  it("getKeymap falls back to mosh for an unknown name", () => {
    expect(getKeymap("nope")).toBe(KEYMAPS.mosh);
  });
  it("ableton binds split-at-playhead to Mod+E while FL reserves it and Mosh exports", () => {
    expect(resolveKey(getKeymap("ableton"), ev({ key: "e", metaKey: true }))).toBe(A.SPLIT);
    expect(resolveKey(getKeymap("fl"), ev({ key: "e", metaKey: true }))).toBeNull();
    expect(resolveKey(getKeymap("mosh"), ev({ key: "e", metaKey: true }))).toBe(A.EXPORT_AUDIO);
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
  it("FL v1 exposes its supported global, arrangement, and window bindings", () => {
    const fl = getKeymap("fl");
    const cases: [Partial<KeyEventLike>, string][] = [
      [{ key: " " }, A.PLAY_PAUSE],
      [{ key: "r" }, A.RECORD],
      [{ key: "o", metaKey: true }, A.OPEN_PROJECT],
      [{ key: "s", metaKey: true }, A.SAVE],
      [{ key: "s", metaKey: true, shiftKey: true }, A.SAVE_AS],
      [{ key: "r", metaKey: true }, A.EXPORT_AUDIO],
      [{ key: "z", metaKey: true }, A.UNDO],
      [{ key: "z", metaKey: true, shiftKey: true }, A.REDO],
      [{ key: "b", metaKey: true }, A.DUPLICATE],
      [{ key: "c" }, A.TOOL_SPLIT],
      [{ key: "e" }, A.TOOL_RANGE],
      [{ key: "F5" }, A.SHOW_ARRANGEMENT],
      [{ key: "F6" }, A.SHOW_DRUM],
      [{ key: "F7" }, A.SHOW_PIANO_ROLL],
      [{ key: "F9" }, A.SHOW_MIXER],
      [{ key: "F8", altKey: true }, A.SHOW_BROWSER],
    ];
    for (const [event, action] of cases)
      expect(resolveKey(fl, ev(event), "arrangement"), JSON.stringify(event)).toBe(action);
    expect(resolveKey(fl, ev({ key: "e", metaKey: true }), "arrangement")).toBeNull();
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
    const km: ScopedKeymap = {
      ...getKeymap("mosh"),
      global: { ...getKeymap("mosh").global, [A.PLAY_PAUSE]: "Mod+P" },
    };
    expect(resolveKey(km, ev({ key: "p", metaKey: true }))).toBe(A.PLAY_PAUSE);
    expect(resolveKey(km, ev({ key: " " }))).toBeNull(); // old binding gone
  });
});
