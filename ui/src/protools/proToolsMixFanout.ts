import { useStore } from "../store";
import type { CommandResult, Snapshot, Track, TrackGroupMixAttribute } from "../types";
import { proToolsMixGroupTrackIds } from "./proToolsTrackGroups";

export type ProToolsMixModifiers = {
  readonly altKey: boolean;
  readonly shiftKey: boolean;
};

export function proToolsMixActionTrackIds(options: {
  readonly snapshot: Snapshot;
  readonly sourceTrackId: string;
  readonly shownTrackIds: readonly string[];
  readonly selectedTrackIds: readonly string[];
  readonly modifiers: ProToolsMixModifiers;
  readonly supports?: (track: Track) => boolean;
}): readonly string[] {
  const { snapshot, sourceTrackId, shownTrackIds, selectedTrackIds, modifiers } = options;
  const supports = options.supports ?? (() => true);
  const byId = new Map(snapshot.tracks.map((track) => [track.id, track]));
  const compatible = shownTrackIds.filter((trackId) => {
    const track = byId.get(trackId);
    return Boolean(track && supports(track));
  });
  const source = compatible.includes(sourceTrackId) ? [sourceTrackId] : [];
  if (!modifiers.altKey) return source;
  if (!modifiers.shiftKey) return compatible;
  const selected = new Set(selectedTrackIds);
  const selectedCompatible = compatible.filter((trackId) => selected.has(trackId));
  return selectedCompatible.length > 0 ? selectedCompatible : source;
}

function commandRoots(
  snapshot: Snapshot,
  requestedTrackIds: readonly string[],
  mixAttribute?: TrackGroupMixAttribute,
): readonly string[] {
  const requested = new Set(requestedTrackIds);
  const covered = new Set<string>();
  const roots: string[] = [];
  for (const track of snapshot.tracks) {
    if (!requested.has(track.id) || covered.has(track.id)) continue;
    roots.push(track.id);
    covered.add(track.id);
    if (mixAttribute)
      for (const linkedTrackId of proToolsMixGroupTrackIds(snapshot, track.id, mixAttribute))
        covered.add(linkedTrackId);
  }
  return roots;
}

export async function executeProToolsMixFanout(options: {
  readonly snapshot: Snapshot;
  readonly targetTrackIds: readonly string[];
  readonly commandForTrack: (trackId: string) => {
    readonly command: string;
    readonly args: Record<string, unknown>;
  };
  readonly mixAttribute?: TrackGroupMixAttribute;
  readonly resultFailure?: (result: CommandResult) => string | null;
}): Promise<boolean> {
  const store = useStore.getState();
  const epoch = store.projectEpoch;
  const targets = commandRoots(options.snapshot, options.targetTrackIds, options.mixAttribute);
  if (targets.length === 0) return false;

  for (const trackId of targets) {
    if (useStore.getState().projectEpoch !== epoch) return false;
    const { command, args } = options.commandForTrack(trackId);
    const result = await store.exec(command, args);
    if (useStore.getState().projectEpoch !== epoch) return false;
    if (!result.ok) {
      store.setLastError(result.error ?? `${command} failed`);
      return false;
    }
    const failure = options.resultFailure?.(result) ?? null;
    if (failure) {
      store.setLastError(failure);
      return false;
    }
  }
  return true;
}
