import { array, record } from "./types";
import type { Command, Json } from "./types";
import { byId, clips, created, equal, failed, fields, pick, removed, tracks, unchangedOthers, unverified } from "./effectsCore";
import type { Effect, Obj } from "./effectsCore";

export function structureEffect(command: Command, before: Json, after: Json): Effect {
  const a = command.args, old = record(before), next = record(after);
  if (command.command === "create_track") {
    return created(tracks(before), tracks(after), { ...pick(a, ["name"]), type: a.type ?? "audio", clips: [] });
  }
  if (command.command === "remove_track") return removed(tracks(before), tracks(after), a.trackId);
  if (command.command === "create_annotation") {
    return created(array(old.annotations).map(record), array(next.annotations).map(record), {
      text: a.text ?? "", beat: a.beat ?? 0, ...pick(a, ["color", "author", "memoryLocation"]),
      ...(a.annotationId === undefined ? {} : { id: a.annotationId }),
    });
  }
  if (command.command === "build_skeleton_from_clip") {
    const clip = byId(clips(before), a.clipId);
    if (!clip || clip.type !== "wave") return failed("Skeleton source wave clip is missing");
    const source = byId(tracks(before), clip.trackId), target = byId(tracks(after), clip.trackId);
    if (!source || !target || source.lyricSheet !== undefined) return failed("Skeleton requires a source track without a lyric sheet");
    const sheet = record(target.lyricSheet);
    if (typeof sheet.id !== "string" || sheet.grid !== (a.grid ?? "1/16") || array(sheet.lines).length === 0) return failed("Requested skeleton sheet was not observed on the source track");
    if (!equal(clips(before), clips(after))) return failed("Skeleton extraction altered source clips");
    return unverified("Skeleton sheet observed; extraction content requires service output evidence");
  }
  const sections = array(old.sections).map(record), afterSections = array(next.sections).map(record);
  if (command.command === "create_section") {
    const startBeat = a.startBeat ?? 0;
    return created(sections, afterSections, { name: a.name ?? "", startBeat, endBeat: a.endBeat ?? (typeof startBeat === "number" ? startBeat + 16 : 16), ...pick(a, ["color"]) });
  }
  if (command.command === "remove_section") return removed(sections, afterSections, a.sectionId);
  const source = byId(sections, a.sectionId), target = byId(afterSections, a.sectionId);
  if (a.sectionId === undefined || !unchangedOthers(sections, afterSections, [a.sectionId])) return failed("Unrelated sections changed");
  let expected: Obj;
  switch (command.command) {
    case "rename_section": expected = { name: a.name ?? "" }; break;
    case "move_section": expected = { startBeat: a.startBeat ?? 0, endBeat: a.endBeat ?? 0 }; break;
    default: return unverified(`No structural predicate for ${command.command}`);
  }
  if (source && target && Object.keys(source).some(key => !(key in expected) && !equal(source[key], target[key]))) return failed("Unrelated section fields changed");
  return fields(source, target, expected);
}
