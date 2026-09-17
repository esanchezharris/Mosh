import { array, record } from "./types";
import type { Command, Json } from "./types";
import { byId, clips, equal, failed, passed, unchangedOthers, unverified, without } from "./effectsCore";
import type { Effect, Obj } from "./effectsCore";

const notes = (clip: Obj): Obj[] => array(clip.notes).map(record).map(note => without(note, ["i"]));
const noteKey = (note: Obj): string => JSON.stringify([note.pitch, note.start, note.length, note.velocity, note.mute ?? false]);
const sorted = (values: readonly Obj[]): Obj[] => [...values].sort((a, b) => noteKey(a).localeCompare(noteKey(b)));
export function noteEffect(command: Command, before: Json, after: Json): Effect {
  const old = clips(before), next = clips(after), a = command.args;
  const source = byId(old, a.clipId), target = byId(next, a.clipId);
  if (!source || !target) return failed("Addressed MIDI clip is missing");
  if (!Array.isArray(source.notes) || !Array.isArray(target.notes)) return unverified("Native note arrays are missing");
  if (!unchangedOthers(old, next, [source.id]) || !equal(without(source, ["notes", "renderLayer"]), without(target, ["notes", "renderLayer"])))
    return failed("Note command changed unrelated clip state");
  let expected = notes(source);
  if (command.command === "remove_note") {
    const index = array(source.notes).findIndex(note => record(note).i === a.noteIndex);
    if (index < 0) return failed("Addressed note index is missing before removal");
    expected = expected.filter((_, position) => position !== index);
  } else {
    const incoming = (Array.isArray(a.notes) ? a.notes : [a]).map(record).map(note => ({
      pitch: note.pitch ?? 60, start: note.start ?? 0, length: note.length ?? 1, velocity: note.velocity ?? 100,
    }));
    if (incoming.length === 0) return failed("No notes requested");
    for (const winner of incoming) {
      if (typeof winner.start !== "number" || typeof winner.length !== "number") return failed("Invalid requested note timing");
      const start = winner.start, end = start + winner.length;
      const room: Obj[] = [];
      for (const note of expected) {
        if (typeof note.start !== "number" || typeof note.length !== "number") return unverified("Existing note timing is missing");
        const noteEnd = note.start + note.length;
        if (note.pitch !== winner.pitch || noteEnd <= start + 1e-9 || note.start >= end - 1e-9) { room.push(note); continue; }
        if (start - note.start >= 0.0625) room.push({ ...note, length: start - note.start });
        if (noteEnd - end >= 0.0625) room.push({ ...note, start: end, length: noteEnd - end });
      }
      expected = [...room, winner];
    }
  }
  if (!equal(sorted(expected), sorted(notes(target)))) return failed("Actual MIDI notes differ from the requested mutation");
  return equal(sorted(notes(source)), sorted(notes(target))) ? unverified("Requested notes were already present; no state change observed") : passed();
}
