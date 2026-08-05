// CAP-AUT-006 — the mute button follows its curve.
//
// The rule under test is a three-way one and every part of it has a failure mode that
// looks fine in a screenshot:
//   - lit must follow SILENCE, or a curve-muted track shows an open button while it is
//     inaudible;
//   - aria-pressed must keep following the ROUTING mute, or a screen-reader user is told
//     the control is pressed and then pressing it does something unrecognisable;
//   - "automated" must be distinguishable from "muted", or a button that moves on its own
//     has no visible reason for it.
//
// Presence in the automation map is the automated signal, not the boolean — a track whose
// curve currently has it OPEN is still automated, and that distinction is exactly what an
// `automation[id] === true` check would silently drop.

import { describe, expect, it } from "vitest";
import { muteButtonState } from "./muteState";

const track = (over: Partial<{ id: string; mute: boolean }> = {}) => ({ id: "t1", ...over });

describe("muteButtonState (CAP-AUT-006)", () => {
  it("an un-automated track behaves exactly as before", () => {
    const s = muteButtonState(track(), {}, "m");
    expect(s.silenced).toBe(false);
    expect(s.automated).toBe(false);
    expect(s.pressed).toBe(false);
    expect(s.className).toBe("m");
    expect(s.label).toBe("Mute");
  });

  it("the routing mute still lights the button", () => {
    const s = muteButtonState(track({ mute: true }), {}, "m");
    expect(s.silenced).toBe(true);
    expect(s.pressed).toBe(true);
    expect(s.className).toContain("on");
    expect(s.className).not.toContain("automated");
  });

  it("a curve that has the track muted lights it too — lit means silent", () => {
    const s = muteButtonState(track(), { t1: true }, "m");
    expect(s.silenced, "curve-muted track must not show an open button").toBe(true);
    expect(s.mutedByAutomation).toBe(true);
    expect(s.className).toContain("on");
  });

  it("aria-pressed keeps reporting the routing mute, not the curve", () => {
    const s = muteButtonState(track({ mute: false }), { t1: true }, "m");
    expect(s.silenced).toBe(true);
    expect(s.pressed, "aria-pressed must describe what the click toggles").toBe(false);
  });

  it("an automated-but-currently-open curve still marks the button automated", () => {
    const s = muteButtonState(track(), { t1: false }, "m");
    expect(s.automated).toBe(true);
    expect(s.mutedByAutomation).toBe(false);
    expect(s.silenced, "the curve is open here — nothing is silencing this track").toBe(false);
    expect(s.className).toContain("automated");
    expect(s.className).not.toContain("on");
  });

  it("says which mute is in force, so a button moving on its own is explainable", () => {
    expect(muteButtonState(track(), { t1: true }, "m").label).toBe("Mute — muted by automation");
    expect(muteButtonState(track(), { t1: false }, "m").label).toBe("Mute — automated");
    expect(muteButtonState(track({ mute: true }), {}, "m").label).toBe("Mute");
  });

  it("only reads its OWN track's entry", () => {
    const s = muteButtonState(track({ id: "t2" }), { t1: true }, "m");
    expect(s.automated).toBe(false);
    expect(s.silenced).toBe(false);
  });

  it("both routes at once stays lit and stays automated", () => {
    const s = muteButtonState(track({ mute: true }), { t1: true }, "m");
    expect(s.silenced).toBe(true);
    expect(s.pressed).toBe(true);
    expect(s.className).toContain("on");
    expect(s.className).toContain("automated");
  });

  it("survives a missing track / missing rail", () => {
    expect(muteButtonState(null, undefined).silenced).toBe(false);
    expect(muteButtonState(undefined, {}).automated).toBe(false);
  });
});
