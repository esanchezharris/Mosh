import { useStore } from "../store";
import { DEFAULT_TRACK_GROUP_MIX_ATTRIBUTES } from "../types";
import type { Snapshot, TrackGroup, TrackGroupKind, TrackGroupMixAttribute } from "../types";
import { useProTools } from "./proToolsState";

export const PROTOOLS_TRACK_GROUP_KIND_LABELS: Readonly<Record<TrackGroupKind, string>> = {
  edit: "Edit",
  mix: "Mix",
  edit_mix: "Edit + Mix",
};
export const PROTOOLS_TRACK_GROUP_KINDS: readonly TrackGroupKind[] = ["edit", "mix", "edit_mix"];

export function isProToolsTrackGroupKind(value: string): value is TrackGroupKind {
  return value === "edit" || value === "mix" || value === "edit_mix";
}

export const PROTOOLS_TRACK_GROUP_ATTRIBUTE_LABELS: Readonly<Record<TrackGroupMixAttribute, string>> = {
  main_volume: "Main Volume",
  main_mute: "Main Mute",
  main_pan: "Main Pan",
  solo: "Solo",
  record_enable: "Record Enable",
  input_monitoring: "Input Monitoring",
};

export function proToolsTrackGroupMixAttributes(group: TrackGroup): readonly TrackGroupMixAttribute[] {
  return group.mixAttributes ?? DEFAULT_TRACK_GROUP_MIX_ATTRIBUTES;
}

function supports(group: TrackGroup, axis: "edit" | "mix"): boolean {
  return group.kind === axis || group.kind === "edit_mix";
}

function linkedTrackIds(
  snapshot: Snapshot,
  seeds: readonly string[],
  axis: "edit" | "mix",
  mixAttribute?: TrackGroupMixAttribute,
): readonly string[] {
  const visibleOrder = snapshot.tracks
    .filter((track) => !track.isGroup && !track.isReturn)
    .map((track) => track.id);
  const existing = new Set(visibleOrder);
  const linked = new Set(seeds.filter((trackId) => existing.has(trackId)));
  if (snapshot.trackGroupsSuspended) return visibleOrder.filter((trackId) => linked.has(trackId));

  let changed = true;
  while (changed) {
    changed = false;
    for (const group of snapshot.trackGroups ?? []) {
      if (!group.enabled || !supports(group, axis)
        || (axis === "mix" && mixAttribute !== undefined
          && !proToolsTrackGroupMixAttributes(group).includes(mixAttribute))
        || !group.trackIds.some((trackId) => linked.has(trackId))) continue;
      for (const trackId of group.trackIds) {
        if (!existing.has(trackId) || linked.has(trackId)) continue;
        linked.add(trackId);
        changed = true;
      }
    }
  }
  return visibleOrder.filter((trackId) => linked.has(trackId));
}

export function proToolsEditGroupSelection(
  snapshot: Snapshot,
  trackIds: readonly string[],
): readonly string[] {
  return linkedTrackIds(snapshot, trackIds, "edit");
}

export function proToolsMixGroupTrackIds(
  snapshot: Snapshot,
  trackId: string,
  mixAttribute: TrackGroupMixAttribute = "main_volume",
): readonly string[] {
  return linkedTrackIds(snapshot, [trackId], "mix", mixAttribute);
}

export function selectProToolsTrackGroup(snapshot: Snapshot, requestedTrackIds: readonly string[]): boolean {
  const orderedTrackIds = snapshot.tracks
    .filter((track) => !track.isGroup && !track.isReturn && requestedTrackIds.includes(track.id))
    .map((track) => track.id);
  const focusTrackId = orderedTrackIds.at(-1);
  if (!focusTrackId) return false;
  const proTools = useProTools.getState();
  proTools.setTrackSelectionIds(orderedTrackIds);
  if (proTools.trackEditLinked)
    proTools.setEditSelectionTracks(orderedTrackIds, focusTrackId);
  const store = useStore.getState();
  if (store.selectedTrackId !== focusTrackId) store.setSelectedTrack(focusTrackId);
  return true;
}

export function handleProToolsTrackGroupShortcut(event: KeyboardEvent): boolean {
  if (event.code !== "KeyG" || event.altKey || event.shiftKey
    || (!event.metaKey && !event.ctrlKey)) return false;
  const store = useStore.getState();
  const snapshot = store.snapshot;
  if (!snapshot) return false;
  const selected = useProTools.getState().trackSelectionIds;
  const fallback = store.selectedTrackId ? [store.selectedTrackId] : [];
  const candidates = selected.length > 0 ? selected : fallback;
  const existing = new Set(snapshot.tracks
    .filter((track) => !track.isGroup && !track.isReturn)
    .map((track) => track.id));
  if (!candidates.some((trackId) => existing.has(trackId))) return false;
  event.preventDefault();
  useProTools.getState().setTrackGroupDialogOpen(true);
  return true;
}
