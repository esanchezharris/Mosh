import { describe, it, expect } from "vitest";
import { EditorAction as A, type EditorAction as Action } from "./actions";
import {
  eventToCombo,
  canonicalCombo,
  resolveKey,
  getKeymap,
  KEYMAPS,
  type KeyCombo,
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

  // macOS Option TRANSFORMS letter keys (⌥f → key "ƒ", ⌥⇧f → "Ï"), so the letter
  // must come from the physical code. Verified live in the packaged app: ⌥⇧⌘F
  // never dispatched before this (Playwright synthesizes untransformed keys, so
  // the e2e pin cannot catch this class).
  it("derives the letter from e.code when Alt is held (macOS Option transform)", () => {
    expect(eventToCombo(ev({ key: "ƒ", code: "KeyF", altKey: true }))).toBe("Alt+F");
    expect(eventToCombo(ev({ key: "Ï", code: "KeyF", metaKey: true, shiftKey: true, altKey: true })))
      .toBe("Mod+Shift+Alt+F");
    expect(eventToCombo(ev({ key: "´", code: "KeyE", metaKey: true, altKey: true }))).toBe("Mod+Alt+E");
  });

  it("Alt events without a letter code keep e.key (digits/punct/unavailable code)", () => {
    // no code at all — the pre-fix shape, unchanged
    expect(eventToCombo(ev({ key: "Z", altKey: true, shiftKey: true }))).toBe("Shift+Alt+Z");
    // non-letter codes: the transformed key stays (no binding names it, but the
    // combo format must not invent a letter)
    expect(eventToCombo(ev({ key: "¡", code: "Digit1", altKey: true }))).toBe("Alt+¡");
    expect(eventToCombo(ev({ key: "≠", code: "Equal", altKey: true }))).toBe("Alt+≠");
  });

  // ⇧= sends the shifted SYMBOL (key "+", US layout), but ZOOM_IN binds the
  // physical ⌘⇧= chord as "Mod+Shift+=" — so the `Equal` code normalizes the
  // shifted form back to "=". Same key-vs-physical class as the Option transform.
  it("⇧= normalizes to '=' from the Equal code (the physical ⌘⇧= zoom chord)", () => {
    expect(eventToCombo(ev({ key: "+", code: "Equal", metaKey: true, shiftKey: true }))).toBe("Mod+Shift+=");
    expect(eventToCombo(ev({ key: "+", code: "Equal", shiftKey: true }))).toBe("Shift+=");
    // without a code (synthetic events) the shifted symbol still rides e.key
    expect(eventToCombo(ev({ key: "+", metaKey: true, shiftKey: true }))).toBe("Mod+Shift++");
    // plain/Mod = arrives as "=" via e.key already — byte-identical, code or not
    expect(eventToCombo(ev({ key: "=", code: "Equal", metaKey: true }))).toBe("Mod+=");
    // the Alt pin above is untouched: ⌥⇧= keeps its transformed key
    expect(eventToCombo(ev({ key: "≠", code: "Equal", altKey: true }))).toBe("Alt+≠");
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
  it("pro tools: shell-owned grouping, tools, nudge, and Edit/Mix keys stay unclaimed", () => {
    const pt = getKeymap("protools");
    expect(resolveKey(pt, ev({ key: "e", metaKey: true }))).toBe(A.SPLIT);
    expect(resolveKey(pt, ev({ key: " ", metaKey: true }))).toBe(A.RECORD);
    expect(resolveKey(pt, ev({ key: "g", metaKey: true }))).toBeNull();
    expect(resolveKey(pt, ev({ key: "F7" }))).toBeNull();
    expect(resolveKey(pt, ev({ key: "F8" }))).toBeNull();
    expect(resolveKey(pt, ev({ key: "=", code: "Equal", metaKey: true }))).toBeNull();
    expect(resolveKey(pt, ev({ key: "+", code: "Equal", metaKey: true, shiftKey: true }))).toBeNull();
    expect(resolveKey(pt, ev({ key: "-", code: "Minus", metaKey: true }))).toBeNull();
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

describe("resolveKey — ableton Live-12 arrangement keys (SPEC §8)", () => {
  const km = getKeymap("ableton");

  it("binds the Live inventory to actions with real handlers", () => {
    expect(resolveKey(km, ev({ key: "e", metaKey: true }))).toBe(A.SPLIT);
    expect(resolveKey(km, ev({ key: "l", metaKey: true }))).toBe(A.LOOP_TOGGLE);
    expect(resolveKey(km, ev({ key: "r", metaKey: true }))).toBe(A.RENAME);
    expect(resolveKey(km, ev({ key: "0" }))).toBe(A.DEACTIVATE);
    expect(resolveKey(km, ev({ key: "1", metaKey: true }))).toBe(A.GRID_NARROW);
    expect(resolveKey(km, ev({ key: "2", metaKey: true }))).toBe(A.GRID_WIDEN);
    expect(resolveKey(km, ev({ key: "4", metaKey: true }))).toBe(A.SNAP_TOGGLE);
    expect(resolveKey(km, ev({ key: "=", metaKey: true }))).toBe(A.ZOOM_IN);
    expect(resolveKey(km, ev({ key: "-", metaKey: true }))).toBe(A.ZOOM_OUT);
  });

  it("⌘J and ⌘3 are bound (Wave 2 closed both gaps — consolidate_clips + the triplet snap)", () => {
    expect(resolveKey(km, ev({ key: "j", metaKey: true }))).toBe(A.CONSOLIDATE);
    expect(resolveKey(km, ev({ key: "3", metaKey: true }))).toBe(A.GRID_TRIPLET);
  });

  it("the other presets do NOT grow the Live bindings (per-preset, additive)", () => {
    for (const name of ["mosh", "fl", "protools", "logic"]) {
      expect(resolveKey(getKeymap(name), ev({ key: "l", metaKey: true })), name).toBeNull();
      expect(resolveKey(getKeymap(name), ev({ key: "0" })), name).toBeNull();
      expect(resolveKey(getKeymap(name), ev({ key: "1", metaKey: true })), name).toBeNull();
    }
  });
});

describe("resolveKey — ableton wave-0 menu bindings (menus.json ground truth)", () => {
  const km = getKeymap("ableton");

  it("binds the creation / quantize / selection inventory", () => {
    expect(resolveKey(km, ev({ key: "t", metaKey: true }))).toBe(A.INSERT_AUDIO_TRACK);
    expect(resolveKey(km, ev({ key: "t", metaKey: true, shiftKey: true }))).toBe(A.INSERT_MIDI_TRACK);
    expect(resolveKey(km, ev({ key: "m", metaKey: true, shiftKey: true }))).toBe(A.INSERT_MIDI_CLIP);
    expect(resolveKey(km, ev({ key: "u", metaKey: true }))).toBe(A.QUANTIZE);
    expect(resolveKey(km, ev({ key: "a", metaKey: true }))).toBe(A.SELECT_ALL);
    expect(resolveKey(km, ev({ key: "a", metaKey: true, shiftKey: true }))).toBe(A.INVERT_SELECTION);
    expect(resolveKey(km, ev({ key: "l", metaKey: true, shiftKey: true }))).toBe(A.SELECT_LOOP);
    // Duplicate rides the shared MOSH core (⌘D) — pinned here because it IS Live's binding.
    expect(resolveKey(km, ev({ key: "d", metaKey: true }))).toBe(A.DUPLICATE);
  });

  it("deactivate takes BOTH of Live's forms — plain 0 and ⌘0", () => {
    expect(resolveKey(km, ev({ key: "0" }))).toBe(A.DEACTIVATE);
    expect(resolveKey(km, ev({ key: "0", metaKey: true }))).toBe(A.DEACTIVATE);
  });

  it("the other presets do NOT grow the wave-0 bindings", () => {
    for (const name of ["mosh", "fl", "protools", "logic"]) {
      expect(resolveKey(getKeymap(name), ev({ key: "t", metaKey: true, shiftKey: true })), name).toBeNull();
      expect(resolveKey(getKeymap(name), ev({ key: "u", metaKey: true })), name).toBeNull();
      expect(resolveKey(getKeymap(name), ev({ key: "l", metaKey: true, shiftKey: true })), name).toBeNull();
    }
  });
});

describe("resolveKey — ableton wave-2 bindings (consolidate / triplet / zoom-back / find)", () => {
  const km = getKeymap("ableton");
  it("binds them", () => {
    expect(resolveKey(km, ev({ key: "j", metaKey: true }))).toBe(A.CONSOLIDATE);
    expect(resolveKey(km, ev({ key: "3", metaKey: true }))).toBe(A.GRID_TRIPLET);
    expect(resolveKey(km, ev({ key: "x" }))).toBe(A.ZOOM_BACK);
    expect(resolveKey(km, ev({ key: "f", metaKey: true }))).toBe(A.FIND);
  });
  it("the other presets stay free of them", () => {
    for (const name of ["mosh", "fl", "protools", "logic"]) {
      expect(resolveKey(getKeymap(name), ev({ key: "j", metaKey: true })), name).toBeNull();
      expect(resolveKey(getKeymap(name), ev({ key: "3", metaKey: true })), name).toBeNull();
      expect(resolveKey(getKeymap(name), ev({ key: "x" })), name).toBeNull();
    }
  });
});

describe("resolveKey — ableton expanded clip view (⌥⌘E)", () => {
  it("binds Alt+Mod+E, and only in the ableton preset", () => {
    expect(resolveKey(getKeymap("ableton"), ev({ key: "e", metaKey: true, altKey: true }))).toBe(A.EXPAND_CLIP);
    for (const name of ["mosh", "fl", "protools", "logic"])
      expect(resolveKey(getKeymap(name), ev({ key: "e", metaKey: true, altKey: true })), name).toBeNull();
  });
});

describe("resolveKey — ableton keymap-audit wave", () => {
  const km = getKeymap("ableton");

  it("binds the new inventory", () => {
    expect(resolveKey(km, ev({ key: "ArrowUp" }))).toBe(A.NUDGE_UP);
    expect(resolveKey(km, ev({ key: "ArrowDown" }))).toBe(A.NUDGE_DOWN);
    expect(resolveKey(km, ev({ key: "g", metaKey: true, shiftKey: true }))).toBe(A.UNGROUP);
    expect(resolveKey(km, ev({ key: "i", metaKey: true }))).toBe(A.INSERT_SILENCE);
    expect(resolveKey(km, ev({ key: "f", metaKey: true, altKey: true }))).toBe(A.CREATE_FADE);
    expect(resolveKey(km, ev({ key: "z" }))).toBe(A.ZOOM_TO_SELECTION);   // Z = Zoom to Time Selection
    expect(resolveKey(km, ev({ key: "x" }))).toBe(A.ZOOM_BACK);           // X = Zoom Back (history pop)
  });

  it("⌘+ works in BOTH physical forms (⌘= and ⌘⇧=)", () => {
    expect(resolveKey(km, ev({ key: "=", metaKey: true }))).toBe(A.ZOOM_IN);
    expect(resolveKey(km, ev({ key: "=", metaKey: true, shiftKey: true }))).toBe(A.ZOOM_IN);
    // real macOS hardware sends key "+" for ⌘⇧= (the shifted symbol) — resolved
    // through the Equal code (Playwright's synthesized keys never exposed this).
    expect(resolveKey(km, ev({ key: "+", code: "Equal", metaKey: true, shiftKey: true }))).toBe(A.ZOOM_IN);
  });

  it("bare 1/2/3 are free in the ableton preset only (modal tools dropped)", () => {
    expect(resolveKey(km, ev({ key: "1" }))).toBeNull();
    expect(resolveKey(km, ev({ key: "2" }))).toBeNull();
    expect(resolveKey(km, ev({ key: "3" }))).toBeNull();
    // …and kept in the presets that use the shared modal-tool vocabulary.
    for (const name of ["mosh", "fl", "logic"]) {
      expect(resolveKey(getKeymap(name), ev({ key: "1" })), name).not.toBeNull();
    }
    for (const key of ["1", "2", "3"])
      expect(resolveKey(getKeymap("protools"), ev({ key })), key).toBeNull();
  });

  it("the new bindings stay ableton-only", () => {
    for (const name of ["mosh", "fl", "protools", "logic"]) {
      expect(resolveKey(getKeymap(name), ev({ key: "i", metaKey: true })), name).toBeNull();
      expect(resolveKey(getKeymap(name), ev({ key: "g", metaKey: true, shiftKey: true })), name).toBeNull();
      expect(resolveKey(getKeymap(name), ev({ key: "f", metaKey: true, altKey: true })), name).toBeNull();
      expect(resolveKey(getKeymap(name), ev({ key: "z" })), name).toBeNull();
    }
  });
});


describe("resolveKey — Alt+letter bindings resolve from macOS Option-transformed events", () => {
  // The live bug: on real macOS hardware ⌥⇧⌘F sends key "Ï" (⌥f sends "ƒ"), so
  // the event never matched "Mod+Shift+Alt+F". The letter comes from e.code now.
  // Every Alt+letter binding in every preset is covered by the sweep below; these
  // three pin the concrete transformed keys macOS actually sends.
  const km = getKeymap("ableton");
  it("⌥⇧⌘F (key 'Ï', code 'KeyF') → FREEZE_TRACK", () => {
    expect(resolveKey(km, ev({ key: "Ï", code: "KeyF", metaKey: true, shiftKey: true, altKey: true })))
      .toBe(A.FREEZE_TRACK);
  });
  it("⌥⌘F (key 'ƒ', code 'KeyF') → CREATE_FADE", () => {
    expect(resolveKey(km, ev({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true })))
      .toBe(A.CREATE_FADE);
  });
  it("⌥⌘E (key '´', code 'KeyE') → EXPAND_CLIP", () => {
    expect(resolveKey(km, ev({ key: "´", code: "KeyE", metaKey: true, altKey: true })))
      .toBe(A.EXPAND_CLIP);
  });
});

describe("Alt-combo sweep — every Alt+letter binding in every preset", () => {
  // Walks KEYMAPS itself (not a hand-list), so a future Alt+letter binding is
  // covered the moment it lands: build the macOS-transformed event for the combo
  // (key is NOT the letter — 'Ï' stands in for whatever Option produced) and
  // require resolution from the code-derived letter.
  it("all resolve from code-derived letters, and the sweep is non-empty", () => {
    let swept = 0;
    for (const [preset, km] of Object.entries(KEYMAPS)) {
      for (const [action, bound] of Object.entries(km) as [Action, KeyCombo | KeyCombo[]][]) {
        for (const combo of Array.isArray(bound) ? bound : [bound]) {
          const canonical = canonicalCombo(combo);
          const parts = canonical.split("+");
          const letter = parts[parts.length - 1];
          if (!parts.includes("Alt") || !/^[A-Z]$/.test(letter)) continue;
          swept++;
          const action_ = resolveKey(km, {
            key: "Ï",   // any Option-transformed char — proof the code path wins
            code: `Key${letter}`,
            metaKey: parts.includes("Mod"),
            shiftKey: parts.includes("Shift"),
            altKey: true,
          });
          expect(action_, `${preset}: ${combo} (${canonical})`).toBe(action);
        }
      }
    }
    expect(swept).toBeGreaterThanOrEqual(3);   // CREATE_FADE, FREEZE_TRACK, EXPAND_CLIP today
  });
});
