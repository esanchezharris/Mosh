import { useStore } from "../store";
import { useShell } from "../v2/shellState";
import { useProTools } from "./proToolsState";

export type ProToolsTrackSelectionOptions = {
  readonly additive?: boolean;
  readonly range?: boolean;
  readonly visibleTrackIds?: readonly string[];
};

export function scopeProToolsEditSelectionToTrack(trackId: string): void {
  scopeProToolsEditSelectionToTracks([trackId], trackId);
}

export function scopeProToolsEditSelectionToTracks(
  trackIds: readonly string[],
  focusTrackId: string,
): void {
  const proTools = useProTools.getState();
  proTools.setEditSelectionTracks(trackIds, focusTrackId);
  const store = useStore.getState();
  if (!proTools.trackEditLinked) return;
  proTools.setTrackSelectionIds(trackIds);
  if (store.selectedTrackId !== focusTrackId) store.setSelectedTrack(focusTrackId);
}

export function moveProToolsEditSelection(
  direction: -1 | 1,
  visibleTrackIds: readonly string[],
): boolean {
  const proTools = useProTools.getState();
  const store = useStore.getState();
  const focusTrackId = proTools.editSelectionTrackId ?? store.selectedTrackId;
  if (!focusTrackId) return false;
  const focusIndex = visibleTrackIds.indexOf(focusTrackId);
  if (focusIndex < 0) return false;
  const targetTrackId = visibleTrackIds[focusIndex + direction];
  if (!targetTrackId) return false;
  scopeProToolsEditSelectionToTracks([targetTrackId], targetTrackId);
  return true;
}

export function selectProToolsTrack(
  trackId: string,
  options: ProToolsTrackSelectionOptions = {},
): void {
  const proTools = useProTools.getState();
  const store = useStore.getState();
  const visibleTrackIds = options.visibleTrackIds ?? [trackId];
  const currentTrackIds = proTools.trackSelectionIds.length > 0
    ? proTools.trackSelectionIds
    : store.selectedTrackId ? [store.selectedTrackId] : [];
  const current = new Set(currentTrackIds);
  let nextTrackIds: readonly string[];

  if (options.additive) {
    if (current.has(trackId)) current.delete(trackId);
    else current.add(trackId);
    nextTrackIds = visibleTrackIds.filter((id) => current.has(id));
  } else if (options.range) {
    const anchorTrackId = store.selectedTrackId && visibleTrackIds.includes(store.selectedTrackId)
      ? store.selectedTrackId
      : currentTrackIds.slice().reverse().find((id) => visibleTrackIds.includes(id)) ?? trackId;
    const anchorIndex = visibleTrackIds.indexOf(anchorTrackId);
    const trackIndex = visibleTrackIds.indexOf(trackId);
    nextTrackIds = anchorIndex < 0 || trackIndex < 0
      ? [trackId]
      : visibleTrackIds.slice(
        Math.min(anchorIndex, trackIndex),
        Math.max(anchorIndex, trackIndex) + 1,
      );
  } else {
    nextTrackIds = [trackId];
  }

  const focusTrackId = nextTrackIds.includes(trackId)
    ? trackId
    : store.selectedTrackId && nextTrackIds.includes(store.selectedTrackId)
      ? store.selectedTrackId
      : nextTrackIds.at(-1) ?? null;
  proTools.setTrackSelectionIds(nextTrackIds);
  if (proTools.trackEditLinked) {
    proTools.setEditSelectionTracks(nextTrackIds, focusTrackId);
    if (nextTrackIds.length === 0) useShell.getState().setTimeRange(null);
  }
  if (store.selectedTrackId !== focusTrackId) store.setSelectedTrack(focusTrackId);
}

export function toggleProToolsTrackEditLink(): void {
  const proTools = useProTools.getState();
  const store = useStore.getState();
  if (proTools.trackEditLinked) {
    const fallbackTrackId = store.selectedTrackId ?? proTools.editSelectionTrackId;
    const editTrackIds = proTools.editSelectionTrackIds.length > 0
      ? proTools.editSelectionTrackIds
      : fallbackTrackId ? [fallbackTrackId] : [];
    const trackIds = proTools.trackSelectionIds.length > 0
      ? proTools.trackSelectionIds
      : editTrackIds;
    proTools.setEditSelectionTracks(editTrackIds, proTools.editSelectionTrackId ?? fallbackTrackId);
    proTools.setTrackSelectionIds(trackIds);
    proTools.setTrackEditLinked(false);
    return;
  }
  const fallbackTrackId = proTools.editSelectionTrackId ?? store.selectedTrackId;
  const editTrackIds = proTools.editSelectionTrackIds.length > 0
    ? proTools.editSelectionTrackIds
    : fallbackTrackId ? [fallbackTrackId] : [];
  const trackId = fallbackTrackId && editTrackIds.includes(fallbackTrackId)
    ? fallbackTrackId
    : editTrackIds.at(-1) ?? null;
  proTools.setEditSelectionTracks(editTrackIds, trackId);
  proTools.setTrackSelectionIds(editTrackIds);
  proTools.setTrackEditLinked(true);
  if (trackId && store.selectedTrackId !== trackId) store.setSelectedTrack(trackId);
}
