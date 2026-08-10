import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { appliedFailure } from "./commandFeedback";
import { useProTools } from "./proToolsState";

export type ProToolsTrackControl = "arm" | "solo" | "mute" | "input";

const TRACK_CONTROL_KEYS: Readonly<Partial<Record<string, ProToolsTrackControl>>> = {
  KeyR: "arm",
  KeyS: "solo",
  KeyM: "mute",
  KeyI: "input",
};

export function proToolsEditTrackIds(snapshot: Snapshot): readonly string[] {
  const proTools = useProTools.getState();
  const selectedTrackId = useStore.getState().selectedTrackId;
  const requestedIds = proTools.editSelectionTrackIds.length > 0
    ? proTools.editSelectionTrackIds
    : proTools.editSelectionTrackId
      ? [proTools.editSelectionTrackId]
      : selectedTrackId ? [selectedTrackId] : [];
  const requested = new Set(requestedIds);
  return snapshot.tracks
    .filter((track) => !track.isGroup && !track.isReturn && requested.has(track.id))
    .map((track) => track.id);
}

function trackControlCommand(
  control: ProToolsTrackControl,
  sourceTrack: Track,
): (trackId: string) => { readonly command: string; readonly args: Record<string, unknown> } {
  switch (control) {
    case "arm": {
      const armed = !Boolean(sourceTrack.armed);
      return (trackId) => ({ command: "arm_track", args: { trackId, armed } });
    }
    case "solo": {
      const solo = !Boolean(sourceTrack.solo);
      return (trackId) => ({ command: "set_track_solo", args: { trackId, solo } });
    }
    case "mute": {
      const mute = !Boolean(sourceTrack.mute);
      return (trackId) => ({ command: "set_track_mute", args: { trackId, mute } });
    }
    case "input": {
      const mode = sourceTrack.monitor === "on" ? "automatic" : "on";
      return (trackId) => ({ command: "set_input_monitor", args: { trackId, mode } });
    }
  }
}

export async function applyProToolsTrackControl(
  control: ProToolsTrackControl,
  sourceTrackId: string,
  requestedTrackIds: readonly string[],
): Promise<void> {
  const store = useStore.getState();
  const snapshot = store.snapshot;
  if (!snapshot) return;
  const requested = new Set(requestedTrackIds);
  const tracks = snapshot.tracks.filter((track) => requested.has(track.id));
  const sourceTrack = tracks.find((track) => track.id === sourceTrackId) ?? tracks[0];
  if (!sourceTrack) return;
  const commandForTrack = trackControlCommand(control, sourceTrack);
  const epoch = store.projectEpoch;

  for (const track of tracks) {
    if (useStore.getState().projectEpoch !== epoch) return;
    const { command, args } = commandForTrack(track.id);
    const result = await store.exec(command, args);
    if (useStore.getState().projectEpoch !== epoch) return;
    if (!result.ok) {
      store.setLastError(result.error ?? `${command} failed`);
      return;
    }
    const failure = control === "arm"
      ? appliedFailure(result, "Record arm could not be applied.")
      : control === "input"
        ? appliedFailure(result, "Input Monitor could not be applied.")
        : null;
    if (failure) {
      store.setLastError(failure);
      return;
    }
  }
}

export function handleProToolsTrackControlShortcut(event: KeyboardEvent): boolean {
  const control = TRACK_CONTROL_KEYS[event.code];
  if (!control || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
  const store = useStore.getState();
  if (!store.snapshot) return false;
  const trackIds = proToolsEditTrackIds(store.snapshot);
  if (trackIds.length === 0) return false;
  const focusTrackId = useProTools.getState().editSelectionTrackId;
  const sourceTrackId = focusTrackId && trackIds.includes(focusTrackId)
    ? focusTrackId
    : trackIds.at(-1);
  if (!sourceTrackId) return false;
  event.preventDefault();
  void applyProToolsTrackControl(control, sourceTrackId, trackIds);
  return true;
}
