// GEPA eval set — synthetic, gradeable tasks sliced from importer programs.
//
// Per the chosen plan, the first GEPA run's eval data is SYNTHETIC importer
// slices (real harvested tuples are near-zero today). An importer program
// (emitCommands over a real .rpp/.als/.flp) is a verified, clean-applying command
// sequence; we cut it into small "do this one thing" tasks: a setup prefix
// (startCommands, replayed unscored to build the state the brain sees) + a natural
// utterance + the gold command NAME(s) the brain should emit.
//
// Tasks are chosen so they're fairly gradeable by the name-recall + clean-apply
// metric (metric.ts): deterministic ops (mixer, tempo/key, add-clip) and
// note-population over an ALREADY-EXISTING clip — the clip stays in the setup
// prefix because the brain can't reference a clip it creates in the same turn.

import type { BoundCommand, ImportProgram } from "../import/emit";

export type EvalExample = {
  id: string;
  utterance: string;
  startCommands: BoundCommand[]; // unscored setup (logical refs, resolved at eval time)
  goldCommandNames: string[]; // expected command-name multiset
};

export type SliceOptions = {
  /** Skip examples whose setup prefix exceeds this many commands (keeps the
   *  snapshot shown to the brain small). Default 50. */
  maxStart?: number;
  /** Cap the number of examples produced. Default 24. */
  max?: number;
};

const MIXER: Record<string, (name: string, args: Record<string, unknown>) => string> = {
  set_track_volume: (n, a) => `turn the "${n}" track ${Number(a.db) >= 0 ? "up" : "down"} a little`,
  set_track_pan: (n, a) => `pan the "${n}" track to the ${Number(a.pan) >= 0 ? "right" : "left"}`,
  set_track_mute: (n) => `mute the "${n}" track`,
  set_track_solo: (n) => `solo the "${n}" track`,
};

/** Cut an importer program into gradeable eval tasks. */
export function sliceProgram(program: ImportProgram, sourceId: string, opts: SliceOptions = {}): EvalExample[] {
  const maxStart = opts.maxStart ?? 50;
  const max = opts.max ?? 24;
  const cmds = program.commands;
  const out: EvalExample[] = [];

  // ref → track name (for natural utterances) and clip ref → track name.
  const trackName = new Map<string, string>();
  const clipTrack = new Map<string, string>();
  for (const c of cmds) {
    if (c.command === "create_track" && c.bind) trackName.set(c.bind, String(c.args.name ?? "track"));
    if (c.command === "add_midi_clip" && c.bind) {
      const tref = typeof c.args.trackId === "string" ? c.args.trackId.replace(/^\$/, "") : "";
      clipTrack.set(c.bind, trackName.get(tref) ?? "track");
    }
  }

  const push = (utterance: string, startEnd: number, goldCommandNames: string[]) => {
    if (out.length >= max) return;
    if (startEnd > maxStart) return;
    out.push({ id: `${sourceId}#${out.length}`, utterance, startCommands: cmds.slice(0, startEnd), goldCommandNames });
  };

  for (let i = 0; i < cmds.length && out.length < max; i++) {
    const c = cmds[i];
    if (c.command === "set_tempo") push(`set the tempo to ${c.args.bpm}`, i, ["set_tempo"]);
    else if (c.command === "set_key") push(`set the key to ${c.args.tonic} ${c.args.mode}`, i, ["set_key"]);
    else if (c.command === "set_time_signature") push(`change to ${c.args.numerator}/${c.args.denominator} time`, i, ["set_time_signature"]);
    else if (MIXER[c.command]) {
      const tref = typeof c.args.trackId === "string" ? c.args.trackId.replace(/^\$/, "") : "";
      push(MIXER[c.command](trackName.get(tref) ?? "track", c.args), i, [c.command]);
    } else if (c.command === "add_midi_clip") {
      const tref = typeof c.args.trackId === "string" ? c.args.trackId.replace(/^\$/, "") : "";
      const name = trackName.get(tref) ?? "track";
      // add-clip task: gold is just the clip on the named track.
      push(`add a MIDI clip to the "${name}" track`, i, ["add_midi_clip"]);
      // populate task: clip already exists (in the setup, incl. this add_midi_clip),
      // ask for notes. Only if the program actually wrote notes into it.
      const hasNotes = cmds[i + 1]?.command === "add_note";
      if (hasNotes) push(`write a short pattern into the clip on the "${name}" track`, i + 1, ["add_note"]);
    }
  }
  return out.slice(0, max);
}
