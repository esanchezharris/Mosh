// Direct unit coverage for the FS-B1 skill schema/validator (`validateSkillSlots`),
// exported from ./skills as the reusable "typed slots" layer of a SkillDefinition.
//
// skillHarness.test.ts already proves the validator end-to-end through runSkill for
// SET_TRACK_LEVEL_SKILL (string/number/boolean rejections), and
// commands.contract.test.ts proves every SKILL_CATALOG template statically ties to
// the real command surface. Neither exercises the validator directly as a standalone
// module, and neither ever hits the `enum` slot-type branch (only
// ADD_VOCAL_WITH_LYRICS_SKILL's optional `role` slot declares one). This file closes
// both gaps: direct validator unit tests (including enum accept/reject) plus a
// catalog-wide smoke proving the schema layer behaves uniformly across every skill's
// declared required slots.

import { describe, expect, it } from "vitest";
import {
  ADD_VOCAL_WITH_LYRICS_SKILL,
  SET_TRACK_LEVEL_SKILL,
  SKILL_CATALOG,
  validateSkillSlots,
  type SkillPrimitive,
  type SkillSlot,
} from "./skills";

/** Smallest in-range sample for a slot — proves the validator's schema shape only,
 *  independent of any skill's business-rule preconditions. */
function sampleValueForSlot(slot: SkillSlot): SkillPrimitive {
  if (slot.type === "number") {
    if (slot.min !== undefined) return slot.min;
    if (slot.max !== undefined) return Math.min(0, slot.max);
    return 0;
  }
  if (slot.type === "boolean") return true;
  if (slot.enum && slot.enum.length > 0) return slot.enum[0];
  return "sample";
}

function requiredOnlyFill(slots: readonly SkillSlot[]): Record<string, SkillPrimitive> {
  const fill: Record<string, SkillPrimitive> = {};
  for (const slot of slots) if (slot.required) fill[slot.name] = sampleValueForSlot(slot);
  return fill;
}

describe("validateSkillSlots", () => {
  it("rejects raw input that is not a plain object", () => {
    for (const bad of [null, undefined, 42, "trackId", true, ["11"]]) {
      const result = validateSkillSlots(SET_TRACK_LEVEL_SKILL, bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("must be an object");
    }
  });

  it("rejects an unknown slot key", () => {
    const result = validateSkillSlots(SET_TRACK_LEVEL_SKILL, { trackId: "1", db: -6, surprise: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unknown slot "surprise"');
  });

  it("rejects a missing required slot by name", () => {
    const result = validateSkillSlots(SET_TRACK_LEVEL_SKILL, { trackId: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('missing required slot "db"');
  });

  it("accepts an omitted optional slot and leaves it absent from the result", () => {
    const result = validateSkillSlots(SET_TRACK_LEVEL_SKILL, { trackId: "1", db: -6 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.prototype.hasOwnProperty.call(result.slots, "mute")).toBe(false);
  });

  it.each([
    ["string slot given a number", { trackId: 1, db: -6 }, 'slot "trackId" must be string'],
    ["number slot given a string", { trackId: "1", db: "-6" }, 'slot "db" must be number'],
    ["number slot given NaN", { trackId: "1", db: Number.NaN }, 'slot "db" must be finite'],
    [
      "number slot given Infinity",
      { trackId: "1", db: Number.POSITIVE_INFINITY },
      'slot "db" must be finite',
    ],
    ["number below its min", { trackId: "1", db: -60.5 }, 'slot "db" must be at least -60'],
    ["number above its max", { trackId: "1", db: 6.5 }, 'slot "db" must be at most 6'],
    ["boolean slot given a string", { trackId: "1", db: -6, mute: "true" }, 'slot "mute" must be boolean'],
  ])("rejects %s", (_label, raw, expectedFragment) => {
    const result = validateSkillSlots(SET_TRACK_LEVEL_SKILL, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(expectedFragment);
  });

  it("rejects a string slot value outside its declared enum", () => {
    const result = validateSkillSlots(ADD_VOCAL_WITH_LYRICS_SKILL, {
      trackId: "1",
      seedText: "on my own",
      role: "chorus",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toBe(
        'add_vocal_with_lyrics: slot "role" must be one of verse, hook, bridge, adlib',
      );
  });

  it("accepts a string slot value inside its declared enum", () => {
    const result = validateSkillSlots(ADD_VOCAL_WITH_LYRICS_SKILL, {
      trackId: "1",
      seedText: "on my own",
      role: "bridge",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slots.role).toBe("bridge");
  });

  it("returns a fresh slots object decoupled from the caller's input", () => {
    const raw = { trackId: "1", db: -6 };
    const result = validateSkillSlots(SET_TRACK_LEVEL_SKILL, raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).not.toBe(raw);
    raw.db = 6;
    expect(result.slots.db).toBe(-6);
  });

  it("passes a required-slots-only fill for every skill in SKILL_CATALOG", () => {
    expect(SKILL_CATALOG.length).toBeGreaterThan(0);
    for (const skill of SKILL_CATALOG) {
      const fill = requiredOnlyFill(skill.slots);
      const result = validateSkillSlots(skill, fill);
      expect(result.ok, `${skill.name}: ${result.ok ? "" : result.reason}`).toBe(true);
      if (result.ok) expect(result.slots).toEqual(fill);
    }
  });
});
