import type { Snapshot } from "../types";

export type SkillPrimitive = string | number | boolean;
export type SkillSlotValues = Readonly<Record<string, SkillPrimitive>>;

type SkillSlotBase = {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
};

export type SkillSlot =
  | (SkillSlotBase & { readonly type: "string"; readonly enum?: readonly string[] })
  | (SkillSlotBase & { readonly type: "number"; readonly min?: number; readonly max?: number })
  | (SkillSlotBase & { readonly type: "boolean" });

export type SkillValue = SkillPrimitive | { readonly slot: string };

export type SkillCommandNode = {
  readonly kind: "command";
  readonly command: string;
  readonly args: Readonly<Record<string, SkillValue>>;
};

export type SkillConditionalNode = {
  readonly kind: "if_present";
  readonly slot: string;
  readonly then: readonly SkillTemplateNode[];
};

export type SkillTemplateNode = SkillCommandNode | SkillConditionalNode;

export type SkillCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type SkillExecutionSummary = {
  readonly applied: number;
  readonly entries: readonly {
    readonly index: number;
    readonly command: string;
    readonly summary: string;
    readonly ok: boolean;
    readonly error?: string;
  }[];
};

export type SkillDefinition = {
  readonly name: string;
  readonly description: string;
  readonly slots: readonly SkillSlot[];
  readonly template: readonly SkillTemplateNode[];
  readonly precondition: (snapshot: Snapshot, slots: SkillSlotValues) => SkillCheck;
  readonly postcondition: (
    before: Snapshot,
    after: Snapshot,
    slots: SkillSlotValues,
    execution: SkillExecutionSummary,
  ) => SkillCheck;
};

export type SkillSlotValidation =
  | { readonly ok: true; readonly slots: SkillSlotValues }
  | { readonly ok: false; readonly reason: string };

const owns = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strictly validate a router fill before any snapshot precondition or MoshOps call. */
export function validateSkillSlots(skill: SkillDefinition, raw: unknown): SkillSlotValidation {
  if (!isRecord(raw))
    return { ok: false, reason: `${skill.name}: slots must be an object` };

  const source = raw;
  const byName = new Map(skill.slots.map((slot) => [slot.name, slot]));
  for (const key of Object.keys(source)) {
    if (!byName.has(key)) return { ok: false, reason: `${skill.name}: unknown slot "${key}"` };
  }

  const slots: Record<string, SkillPrimitive> = {};
  for (const slot of skill.slots) {
    if (!owns(source, slot.name)) {
      if (slot.required) return { ok: false, reason: `${skill.name}: missing required slot "${slot.name}"` };
      continue;
    }

    const value = source[slot.name];
    if (slot.type === "number") {
      if (typeof value !== "number")
        return { ok: false, reason: `${skill.name}: slot "${slot.name}" must be number` };
      if (!Number.isFinite(value))
        return { ok: false, reason: `${skill.name}: slot "${slot.name}" must be finite` };
      if (slot.min !== undefined && value < slot.min)
        return { ok: false, reason: `${skill.name}: slot "${slot.name}" must be at least ${slot.min}` };
      if (slot.max !== undefined && value > slot.max)
        return { ok: false, reason: `${skill.name}: slot "${slot.name}" must be at most ${slot.max}` };
      slots[slot.name] = value;
      continue;
    }

    if (slot.type === "string") {
      if (typeof value !== "string")
        return { ok: false, reason: `${skill.name}: slot "${slot.name}" must be string` };
      if (slot.enum && !slot.enum.includes(value))
        return {
          ok: false,
          reason: `${skill.name}: slot "${slot.name}" must be one of ${slot.enum.join(", ")}`,
        };
      slots[slot.name] = value;
      continue;
    }

    if (typeof value !== "boolean")
      return { ok: false, reason: `${skill.name}: slot "${slot.name}" must be boolean` };
    slots[slot.name] = value;
  }

  return { ok: true, slots };
}

const trackFor = (snapshot: Snapshot, trackId: string) =>
  snapshot.tracks.find((track) => track.id === trackId);

export const SET_TRACK_LEVEL_SKILL: SkillDefinition = {
  name: "set_track_level",
  description: "Set the level of an existing session track, optionally muting or unmuting it.",
  slots: [
    {
      name: "trackId",
      type: "string",
      required: true,
      description: "Stable id of the existing track to adjust.",
    },
    {
      name: "db",
      type: "number",
      required: true,
      description: "Absolute track level in decibels.",
      min: -60,
      max: 6,
    },
    {
      name: "mute",
      type: "boolean",
      required: false,
      description: "Optional final mute state; omit to preserve it.",
    },
  ],
  template: [
    {
      kind: "command",
      command: "set_track_volume",
      args: { trackId: { slot: "trackId" }, db: { slot: "db" } },
    },
    {
      kind: "if_present",
      slot: "mute",
      then: [
        {
          kind: "command",
          command: "set_track_mute",
          args: { trackId: { slot: "trackId" }, mute: { slot: "mute" } },
        },
      ],
    },
  ],
  precondition: (snapshot, slots) => {
    const trackId = slots.trackId;
    if (typeof trackId !== "string")
      return { ok: false, reason: "set_track_level: validated trackId is unavailable." };
    const track = trackFor(snapshot, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" is no longer available.` };
    if (track.isGroup && owns(slots, "mute"))
      return { ok: false, reason: `Track "${trackId}" is a group and cannot be muted by this skill.` };
    return { ok: true };
  },
  postcondition: (before, after, slots) => {
    const trackId = slots.trackId;
    const requestedDb = slots.db;
    if (typeof trackId !== "string" || typeof requestedDb !== "number")
      return { ok: false, reason: "set_track_level: validated required slots are unavailable." };
    const beforeTrack = trackFor(before, trackId);
    const afterTrack = trackFor(after, trackId);
    if (!beforeTrack || !afterTrack)
      return { ok: false, reason: `Track "${trackId}" was not preserved.` };
    if (typeof afterTrack.volumeDb !== "number" || Math.abs(afterTrack.volumeDb - requestedDb) > 1e-6)
      return { ok: false, reason: `Track "${trackId}" did not reach ${requestedDb} dB.` };

    if (owns(slots, "mute")) {
      const requestedMute = slots.mute;
      if (typeof requestedMute !== "boolean")
        return { ok: false, reason: "set_track_level: validated mute slot is unavailable." };
      if (afterTrack.mute !== requestedMute)
        return { ok: false, reason: `Track "${trackId}" did not reach the requested mute state.` };
    } else if (afterTrack.mute !== beforeTrack.mute) {
      return { ok: false, reason: `Track "${trackId}" changed mute state unexpectedly.` };
    }

    return { ok: true };
  },
};

export const SKILL_CATALOG: readonly SkillDefinition[] = [SET_TRACK_LEVEL_SKILL];
