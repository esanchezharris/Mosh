import { useStore } from "../store";
import { useProTools } from "./proToolsState";

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

export function selectProToolsTrack(trackId: string): void {
  const proTools = useProTools.getState();
  proTools.setTrackSelectionIds([trackId]);
  if (proTools.trackEditLinked) proTools.setEditSelectionTracks([trackId], trackId);
  useStore.getState().setSelectedTrack(trackId);
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
