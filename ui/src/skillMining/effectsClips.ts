import { array, record } from "./types";
import type { Command, Json } from "./types";
import { byId, clips, created, equal, failed, fields, passed, pick, removed, unchangedOthers, unverified, without } from "./effectsCore";
import type { Effect, Obj } from "./effectsCore";

const content = (clip: Obj): Obj => without(clip, ["renderLayer", "hasRenderLayer"]);
const sortedNotes = (notes: readonly Obj[]): Obj[] => [...notes].sort((a, b) => JSON.stringify([a.start, a.pitch, a.length, a.velocity]).localeCompare(JSON.stringify([b.start, b.pitch, b.length, b.velocity])));
export function clipEffect(command: Command, before: Json, after: Json): Effect {
  const a = command.args, old = clips(before), next = clips(after);
  const source = byId(old, a.clipId), target = byId(next, a.clipId);
  if (command.command === "remove_clip") return removed(old, next, a.clipId);
  if (command.command === "add_midi_clip") {
    const expected: Obj = { type: "midi", start: a.start ?? 0, length: a.length ?? 2, name: a.name ?? "MIDI" };
    if (a.trackId !== undefined) expected.trackId = a.trackId;
    const result = created(old, next, expected);
    if (result.status !== "passed") return result;
    const added = next.find(item => !byId(old, item.id));
    if (!Array.isArray(added?.notes)) return unverified("Created MIDI note array is missing");
    const notes = array(added.notes).map(record).map(note => pick(note, ["pitch", "start", "length", "velocity"]));
    const requested = array(a.notes).map(record).map(note => ({ pitch: note.pitch ?? 60, start: note.start ?? 0, length: note.length ?? 1, velocity: note.velocity ?? 100 }));
    return equal(sortedNotes(notes), sortedNotes(requested)) ? passed() : failed("New MIDI clip notes differ from requested content");
  }
  if (command.command === "add_test_tone_clip") {
    const result = created(old, next, { type: "wave", length: a.seconds ?? 2, ...pick(a, ["trackId", "name"]) });
    return result.status === "passed" ? unverified("Clip creation observed; generated tone frequency requires source audio evidence") : result;
  }
  if (!source || !target) return failed("Addressed clip is missing before or after the command");
  if (command.command === "duplicate_clip") {
    if (typeof source.start !== "number" || typeof source.length !== "number") return unverified("Source clip timing is missing");
    return created(old, next, { ...pick(source, ["trackId", "type", "name", "length", "mute"]),
      ...(source.type === "midi" ? pick(source, ["notes"]) : pick(source, ["offset", "sourceFile", "gainDb", "clipGainPoints"])),
      start: source.start + source.length });
  }
  if (command.command === "split_clip") {
    if (source.type !== "wave") return unverified("MIDI split note and loop transformations require a dedicated native oracle");
    if (typeof source.start !== "number" || typeof source.length !== "number" || typeof source.offset !== "number" || typeof a.time !== "number")
      return unverified("Split timing evidence is incomplete");
    const end = source.start + source.length;
    const at = a.time > source.start + 1e-6 && a.time < end - 1e-6 ? a.time : source.start + a.time;
    const added = next.filter(item => !byId(old, item.id));
    if (!(at > source.start + 1e-6 && at < end - 1e-6) || added.length !== 1) return failed("Expected one valid split piece");
    const right = added[0];
    if (!equal(pick(target, ["start", "length", "offset", "trackId"]), { start: source.start, length: at - source.start, offset: source.offset, trackId: source.trackId })
      || !equal(pick(right, ["start", "length", "offset", "trackId"]), { start: at, length: end - at, offset: source.offset + at - source.start, trackId: source.trackId })
      || !equal(target.sourceFile, source.sourceFile) || !equal(right.sourceFile, source.sourceFile)
      || !equal(pick(target, ["name", "type", "mute", "gainDb"]), pick(source, ["name", "type", "mute", "gainDb"]))
      || !equal(pick(right, ["name", "type", "mute", "gainDb"]), pick(source, ["name", "type", "mute", "gainDb"]))
      || !unchangedOthers(old, next, [source.id, right.id])) return failed("Split pieces or unaffected clips do not match the source");
    return passed();
  }
  if (a.ripple === true || array(record(before).clipGroups).some(group => array(record(group).clipIds).includes(source.id)))
    return unverified("Ripple or grouped clip edits require group-aware movement evidence");
  let expected: Obj;
  switch (command.command) {
    case "move_clip": expected = { start: a.start ?? source.start, trackId: a.trackId ?? source.trackId }; break;
    case "trim_clip": expected = { start: a.start ?? source.start, length: a.length ?? source.length, offset: a.offset ?? source.offset }; break;
    case "rename_clip": expected = { name: a.name ?? "" }; break;
    case "set_clip_mute": expected = { mute: a.mute ?? false }; break;
    case "set_clip_gain": expected = { gainDb: a.gainDb ?? 0 }; break;
    default: return unverified(`No clip predicate for ${command.command}`);
  }
  const changedKeys = Object.keys(expected);
  if (!equal(without(content(source), changedKeys), without(content(target), changedKeys)) || !unchangedOthers(old, next, [source.id]))
    return failed("Unexpected changes to clip content or other clips");
  return fields(source, target, expected);
}
