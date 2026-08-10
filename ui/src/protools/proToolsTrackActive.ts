import { useStore } from "../store";

export async function setProToolsTracksActive(
  requestedTrackIds: readonly string[],
  active: boolean,
): Promise<void> {
  const store = useStore.getState();
  const snapshot = store.snapshot;
  if (!snapshot) return;
  const requested = new Set(requestedTrackIds);
  const tracks = snapshot.tracks.filter((track) =>
    !track.isGroup
    && !track.isReturn
    && requested.has(track.id)
    && (track.active !== false) !== active);
  const epoch = store.projectEpoch;

  for (const track of tracks) {
    if (useStore.getState().projectEpoch !== epoch) return;
    const result = await store.exec("set_track_active", { trackId: track.id, active });
    if (useStore.getState().projectEpoch !== epoch) return;
    if (!result.ok) {
      store.setLastError(result.error ?? "Track active state could not be changed.");
      return;
    }
  }
}
