import { secAtBeat, tempoMapFrom } from "../time";
import type { Annotation, Snapshot } from "../types";

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
