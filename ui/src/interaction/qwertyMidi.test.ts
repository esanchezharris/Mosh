import { describe, expect, it } from "vitest";
import {
  qwertyPitch, qwertyControl, qwertyClaims, unshiftForQwerty, qwertyReduce,
  qwertyTargetTrackId, QWERTY_KEYS, QWERTY_DEFAULTS,
} from "./qwertyMidi";
import { KEYMAPS } from "./keymap";

const ev = (key: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; altKey: boolean; ctrlKey: boolean }> = {}) =>
  ({ key, ...mods });

describe("the key layout", () => {
  it("A..K are the white keys of an octave", () => {
    // A=C, S=D, D=E, F=F, G=G, H=A, J=B, K=C an octave up. Octave 3 puts A at C3 = 48.
    expect(["A", "S", "D", "F", "G", "H", "J", "K"].map((k) => qwertyPitch(k, 3)))
      .toEqual([48, 50, 52, 53, 55, 57, 59, 60]);
  });

  it("W/E/T/Y/U are the black keys between them", () => {
    expect(["W", "E", "T", "Y", "U"].map((k) => qwertyPitch(k, 3))).toEqual([49, 51, 54, 56, 58]);
  });

  it("is case-insensitive (a shifted-off key still reports its pitch)", () => {
    expect(qwertyPitch("a", 4)).toBe(qwertyPitch("A", 4));
  });

  it("returns null for keys it does not own", () => {
    expect(qwertyPitch("Q", 3)).toBeNull();
    expect(qwertyPitch("Space", 3)).toBeNull();
  });

  it("never produces an out-of-range pitch at the octave extremes", () => {
    for (const oct of [-1, 0, 8]) {
      for (const k of QWERTY_KEYS) {
        const p = qwertyPitch(k, oct);
        if (p != null) expect(p).toBeGreaterThanOrEqual(0), expect(p).toBeLessThanOrEqual(127);
      }
    }
  });
});

describe("Z/X/C/V controls", () => {
  it("maps the four control keys", () => {
    expect(["Z", "X", "C", "V"].map(qwertyControl)).toEqual(["octDown", "octUp", "velDown", "velUp"]);
    expect(qwertyControl("A")).toBeNull();
  });

  it("clamps octave and velocity to usable ranges", () => {
    let s = { ...QWERTY_DEFAULTS };
    for (let i = 0; i < 20; i++) s = qwertyReduce(s, "Z");
    expect(s.octave).toBe(-1);
    for (let i = 0; i < 40; i++) s = qwertyReduce(s, "X");
    expect(s.octave).toBe(8);
    for (let i = 0; i < 20; i++) s = qwertyReduce(s, "C");
    expect(s.velocity).toBe(1);
    for (let i = 0; i < 20; i++) s = qwertyReduce(s, "V");
    expect(s.velocity).toBe(127);
  });
});

describe("the Shift rule — how the instrument coexists with the app keymap", () => {
  it("claims its own keys only while active, and only unmodified", () => {
    expect(qwertyClaims(ev("A"), true)).toBe(true);
    expect(qwertyClaims(ev("A"), false)).toBe(false);           // off ⇒ A is just A
    expect(qwertyClaims(ev("A", { shiftKey: true }), true)).toBe(false);
    expect(qwertyClaims(ev("A", { metaKey: true }), true)).toBe(false);
    // Option is the app-wide bypass-snap modifier and must keep working during a drag.
    expect(qwertyClaims(ev("A", { altKey: true }), true)).toBe(false);
    expect(qwertyClaims(ev("Q"), true)).toBe(false);            // not one of its keys
  });

  it("hands Shift+<owned key> back to the keymap with the Shift stripped", () => {
    // This is what keeps Shift+S meaning SOLO rather than meaning nothing.
    expect(unshiftForQwerty(ev("S", { shiftKey: true }), true)).toMatchObject({ key: "S", shiftKey: false });
  });

  it("does not hand back keys it never owned, or anything while inactive", () => {
    expect(unshiftForQwerty(ev("Q", { shiftKey: true }), true)).toBeNull();
    expect(unshiftForQwerty(ev("S", { shiftKey: true }), false)).toBeNull();
    expect(unshiftForQwerty(ev("S"), true)).toBeNull();          // no Shift to strip
  });

  it("every note key it claims is otherwise unbound in every DAW preset", () => {
    // If a preset bound a bare note letter, turning the instrument on would silently
    // shadow that shortcut with no Shift escape available for it.
    //
    // ONE documented exception class: the ableton preset's bare X and Z (Live's
    // zoom-back / Zoom-to-Time-Selection) and A (Live's Automation Mode toggle).
    // The Shift escape DOES exist for them —
    // unshiftForQwerty retries Shift+<owned key> against the keymap with the Shift
    // stripped, so Shift+X/Shift+Z/Shift+A still fire while the keyboard is armed.
    // That is Ableton's own published rule ("single-letter shortcuts need Shift while
    // the computer MIDI keyboard is on"), not a shadow.
    const isAllowedException = (preset: string, combo: string) =>
      preset === "ableton" && (combo === "X" || combo === "Z" || combo === "A");
    const noteKeys = [...QWERTY_KEYS];
    for (const [name, km] of Object.entries(KEYMAPS)) {
      for (const combo of Object.values(km).flatMap((c) => (Array.isArray(c) ? c : [c]))) {
        if (noteKeys.includes(combo as string) && !isAllowedException(name, combo as string)) {
          throw new Error(`preset "${name}" binds a bare QWERTY note key: ${combo}`);
        }
      }
    }
  });
});

describe("qwertyTargetTrackId", () => {
  const tracks = [
    { id: "t1", clips: [{ id: "c1" }] },
    { id: "t2", clips: [{ id: "c2" }] },
  ];

  it("plays into the track owning the clip being edited", () => {
    expect(qwertyTargetTrackId(tracks, "c2", "t1")).toBe("t2");
  });

  it("falls back to the selected track when no editor is open", () => {
    expect(qwertyTargetTrackId(tracks, null, "t1")).toBe("t1");
  });

  it("is null when there is nothing to play into", () => {
    expect(qwertyTargetTrackId(tracks, null, null)).toBeNull();
    expect(qwertyTargetTrackId(undefined, null, null)).toBeNull();
  });
});
