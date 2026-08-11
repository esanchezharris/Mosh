import { secAtBeat, tempoMapFrom } from "../time";
import type { Annotation, MemoryLocationProperties, Snapshot } from "../types";
import type { TimeRangeSel } from "../v2/shellState";

export type NumberedMemoryLocation = {
  readonly annotation: Annotation;
  readonly number: number;
  readonly seconds: number;
};

export function numberedMemoryLocations(snapshot: Snapshot): NumberedMemoryLocation[] {
  const map = tempoMapFrom(snapshot.session);
  return (snapshot.annotations ?? [])
    .filter((annotation) => Number.isFinite(annotation.beat))
    .map((annotation) => ({ annotation, seconds: Math.max(0, secAtBeat(map, annotation.beat)) }))
    .sort((left, right) => left.seconds - right.seconds
      || left.annotation.text.localeCompare(right.annotation.text)
      || left.annotation.id.localeCompare(right.annotation.id))
    .map((location, index) => ({ ...location, number: index + 1 }));
}

export function filterMemoryLocations(
  locations: readonly NumberedMemoryLocation[],
  query: string,
): NumberedMemoryLocation[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...locations];
  return locations.filter((location) =>
    location.annotation.text.toLocaleLowerCase().includes(needle)
    || String(location.number).includes(needle));
}

export function memoryLocationAtNumber(
  locations: readonly NumberedMemoryLocation[],
  number: number,
): NumberedMemoryLocation | null {
  if (!Number.isInteger(number) || number < 1) return null;
  return locations.find((location) => location.number === number) ?? null;
}

export function adjacentMemoryLocation(
  locations: readonly NumberedMemoryLocation[],
  position: number,
  direction: -1 | 1,
): NumberedMemoryLocation | null {
  const current = Number.isFinite(position) ? position : 0;
  if (direction > 0) {
    return locations.find((location) => location.seconds > current + 1e-6) ?? null;
  }
  return [...locations].reverse()
    .find((location) => location.seconds < current - 1e-6) ?? null;
}

export function captureMemoryLocationProperties({
  storeSelection,
  storeZoom,
  storeVisibility,
  editSelection,
  editTrackIds,
  horizontalZoom,
  shownTrackIds,
  fallbackSelection,
  fallbackHorizontalZoom,
  fallbackShownTrackIds,
}: {
  readonly storeSelection: boolean;
  readonly storeZoom: boolean;
  readonly storeVisibility: boolean;
  readonly editSelection: TimeRangeSel | null;
  readonly editTrackIds: readonly string[];
  readonly horizontalZoom: number;
  readonly shownTrackIds: readonly string[];
  readonly fallbackSelection?: MemoryLocationProperties["editSelection"];
  readonly fallbackHorizontalZoom?: number;
  readonly fallbackShownTrackIds?: readonly string[];
}): MemoryLocationProperties | undefined {
  const properties: MemoryLocationProperties = {};
  const selection = fallbackSelection ?? editSelection;
  if (storeSelection && selection && Number.isFinite(selection.start)
      && Number.isFinite(selection.end) && selection.end >= selection.start) {
    properties.editSelection = {
      start: Math.max(0, selection.start),
      end: Math.max(0, selection.end),
      ...(fallbackSelection?.trackIds
        ? { trackIds: [...fallbackSelection.trackIds] }
        : editSelection ? { trackIds: [...editTrackIds] } : {}),
    };
  }
  const zoom = fallbackHorizontalZoom ?? horizontalZoom;
  if (storeZoom && Number.isFinite(zoom)) properties.horizontalZoom = zoom;
  if (storeVisibility) properties.shownTrackIds = [
    ...(fallbackShownTrackIds ?? shownTrackIds),
  ];
  return Object.keys(properties).length > 0 ? properties : undefined;
}

export function memoryLocationRecallProperties(
  properties: MemoryLocationProperties | undefined,
  currentTrackIds: readonly string[],
): MemoryLocationProperties | undefined {
  if (!properties) return undefined;
  const current = new Set(currentTrackIds);
  const recalled: MemoryLocationProperties = {};
  const selection = properties.editSelection;
  if (selection && Number.isFinite(selection.start) && Number.isFinite(selection.end)
      && selection.start >= 0 && selection.end >= selection.start) {
    recalled.editSelection = {
      start: selection.start,
      end: selection.end,
      ...(selection.trackIds
        ? { trackIds: selection.trackIds.filter((trackId) => current.has(trackId)) }
        : {}),
    };
  }
  if (properties.horizontalZoom !== undefined && Number.isFinite(properties.horizontalZoom)) {
    recalled.horizontalZoom = Math.min(400, Math.max(20, properties.horizontalZoom));
  }
  if (properties.shownTrackIds) {
    recalled.shownTrackIds = properties.shownTrackIds.filter((trackId) => current.has(trackId));
  }
  return Object.keys(recalled).length > 0 ? recalled : undefined;
}
