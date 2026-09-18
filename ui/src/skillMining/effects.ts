import { array, record } from "./types";
import type { Command, Json } from "./types";
import { clipEffect } from "./effectsClips";
import { noteEffect } from "./effectsNotes";
import { structureEffect } from "./effectsStructure";
import { byId, clips, equal, failed, fields, pick, tracks, unchangedOthers, unverified } from "./effectsCore";
import type { Effect, Obj } from "./effectsCore";

const trackFields: Readonly<Record<string, readonly [string, string, Json]>> = {
  set_track_volume: ["volumeDb", "db", 0], set_track_pan: ["pan", "pan", 0],
  set_track_mute: ["mute", "mute", false], set_track_solo: ["solo", "solo", false],
  arm_track: ["armed", "armed", false], rename_track: ["name", "name", ""],
  set_track_type: ["type", "type", "audio"],
};
function trackEffect(command: Command, before: Json, after: Json): Effect {
  const a = command.args, source = byId(tracks(before), a.trackId), target = byId(tracks(after), a.trackId);
  if (!source || !target) return failed("Addressed track is missing before or after the command");
  if (!equal(clips(before), clips(after))) return failed("Track setter unexpectedly changed clips");
  if (!unchangedOthers(tracks(before), tracks(after), [source.id])) {
    if (command.command === "set_input_monitor" || array(record(before).trackGroups).length > 0)
      return unverified("Shared device or grouped track changes need explicit membership evidence");
    return failed("Track setter unexpectedly changed other tracks");
  }
  let expected: Obj;
  if (command.command === "set_input_monitor") expected = { monitor: a.mode ?? (a.monitor === undefined ? "automatic" : a.monitor ? "on" : "off") };
  else if (command.command === "load_drum_kit") {
    if (a.kit === undefined || a.kit === "") return unverified("Default kit identity requires an explicit catalogue binding");
    if (!Array.isArray(target.drumPads)) return unverified("Snapshot lacks loaded drum pad evidence");
    if (array(target.drumPads).length === 0) return failed("No drum pads were loaded");
    expected = { drumKit: a.kit };
  } else {
    const mapping = trackFields[command.command];
    if (!mapping) return unverified(`No track predicate for ${command.command}`);
    expected = { [mapping[0]]: a[mapping[1]] ?? mapping[2] };
  }
  if (command.command === "set_track_type" && expected.type === "drum" && target.isInstrument !== true)
    return failed("Drum track did not acquire an instrument");
  const stableKeys = ["id", "name", "type", "volumeDb", "pan", "mute", "solo"].filter(key => !(key in expected));
  if (!equal(pick(source, stableKeys), pick(target, stableKeys))) return failed("Unrelated addressed track fields changed");
  return fields(source, target, expected);
}
function transportEffect(command: Command, before: Json, after: Json): Effect {
  const a = command.args, source = record(record(before).transport), target = record(record(after).transport);
  const expected: Obj = pick(a, ["position", "loopStart", "loopEnd"]);
  if (a.loop !== undefined) expected.looping = a.loop;
  switch (a.action) {
    case "play": expected.playing = true; break;
    case "stop": expected.playing = false; expected.recording = false; break;
    case "record": expected.playing = true; expected.recording = true; break;
    case "toggle": case "continue":
      if (typeof source.playing !== "boolean") return unverified("Prior playing state is missing");
      expected.playing = !source.playing; break;
    case "to_start": expected.position = a.position ?? 0; break;
    case "to_end":
      if (a.position === undefined && record(record(before).session).length === undefined) return unverified("Session end is missing");
      expected.position = a.position ?? record(record(before).session).length; break;
    case undefined: case "": break;
    default: return failed("Unsupported transport action");
  }
  return fields(source, target, expected);
}
export function checkEffect(command: Command, before: Json, after: Json): Effect {
  const a = command.args, old = record(before), next = record(after);
  const oldSession = record(old.session), session = record(next.session);
  switch (command.command) {
    case "set_tempo": return fields(oldSession, session, { tempo: a.bpm ?? 120 });
    case "set_time_signature": return fields(oldSession, session, { timeSigNumerator: a.numerator ?? 4, timeSigDenominator: a.denominator ?? 4 });
    case "set_key": {
      const previous = record(oldSession.key), current = record(session.key), expected = pick(a, ["tonic", "mode"]);
      if (["tonic", "mode"].some(key => !(key in expected) && !equal(previous[key], current[key]))) return failed("Unrequested key component changed");
      return fields(previous, current, expected);
    }
    case "set_metronome": {
      if (Object.keys(a).some(key => key !== "enabled")) return unverified("Extended click settings need separate field predicates");
      return fields(oldSession, session, a.enabled === undefined ? {} : { metronome: a.enabled });
    }
    case "set_master_volume": return fields(record(old.master), record(next.master), { volumeDb: a.db ?? 0 });
    case "set_master_pan": return fields(record(old.master), record(next.master), { pan: a.pan ?? 0 });
    case "set_transport": return transportEffect(command, before, after);
    case "set_track_volume": case "set_track_pan": case "set_track_mute": case "set_track_solo":
    case "arm_track": case "rename_track": case "set_track_type": case "set_input_monitor": case "load_drum_kit":
      return trackEffect(command, before, after);
    case "add_midi_clip": case "add_test_tone_clip": case "move_clip": case "trim_clip": case "split_clip":
    case "duplicate_clip": case "remove_clip": case "rename_clip": case "set_clip_gain": case "set_clip_mute":
      return clipEffect(command, before, after);
    case "add_note": case "remove_note": return noteEffect(command, before, after);
    case "create_track": case "remove_track": case "create_section": case "move_section": case "rename_section":
    case "remove_section": case "create_annotation": case "build_skeleton_from_clip": return structureEffect(command, before, after);
    case "save": return unverified("Saving requires file evidence beyond snapshots");
    case "open_plugin_editor": return unverified("Editor visibility requires native window evidence");
    case "undo": case "redo": return unverified("Undo and redo require captured history and expected target snapshots");
    default: return unverified(`No native effect predicate for ${command.command}`);
  }
}
