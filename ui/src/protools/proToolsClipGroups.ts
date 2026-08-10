import { useStore } from "../store";
import type { Clip, ClipGroup, Snapshot, Track } from "../types";

export type ProToolsClipListEntry = {
  readonly kind: "clip" | "group";
  readonly id: string;
  readonly name: string;
  readonly clip: Clip;
  readonly track: Track;
  readonly clipIds: readonly string[];
  readonly memberCount: number;
};

export function activeClipGroupForClip(
  snapshot: Snapshot,
  clipId: string,
): ClipGroup | null {
  return snapshot.clipGroups?.find((group) =>
    group.active && group.clipIds.includes(clipId)) ?? null;
}

function existingClipIds(snapshot: Snapshot): readonly string[] {
  return snapshot.tracks.flatMap((track) =>
    track.clips.filter((clip) => !clip.hidden).map((clip) => clip.id));
}

export function proToolsClipSelection(snapshot: Snapshot, clipId: string): readonly string[] {
  const group = activeClipGroupForClip(snapshot, clipId);
  if (!group) return [clipId];
  const members = new Set(group.clipIds);
  return existingClipIds(snapshot).filter((candidate) => members.has(candidate));
}

export function proToolsClipListEntries(snapshot: Snapshot): readonly ProToolsClipListEntry[] {
  const groups = new Map<string, ClipGroup>();
  for (const group of snapshot.clipGroups ?? []) {
    if (!group.active) continue;
    for (const clipId of group.clipIds) groups.set(clipId, group);
  }

  const renderedGroups = new Set<string>();
  const entries: ProToolsClipListEntry[] = [];
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      if (clip.hidden) continue;
      const group = groups.get(clip.id);
      if (!group) {
        entries.push({
          kind: "clip",
          id: clip.id,
          name: clip.name,
          clip,
          track,
          clipIds: [clip.id],
          memberCount: 1,
        });
        continue;
      }
      if (renderedGroups.has(group.id)) continue;
      renderedGroups.add(group.id);
      const clipIds = proToolsClipSelection(snapshot, clip.id);
      entries.push({
        kind: "group",
        id: group.id,
        name: group.name,
        clip,
        track,
        clipIds,
        memberCount: clipIds.length,
      });
    }
  }
  return entries;
}

function selectedClipIds(snapshot: Snapshot, selection: ReadonlySet<string>): readonly string[] {
  return existingClipIds(snapshot).filter((clipId) => selection.has(clipId));
}

export function handleProToolsClipGroupShortcut(event: KeyboardEvent): boolean {
  if (event.shiftKey || !event.altKey || (!event.metaKey && !event.ctrlKey)) return false;
  const key = event.key.toLowerCase();
  if (key !== "g" && key !== "u" && key !== "r") return false;

  const store = useStore.getState();
  const snapshot = store.snapshot;
  if (!snapshot) return false;

  if (key === "r") {
    event.preventDefault();
    void store.exec("regroup_clip_group", {});
    return true;
  }

  const selected = selectedClipIds(snapshot, store.selection);
  if (selected.length === 0) return false;
  if (key === "g") {
    event.preventDefault();
    void store.exec("create_clip_group", { clipIds: selected });
    return true;
  }

  const member = selected.find((clipId) => activeClipGroupForClip(snapshot, clipId));
  if (!member) return false;
  event.preventDefault();
  void store.exec("ungroup_clip_group", { clipId: member });
  return true;
}
