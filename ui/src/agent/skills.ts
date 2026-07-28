import type { Clip, Snapshot, Track } from "../types";

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

const clipFor = (
  snapshot: Snapshot,
  clipId: string,
): { readonly track: Track; readonly clip: Clip } | undefined => {
  for (const track of snapshot.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
};

const midiNoteClipCount = (track: Track): number =>
  track.clips.filter((clip) => clip.type === "midi" && (clip.notes?.length ?? 0) > 0).length;

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

// Set the song's tempo and time signature, then lay a starter drum groove — the
// standard "lay down a beat" workflow from a blank session.
export const ARRANGE_BEAT_SKILL: SkillDefinition = {
  name: "arrange_beat",
  description:
    "Set the song's tempo and time signature, then lay a starter drum groove — the standard \"lay down a beat\" workflow from a blank session.",
  slots: [
    {
      name: "bpm",
      type: "number",
      required: true,
      description: "Project tempo in BPM.",
      min: 20,
      max: 300,
    },
    {
      name: "numerator",
      type: "number",
      required: true,
      description: "Time-signature numerator (beats per bar).",
      min: 1,
      max: 32,
    },
    {
      name: "denominator",
      type: "number",
      required: true,
      description: "Time-signature denominator (the note value that gets one beat, e.g. 4).",
      min: 1,
      max: 32,
    },
    {
      name: "pattern",
      type: "string",
      required: true,
      description:
        'Drum lane pattern string, e.g. "kick: x...x...x...x...; snare: ....x.......x...". Lands on a fresh Drums track.',
    },
    {
      name: "metronome",
      type: "boolean",
      required: false,
      description: "Turn the click on/off while sketching the beat.",
    },
  ],
  template: [
    { kind: "command", command: "set_tempo", args: { bpm: { slot: "bpm" } } },
    {
      kind: "command",
      command: "set_time_signature",
      args: { numerator: { slot: "numerator" }, denominator: { slot: "denominator" } },
    },
    { kind: "command", command: "add_drum_pattern", args: { pattern: { slot: "pattern" } } },
    {
      kind: "if_present",
      slot: "metronome",
      then: [
        {
          kind: "command",
          command: "set_metronome",
          args: { enabled: { slot: "metronome" } },
        },
      ],
    },
  ],
  precondition: (snapshot, slots) => {
    const bpm = slots.bpm;
    if (typeof bpm !== "number")
      return { ok: false, reason: "arrange_beat: validated bpm slot is unavailable." };
    if (snapshot.transport.recording)
      return {
        ok: false,
        reason: "arrange_beat: cannot restructure tempo/time signature while recording is in progress.",
      };
    return { ok: true };
  },
  postcondition: (before, after, slots) => {
    const bpm = slots.bpm;
    const numerator = slots.numerator;
    const denominator = slots.denominator;
    if (typeof bpm !== "number" || typeof numerator !== "number" || typeof denominator !== "number")
      return { ok: false, reason: "arrange_beat: validated required slots are unavailable." };
    if (Math.abs(after.session.tempo - bpm) > 1e-6)
      return { ok: false, reason: `Tempo did not reach ${bpm} BPM.` };
    if (after.session.timeSigNumerator !== numerator || after.session.timeSigDenominator !== denominator)
      return { ok: false, reason: `Time signature did not reach ${numerator}/${denominator}.` };
    if (after.tracks.length <= before.tracks.length)
      return { ok: false, reason: "arrange_beat: no drum track was added for the groove." };
    if (owns(slots, "metronome")) {
      const metronome = slots.metronome;
      if (typeof metronome !== "boolean")
        return { ok: false, reason: "arrange_beat: validated metronome slot is unavailable." };
      if (after.session.metronome !== metronome)
        return { ok: false, reason: "Metronome did not reach the requested state." };
    }
    return { ok: true };
  },
};

// Lay a drum groove onto an existing track in one step, replacing/adding the named
// lanes without disturbing the song's tempo — the "edit the groove" counterpart to
// arrange_beat's "start from scratch."
export const BUILD_DRUM_PATTERN_SKILL: SkillDefinition = {
  name: "build_drum_pattern",
  description:
    "Lay a drum groove onto an existing track in one undoable step from lane strings, optionally forcing the track audible afterward.",
  slots: [
    {
      name: "trackId",
      type: "string",
      required: true,
      description: "Existing track to lay the groove on.",
    },
    {
      name: "pattern",
      type: "string",
      required: true,
      description:
        'Lane pattern string, e.g. "kick: x...x...x...x...; snare: ....x.......x...". \'x\' hit, \'X\' accent, \'.\'/\'-\' rest.',
    },
    {
      name: "unmute",
      type: "boolean",
      required: false,
      description: "Force the track audible (un-mute it) after landing the groove.",
    },
  ],
  template: [
    {
      kind: "command",
      command: "add_drum_pattern",
      args: { trackId: { slot: "trackId" }, pattern: { slot: "pattern" } },
    },
    {
      kind: "if_present",
      slot: "unmute",
      then: [
        {
          kind: "command",
          command: "set_track_mute",
          args: { trackId: { slot: "trackId" }, mute: false },
        },
      ],
    },
  ],
  precondition: (snapshot, slots) => {
    const trackId = slots.trackId;
    if (typeof trackId !== "string")
      return { ok: false, reason: "build_drum_pattern: validated trackId is unavailable." };
    const track = trackFor(snapshot, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" is no longer available.` };
    if (track.clips.some((clip) => clip.type === "wave"))
      return {
        ok: false,
        reason: `Track "${trackId}" holds wave audio — a drum groove would silence it.`,
      };
    return { ok: true };
  },
  postcondition: (before, after, slots) => {
    const trackId = slots.trackId;
    if (typeof trackId !== "string")
      return { ok: false, reason: "build_drum_pattern: validated trackId is unavailable." };
    const beforeTrack = trackFor(before, trackId);
    const afterTrack = trackFor(after, trackId);
    if (!beforeTrack || !afterTrack)
      return { ok: false, reason: `Track "${trackId}" was not preserved.` };
    if (midiNoteClipCount(afterTrack) <= midiNoteClipCount(beforeTrack))
      return { ok: false, reason: `Track "${trackId}" gained no drum notes.` };
    if (owns(slots, "unmute")) {
      const unmute = slots.unmute;
      if (typeof unmute !== "boolean")
        return { ok: false, reason: "build_drum_pattern: validated unmute slot is unavailable." };
      if (unmute && afterTrack.mute !== false)
        return { ok: false, reason: `Track "${trackId}" was not unmuted.` };
    }
    return { ok: true };
  },
};

// Start a vocal track's lyric sheet and seed its first line so the flow visualizer
// and rhyme tools have something to build on.
export const ADD_VOCAL_WITH_LYRICS_SKILL: SkillDefinition = {
  name: "add_vocal_with_lyrics",
  description:
    "Start a vocal track's lyric sheet and seed its first line — the 'add a vocal with lyrics' workflow.",
  slots: [
    {
      name: "trackId",
      type: "string",
      required: true,
      description: "Existing vocal track to attach the lyric sheet to.",
    },
    {
      name: "seedText",
      type: "string",
      required: true,
      description: "Line 0's seed text; ___ marks a gap the generator can fill later.",
    },
    {
      name: "role",
      type: "string",
      required: false,
      description: "Section role for line 0.",
      enum: ["verse", "hook", "bridge", "adlib"],
    },
    {
      name: "topic",
      type: "string",
      required: false,
      description: "Sheet-level topic to bias generation (e.g. 'heartbreak').",
    },
    {
      name: "mood",
      type: "string",
      required: false,
      description: "Sheet-level mood to bias generation (e.g. 'defiant').",
    },
  ],
  template: [
    { kind: "command", command: "create_lyric_sheet", args: { trackId: { slot: "trackId" } } },
    {
      kind: "command",
      command: "set_lyric_line",
      args: { trackId: { slot: "trackId" }, lineIndex: 0, seedText: { slot: "seedText" } },
    },
    {
      kind: "if_present",
      slot: "role",
      then: [
        {
          kind: "command",
          command: "set_lyric_line",
          args: { trackId: { slot: "trackId" }, lineIndex: 0, role: { slot: "role" } },
        },
      ],
    },
    {
      kind: "if_present",
      slot: "topic",
      then: [
        {
          kind: "command",
          command: "set_lyric_constraint",
          args: { trackId: { slot: "trackId" }, topic: { slot: "topic" } },
        },
      ],
    },
    {
      kind: "if_present",
      slot: "mood",
      then: [
        {
          kind: "command",
          command: "set_lyric_constraint",
          args: { trackId: { slot: "trackId" }, mood: { slot: "mood" } },
        },
      ],
    },
  ],
  precondition: (snapshot, slots) => {
    const trackId = slots.trackId;
    if (typeof trackId !== "string")
      return { ok: false, reason: "add_vocal_with_lyrics: validated trackId is unavailable." };
    const track = trackFor(snapshot, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" is no longer available.` };
    if (track.lyricSheet)
      return { ok: false, reason: `Track "${trackId}" already has a lyric sheet.` };
    return { ok: true };
  },
  postcondition: (_before, after, slots) => {
    const trackId = slots.trackId;
    const seedText = slots.seedText;
    if (typeof trackId !== "string" || typeof seedText !== "string")
      return { ok: false, reason: "add_vocal_with_lyrics: validated required slots are unavailable." };
    const afterTrack = trackFor(after, trackId);
    if (!afterTrack) return { ok: false, reason: `Track "${trackId}" was not preserved.` };
    const sheet = afterTrack.lyricSheet;
    if (!sheet) return { ok: false, reason: `Track "${trackId}" has no lyric sheet after the skill ran.` };
    const firstLine = sheet.lines.find((line) => line.index === 0);
    if (!firstLine || firstLine.seedText !== seedText)
      return { ok: false, reason: `Line 0 did not seed "${seedText}".` };
    if (owns(slots, "role")) {
      const role = slots.role;
      if (typeof role !== "string")
        return { ok: false, reason: "add_vocal_with_lyrics: validated role slot is unavailable." };
      if (firstLine.role !== role) return { ok: false, reason: `Line 0 did not reach role "${role}".` };
    }
    if (owns(slots, "topic")) {
      const topic = slots.topic;
      if (typeof topic !== "string")
        return { ok: false, reason: "add_vocal_with_lyrics: validated topic slot is unavailable." };
      if (sheet.topic !== topic) return { ok: false, reason: `Sheet topic did not reach "${topic}".` };
    }
    if (owns(slots, "mood")) {
      const mood = slots.mood;
      if (typeof mood !== "string")
        return { ok: false, reason: "add_vocal_with_lyrics: validated mood slot is unavailable." };
      if (sheet.mood !== mood) return { ok: false, reason: `Sheet mood did not reach "${mood}".` };
    }
    return { ok: true };
  },
};

// Attach a generative re-imagine layer to a clip, dial in the noise amount, and
// run the render — optionally accepting it immediately.
export const REIMAGINE_CLIP_SKILL: SkillDefinition = {
  name: "reimagine_clip",
  description:
    "Attach a generative re-imagine layer to a clip, dial in the noise amount, and run the render.",
  slots: [
    {
      name: "clipId",
      type: "string",
      required: true,
      description: "Existing clip (wave, MIDI, or drum) to re-imagine.",
    },
    {
      name: "nl",
      type: "number",
      required: true,
      description: "Noise level 0-1 — how far the render departs from the source.",
      min: 0,
      max: 1,
    },
    {
      name: "prompt",
      type: "string",
      required: false,
      description: "Style prompt guiding the re-imagine.",
    },
    {
      name: "autoAccept",
      type: "boolean",
      required: false,
      description: "Accept the render immediately once it finishes.",
    },
  ],
  template: [
    { kind: "command", command: "create_render_layer", args: { clipId: { slot: "clipId" } } },
    {
      kind: "command",
      command: "set_render_param",
      args: { clipId: { slot: "clipId" }, nl: { slot: "nl" } },
    },
    {
      kind: "if_present",
      slot: "prompt",
      then: [
        {
          kind: "command",
          command: "set_render_param",
          args: { clipId: { slot: "clipId" }, prompt: { slot: "prompt" } },
        },
      ],
    },
    { kind: "command", command: "render_layer", args: { clipId: { slot: "clipId" } } },
    {
      kind: "if_present",
      slot: "autoAccept",
      then: [
        { kind: "command", command: "accept_render", args: { clipId: { slot: "clipId" } } },
      ],
    },
  ],
  precondition: (snapshot, slots) => {
    const clipId = slots.clipId;
    if (typeof clipId !== "string")
      return { ok: false, reason: "reimagine_clip: validated clipId is unavailable." };
    if (!clipFor(snapshot, clipId))
      return { ok: false, reason: `Clip "${clipId}" is no longer available.` };
    return { ok: true };
  },
  postcondition: (_before, after, slots) => {
    const clipId = slots.clipId;
    const nl = slots.nl;
    if (typeof clipId !== "string" || typeof nl !== "number")
      return { ok: false, reason: "reimagine_clip: validated required slots are unavailable." };
    const found = clipFor(after, clipId);
    if (!found) return { ok: false, reason: `Clip "${clipId}" was not preserved.` };
    const layer = found.clip.renderLayer;
    if (!layer) return { ok: false, reason: `Clip "${clipId}" has no render layer after the skill ran.` };
    if (typeof layer.nl !== "number" || Math.abs(layer.nl - nl) > 1e-6)
      return { ok: false, reason: `Render layer did not reach noise level ${nl}.` };
    if (!layer.hasArtifact)
      return { ok: false, reason: `Clip "${clipId}" did not finish rendering.` };
    if (owns(slots, "prompt")) {
      const prompt = slots.prompt;
      if (typeof prompt !== "string")
        return { ok: false, reason: "reimagine_clip: validated prompt slot is unavailable." };
      if (layer.prompt !== prompt)
        return { ok: false, reason: `Render layer prompt did not reach "${prompt}".` };
    }
    if (owns(slots, "autoAccept")) {
      const autoAccept = slots.autoAccept;
      if (typeof autoAccept !== "boolean")
        return { ok: false, reason: "reimagine_clip: validated autoAccept slot is unavailable." };
      if (autoAccept && !layer.userKept)
        return { ok: false, reason: `Clip "${clipId}" render was not accepted.` };
    }
    return { ok: true };
  },
};

// Add a scanned plugin to a track's chain and dial in an initial parameter,
// optionally loading it already bypassed.
export const HOST_PLUGIN_SKILL: SkillDefinition = {
  name: "host_plugin",
  description:
    "Add a scanned VST3/AU plugin to a track's chain and set an initial parameter value.",
  slots: [
    {
      name: "trackId",
      type: "string",
      required: true,
      description: "Existing track to host the plugin on.",
    },
    {
      name: "pluginId",
      type: "string",
      required: true,
      description: "Scanned plugin id from list_plugins (e.g. 'vital').",
    },
    {
      name: "index",
      type: "number",
      required: true,
      description: "Chain position the plugin lands at — typically the track's current plugin count.",
      min: 0,
    },
    {
      name: "paramIndex",
      type: "number",
      required: true,
      description: "Index of the plugin parameter to set immediately after loading.",
      min: 0,
    },
    {
      name: "value",
      type: "number",
      required: true,
      description: "Initial parameter value, 0-1.",
      min: 0,
      max: 1,
    },
    {
      name: "bypassed",
      type: "boolean",
      required: false,
      description: "Load the plugin already bypassed.",
    },
  ],
  template: [
    {
      kind: "command",
      command: "load_plugin",
      args: { trackId: { slot: "trackId" }, pluginId: { slot: "pluginId" }, index: { slot: "index" } },
    },
    {
      kind: "command",
      command: "set_plugin_param",
      args: {
        trackId: { slot: "trackId" },
        index: { slot: "index" },
        paramIndex: { slot: "paramIndex" },
        value: { slot: "value" },
      },
    },
    {
      kind: "if_present",
      slot: "bypassed",
      then: [
        {
          kind: "command",
          command: "bypass_plugin",
          args: {
            trackId: { slot: "trackId" },
            index: { slot: "index" },
            bypassed: { slot: "bypassed" },
          },
        },
      ],
    },
  ],
  precondition: (snapshot, slots) => {
    const trackId = slots.trackId;
    if (typeof trackId !== "string")
      return { ok: false, reason: "host_plugin: validated trackId is unavailable." };
    const track = trackFor(snapshot, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" is no longer available.` };
    return { ok: true };
  },
  postcondition: (_before, after, slots) => {
    const trackId = slots.trackId;
    const index = slots.index;
    const paramIndex = slots.paramIndex;
    const value = slots.value;
    if (
      typeof trackId !== "string" ||
      typeof index !== "number" ||
      typeof paramIndex !== "number" ||
      typeof value !== "number"
    )
      return { ok: false, reason: "host_plugin: validated required slots are unavailable." };
    const afterTrack = trackFor(after, trackId);
    if (!afterTrack) return { ok: false, reason: `Track "${trackId}" was not preserved.` };
    const plugin = afterTrack.plugins?.find((p) => p.index === index);
    if (!plugin) return { ok: false, reason: `Track "${trackId}" has no plugin at chain position ${index}.` };
    const param = plugin.params.find((p) => p.index === paramIndex);
    if (!param || Math.abs(param.value - value) > 1e-6)
      return { ok: false, reason: `Plugin parameter ${paramIndex} did not reach ${value}.` };
    if (owns(slots, "bypassed")) {
      const bypassed = slots.bypassed;
      if (typeof bypassed !== "boolean")
        return { ok: false, reason: "host_plugin: validated bypassed slot is unavailable." };
      if (plugin.enabled !== !bypassed)
        return { ok: false, reason: "Plugin bypass state did not reach the requested value." };
    }
    return { ok: true };
  },
};

// Time-stretch a wave clip to fit a bar count and lock it to the grid — the
// Ableton-style easy-warp flow: read the source BPM, then stretch to fit.
export const WARP_LOOP_TO_GRID_SKILL: SkillDefinition = {
  name: "warp_loop_to_grid",
  description:
    "Detect a wave clip's source BPM and time-stretch (warp) it to fill a target bar count on the project grid.",
  slots: [
    {
      name: "clipId",
      type: "string",
      required: true,
      description: "Existing wave clip to warp to the grid.",
    },
    {
      name: "bars",
      type: "number",
      required: true,
      description: "Target warped length in bars, e.g. 4 for a 4-bar loop.",
      min: 0.25,
      max: 128,
    },
    {
      name: "rename",
      type: "string",
      required: false,
      description: "Rename the clip once it's warped.",
    },
  ],
  template: [
    { kind: "command", command: "detect_clip_bpm", args: { clipId: { slot: "clipId" } } },
    {
      kind: "command",
      command: "stretch_clip",
      args: { clipId: { slot: "clipId" }, bars: { slot: "bars" } },
    },
    {
      kind: "if_present",
      slot: "rename",
      then: [
        {
          kind: "command",
          command: "rename_clip",
          args: { clipId: { slot: "clipId" }, name: { slot: "rename" } },
        },
      ],
    },
  ],
  precondition: (snapshot, slots) => {
    const clipId = slots.clipId;
    if (typeof clipId !== "string")
      return { ok: false, reason: "warp_loop_to_grid: validated clipId is unavailable." };
    const found = clipFor(snapshot, clipId);
    if (!found) return { ok: false, reason: `Clip "${clipId}" is no longer available.` };
    if (found.clip.type !== "wave")
      return {
        ok: false,
        reason: `Clip "${clipId}" is not a wave clip — warp only applies to recorded/imported audio.`,
      };
    return { ok: true };
  },
  postcondition: (_before, after, slots) => {
    const clipId = slots.clipId;
    const bars = slots.bars;
    if (typeof clipId !== "string" || typeof bars !== "number")
      return { ok: false, reason: "warp_loop_to_grid: validated required slots are unavailable." };
    const found = clipFor(after, clipId);
    if (!found) return { ok: false, reason: `Clip "${clipId}" was not preserved.` };
    if (!found.clip.autoTempo)
      return { ok: false, reason: `Clip "${clipId}" did not warp to ${bars} bar(s).` };
    if (typeof found.clip.sourceBpm !== "number" || found.clip.sourceBpm <= 0)
      return { ok: false, reason: `Clip "${clipId}" has no detected source tempo after warping.` };
    if (owns(slots, "rename")) {
      const rename = slots.rename;
      if (typeof rename !== "string")
        return { ok: false, reason: "warp_loop_to_grid: validated rename slot is unavailable." };
      if (found.clip.name !== rename)
        return { ok: false, reason: `Clip did not rename to "${rename}".` };
    }
    return { ok: true };
  },
};

// Arm a track's automation for write, then set a plugin parameter — the change is
// captured as an automation point at the playhead, the G10 "record by performing the
// tweak" workflow (the write_automation_curve bulk-author path is a direct single-call
// command and doesn't need a skill wrapper).
export const AUTOMATE_PARAMETER_SKILL: SkillDefinition = {
  name: "automate_parameter",
  description:
    "Arm a track's automation for write, then set a plugin parameter — captured as an automation point at the playhead.",
  slots: [
    {
      name: "trackId",
      type: "string",
      required: true,
      description: "Track whose plugin parameter should be captured while write-armed.",
    },
    {
      name: "index",
      type: "number",
      required: true,
      description: "Chain position of the plugin whose parameter is being automated.",
      min: 0,
    },
    {
      name: "paramIndex",
      type: "number",
      required: true,
      description: "Index of the plugin parameter to automate.",
      min: 0,
    },
    {
      name: "value",
      type: "number",
      required: true,
      description: "New parameter value, 0-1 — the move captured as the automation point.",
      min: 0,
      max: 1,
    },
  ],
  template: [
    {
      kind: "command",
      command: "set_track_automation_mode",
      args: { trackId: { slot: "trackId" }, mode: "write" },
    },
    {
      kind: "command",
      command: "set_plugin_param",
      args: {
        trackId: { slot: "trackId" },
        index: { slot: "index" },
        paramIndex: { slot: "paramIndex" },
        value: { slot: "value" },
      },
    },
  ],
  precondition: (snapshot, slots) => {
    const trackId = slots.trackId;
    if (typeof trackId !== "string")
      return { ok: false, reason: "automate_parameter: validated trackId is unavailable." };
    const track = trackFor(snapshot, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" is no longer available.` };
    const index = slots.index;
    if (typeof index !== "number")
      return { ok: false, reason: "automate_parameter: validated index slot is unavailable." };
    const plugin = track.plugins?.find((p) => p.index === index);
    if (!plugin) return { ok: false, reason: `Track "${trackId}" has no plugin at chain position ${index}.` };
    const paramIndex = slots.paramIndex;
    if (typeof paramIndex !== "number")
      return { ok: false, reason: "automate_parameter: validated paramIndex slot is unavailable." };
    const param = plugin.params.find((p) => p.index === paramIndex);
    if (!param)
      return { ok: false, reason: `Plugin at chain position ${index} has no parameter ${paramIndex}.` };
    return { ok: true };
  },
  postcondition: (_before, after, slots) => {
    const trackId = slots.trackId;
    const index = slots.index;
    const paramIndex = slots.paramIndex;
    const value = slots.value;
    if (
      typeof trackId !== "string" ||
      typeof index !== "number" ||
      typeof paramIndex !== "number" ||
      typeof value !== "number"
    )
      return { ok: false, reason: "automate_parameter: validated required slots are unavailable." };
    const afterTrack = trackFor(after, trackId);
    if (!afterTrack) return { ok: false, reason: `Track "${trackId}" was not preserved.` };
    if (afterTrack.automationMode !== "write")
      return { ok: false, reason: `Track "${trackId}" did not arm write automation mode.` };
    const plugin = afterTrack.plugins?.find((p) => p.index === index);
    if (!plugin) return { ok: false, reason: `Track "${trackId}" lost the plugin at chain position ${index}.` };
    const param = plugin.params.find((p) => p.index === paramIndex);
    if (!param || Math.abs(param.value - value) > 1e-6)
      return { ok: false, reason: `Plugin parameter ${paramIndex} did not reach ${value}.` };
    if (!param.points || param.points.length === 0)
      return { ok: false, reason: `Plugin parameter ${paramIndex} did not capture an automation point.` };
    const lastPoint = param.points[param.points.length - 1];
    if (Math.abs(lastPoint.v - value) > 1e-6)
      return { ok: false, reason: `The captured automation point did not reach value ${value}.` };
    return { ok: true };
  },
};

// ── FS-B2 (2026-07-28) ────────────────────────────────────────────────────────────
// Five workflow skills, selected on EVIDENCE rather than a demo script (O2 was
// withdrawn 2026-07-28 — there is no demo).
//
// The evidence is `service/skills/library.jsonl`: 36 micro-skills mined from the SFT
// demonstration corpus, each carrying `provenance` (the exact corpus rows that produced
// it). Per docs/first-stranger-program/SKILL_CATALOG_BOUNDARY.md that library is a mined
// retrieval corpus for the offline router and is NOT hand-authored — so it is read here
// as a source of *which workflows are real*, never copied from.
//
// Selection rule: a skill must encode **two or more commands that genuinely go
// together**. Provenance count alone is a bad rule — the mined library's single biggest
// entry (`assign-sample`, 51 rows) wraps one command 1:1, and a 1:1 wrapper adds a name,
// not a capability; `validateCommand` already covers the single call. Twenty-two of the
// 36 mined entries are such wrappers and are deliberately not ported.
//
// Two mined families collapse here rather than porting as-is: six near-duplicate
// `create-bus-add-send*` variants, and three `load-builtin-set-plugin-param*` variants.
//
// WHAT COULD NOT BE PORTED, and why — both are schema limits, not oversights:
//   · Nothing that needs an id RETURNED by an earlier command. The template language is
//     declarative: an arg is a literal or `{slot}`, so `create_bus` → `add_send(bus: ?)`
//     cannot chain. `send_to_bus` therefore targets an EXISTING bus. `add_builtin_effect`
//     works around it honestly by making the chain `index` an explicit slot that both
//     commands read.
//   · The mined `add-note-pattern` / `add-note-from-note-names` (provenance 20 each, the
//     joint-highest multi-row entries) need `list<note>` slots. `SkillSlot` is
//     string/number/boolean only. Porting them needs a schema change, not a definition.

const NEW_BUS_MIN = 0;
const NEW_BUS_MAX = 63;

export const PREPARE_DRUM_TRACK_SKILL: SkillDefinition = {
  name: "prepare_drum_track",
  description:
    "Turn an existing track into a drum track and load the built-in kit onto its sampler, ready for a pattern.",
  slots: [
    {
      name: "trackId",
      type: "string",
      required: true,
      description: "Stable id of the existing track to convert.",
    },
  ],
  template: [
    {
      kind: "command",
      command: "set_track_type",
      args: { trackId: { slot: "trackId" }, type: "drum" },
    },
    { kind: "command", command: "load_drum_kit", args: { trackId: { slot: "trackId" } } },
  ],
  precondition: (snapshot, slots) => {
    const trackId = slots.trackId;
    if (typeof trackId !== "string")
      return { ok: false, reason: "prepare_drum_track: validated trackId is unavailable." };
    const track = trackFor(snapshot, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" is no longer available.` };
    // Refused for the same reason MoshOps refuses it natively: converting a track that
    // already holds audio discards that audio. The native handler's error names this
    // recovery ("call add_drum_pattern again WITHOUT trackId"); do not paper over it.
    if (track.clips.some((clip) => clip.type === "wave"))
      return {
        ok: false,
        reason: `Track "${trackId}" holds audio clips; converting it to a drum track would discard them. Make a new track instead.`,
      };
    return { ok: true };
  },
  postcondition: (_before, after, slots) => {
    const trackId = slots.trackId as string;
    const track = trackFor(after, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" vanished during the skill.` };
    if (track.type !== "drum")
      return { ok: false, reason: `Track "${trackId}" is "${track.type}", not a drum track.` };
    return { ok: true };
  },
};

export const SEND_TO_BUS_SKILL: SkillDefinition = {
  name: "send_to_bus",
  description:
    "Send an existing track to an existing aux/return bus at a set level — the reverb/delay send move.",
  slots: [
    {
      name: "trackId",
      type: "string",
      required: true,
      description: "Stable id of the track to send from.",
    },
    {
      name: "bus",
      type: "number",
      required: true,
      description: "Number of the existing destination bus.",
      min: NEW_BUS_MIN,
      max: NEW_BUS_MAX,
    },
    {
      name: "db",
      type: "number",
      required: true,
      description: "Send level in decibels.",
      min: -60,
      max: 6,
    },
  ],
  template: [
    {
      kind: "command",
      command: "add_send",
      args: { trackId: { slot: "trackId" }, bus: { slot: "bus" } },
    },
    {
      kind: "command",
      command: "set_send_level",
      args: { trackId: { slot: "trackId" }, bus: { slot: "bus" }, db: { slot: "db" } },
    },
  ],
  precondition: (snapshot, slots) => {
    const trackId = slots.trackId;
    const bus = slots.bus;
    if (typeof trackId !== "string" || typeof bus !== "number")
      return { ok: false, reason: "send_to_bus: validated slots are unavailable." };
    const track = trackFor(snapshot, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" is no longer available.` };
    const buses = snapshot.buses ?? [];
    if (!buses.some((candidate) => candidate.bus === bus))
      return {
        ok: false,
        reason: `Bus ${bus} does not exist. Create it first — this skill cannot create one, because the template language cannot read back the new bus number.`,
      };
    if (buses.some((candidate) => candidate.trackId === trackId))
      return { ok: false, reason: `Track "${trackId}" is itself a bus; sending it to a bus would feed back.` };
    return { ok: true };
  },
  postcondition: (_before, after, slots) => {
    const trackId = slots.trackId as string;
    const bus = slots.bus as number;
    const db = slots.db as number;
    const track = trackFor(after, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" vanished during the skill.` };
    const sends = (track as unknown as { sends?: { bus: number; db?: number }[] }).sends ?? [];
    const send = sends.find((candidate) => candidate.bus === bus);
    if (!send) return { ok: false, reason: `No send to bus ${bus} exists on "${trackId}".` };
    if (Math.abs((send.db ?? 0) - db) > 1e-6)
      return { ok: false, reason: `Send to bus ${bus} is at ${send.db ?? 0} dB, not ${db} dB.` };
    return { ok: true };
  },
};

export const RECORD_TAKE_SKILL: SkillDefinition = {
  name: "record_take",
  description:
    "Arm a track, set its input monitoring, and roll the transport into record — the whole 'capture a take' move.",
  slots: [
    {
      name: "trackId",
      type: "string",
      required: true,
      description: "Stable id of the track to record onto.",
    },
    {
      name: "monitor",
      type: "string",
      required: false,
      description: "Input monitoring mode; omit to leave it as it is.",
      enum: ["off", "automatic", "on"],
    },
  ],
  template: [
    { kind: "command", command: "arm_track", args: { trackId: { slot: "trackId" }, armed: true } },
    {
      kind: "if_present",
      slot: "monitor",
      then: [
        {
          kind: "command",
          command: "set_input_monitor",
          args: { trackId: { slot: "trackId" }, mode: { slot: "monitor" } },
        },
      ],
    },
    { kind: "command", command: "set_transport", args: { action: "record" } },
  ],
  precondition: (snapshot, slots) => {
    const trackId = slots.trackId;
    if (typeof trackId !== "string")
      return { ok: false, reason: "record_take: validated trackId is unavailable." };
    const track = trackFor(snapshot, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" is no longer available.` };
    // Rolling into record while already recording would land a second take nobody asked
    // for, and the skill's own postcondition could not tell the two apart.
    if (snapshot.transport?.recording)
      return { ok: false, reason: "The transport is already recording; stop it before starting a new take." };
    return { ok: true };
  },
  postcondition: (_before, after, slots) => {
    const trackId = slots.trackId as string;
    const track = trackFor(after, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" vanished during the skill.` };
    if (!after.transport?.recording)
      return { ok: false, reason: "The transport is not recording after the skill ran." };
    return { ok: true };
  },
};

export const KEEP_LAST_TAKE_SKILL: SkillDefinition = {
  name: "keep_last_take",
  description:
    "Stop recording and keep one take lane on the recorded clip, discarding the rest — the 'that one, bin the others' move.",
  slots: [
    {
      name: "clipId",
      type: "string",
      required: true,
      description: "Stable id of the recorded clip whose current take should be kept.",
    },
  ],
  template: [
    { kind: "command", command: "stop_recording", args: { discardRecordings: false } },
    { kind: "command", command: "keep_take", args: { clipId: { slot: "clipId" } } },
  ],
  precondition: (snapshot, slots) => {
    const clipId = slots.clipId;
    if (typeof clipId !== "string")
      return { ok: false, reason: "keep_last_take: validated clipId is unavailable." };
    if (!clipFor(snapshot, clipId))
      return { ok: false, reason: `Clip "${clipId}" is no longer available.` };
    return { ok: true };
  },
  postcondition: (_before, after, slots) => {
    const clipId = slots.clipId as string;
    if (after.transport?.recording)
      return { ok: false, reason: "The transport is still recording after the skill ran." };
    if (!clipFor(after, clipId))
      return { ok: false, reason: `Clip "${clipId}" no longer exists after keeping the take.` };
    return { ok: true };
  },
};

export const ADD_BUILTIN_EFFECT_SKILL: SkillDefinition = {
  name: "add_builtin_effect",
  description:
    "Add a built-in effect at a chosen slot in a track's chain and optionally dial one of its parameters in.",
  slots: [
    {
      name: "trackId",
      type: "string",
      required: true,
      description: "Stable id of the track to add the effect to.",
    },
    {
      name: "type",
      type: "string",
      required: true,
      description: "Built-in effect type, as reported by the builtin list.",
    },
    {
      // Explicit rather than derived, and that is the point: the template language cannot
      // read back the index `load_builtin` chose, so the only honest way to let
      // set_plugin_param address the plugin it just added is to place it deliberately.
      name: "index",
      type: "number",
      required: true,
      description: "Chain position to insert at — the same index the parameter is then set on.",
      min: 0,
      max: 63,
    },
    {
      name: "paramIndex",
      type: "number",
      required: false,
      description: "Optional parameter to set on the new effect.",
      min: 0,
      max: 511,
    },
    {
      name: "value",
      type: "number",
      required: false,
      description: "Normalised parameter value.",
      min: 0,
      max: 1,
    },
  ],
  template: [
    {
      kind: "command",
      command: "load_builtin",
      args: { trackId: { slot: "trackId" }, type: { slot: "type" }, index: { slot: "index" } },
    },
    // NESTED, not flat. `set_plugin_param` reads two optional slots, and the contract
    // walker requires each one to sit inside an `if_present` naming that slot — a flat
    // `if_present("paramIndex")` leaves `value` unguarded, so a caller supplying only
    // paramIndex would emit the command with an unbound arg. The precondition below
    // rejects that combination too, but a runtime check is not what the static contract
    // is asking for, and it was right to refuse: the template must be safe on its own.
    {
      kind: "if_present",
      slot: "paramIndex",
      then: [
        {
          kind: "if_present",
          slot: "value",
          then: [
            {
              kind: "command",
              command: "set_plugin_param",
              args: {
                trackId: { slot: "trackId" },
                index: { slot: "index" },
                paramIndex: { slot: "paramIndex" },
                value: { slot: "value" },
              },
            },
          ],
        },
      ],
    },
  ],
  precondition: (snapshot, slots) => {
    const trackId = slots.trackId;
    if (typeof trackId !== "string")
      return { ok: false, reason: "add_builtin_effect: validated trackId is unavailable." };
    const track = trackFor(snapshot, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" is no longer available.` };
    // `value` is only optional in the sense that the whole parameter branch is. Asking
    // for a parameter without a value would emit set_plugin_param with an unbound arg.
    if (owns(slots, "paramIndex") && !owns(slots, "value"))
      return { ok: false, reason: "paramIndex was given without a value; supply both or neither." };
    if (owns(slots, "value") && !owns(slots, "paramIndex"))
      return { ok: false, reason: "value was given without a paramIndex; supply both or neither." };
    const index = slots.index;
    if (typeof index !== "number" || index > (track.plugins?.length ?? 0))
      return {
        ok: false,
        reason: `Chain position ${String(index)} is past the end of "${trackId}"'s chain (${track.plugins?.length ?? 0} plugins).`,
      };
    return { ok: true };
  },
  postcondition: (before, after, slots) => {
    const trackId = slots.trackId as string;
    const track = trackFor(after, trackId);
    if (!track) return { ok: false, reason: `Track "${trackId}" vanished during the skill.` };
    const beforeCount = trackFor(before, trackId)?.plugins?.length ?? 0;
    const afterCount = track.plugins?.length ?? 0;
    if (afterCount !== beforeCount + 1)
      return { ok: false, reason: `Track "${trackId}" went from ${beforeCount} to ${afterCount} plugins; expected one more.` };
    if (owns(slots, "paramIndex")) {
      const plugin = track.plugins?.[slots.index as number];
      const param = plugin?.params?.find((p) => p.index === (slots.paramIndex as number));
      if (!param || Math.abs(param.value - (slots.value as number)) > 1e-6)
        return { ok: false, reason: `Parameter ${String(slots.paramIndex)} did not reach ${String(slots.value)}.` };
    }
    return { ok: true };
  },
};

export const SKILL_CATALOG: readonly SkillDefinition[] = [
  SET_TRACK_LEVEL_SKILL,
  ARRANGE_BEAT_SKILL,
  BUILD_DRUM_PATTERN_SKILL,
  ADD_VOCAL_WITH_LYRICS_SKILL,
  REIMAGINE_CLIP_SKILL,
  HOST_PLUGIN_SKILL,
  WARP_LOOP_TO_GRID_SKILL,
  AUTOMATE_PARAMETER_SKILL,
  // FS-B2
  PREPARE_DRUM_TRACK_SKILL,
  SEND_TO_BUS_SKILL,
  RECORD_TAKE_SKILL,
  KEEP_LAST_TAKE_SKILL,
  ADD_BUILTIN_EFFECT_SKILL,
];
