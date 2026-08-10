import { useStore } from "../store";
import { useProTools } from "./proToolsState";

export function scopeProToolsEditSelectionToTrack(trackId: string): void {
  const proTools = useProTools.getState();
  proTools.setEditSelectionTrackId(trackId);
  const store = useStore.getState();
  if (proTools.trackEditLinked && store.selectedTrackId !== trackId) store.setSelectedTrack(trackId);
}

export function selectProToolsTrack(trackId: string): void {
  const proTools = useProTools.getState();
  if (proTools.trackEditLinked) proTools.setEditSelectionTrackId(trackId);
  useStore.getState().setSelectedTrack(trackId);
}

export function toggleProToolsTrackEditLink(): void {
  const proTools = useProTools.getState();
  const store = useStore.getState();
  if (proTools.trackEditLinked) {
    proTools.setEditSelectionTrackId(store.selectedTrackId ?? proTools.editSelectionTrackId);
    proTools.setTrackEditLinked(false);
    return;
  }
  const trackId = proTools.editSelectionTrackId ?? store.selectedTrackId;
  proTools.setTrackEditLinked(true);
  if (trackId && store.selectedTrackId !== trackId) store.setSelectedTrack(trackId);
}
