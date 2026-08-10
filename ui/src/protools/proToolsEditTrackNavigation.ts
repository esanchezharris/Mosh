import { useStore } from "../store";
import { useProTools } from "./proToolsState";
import { scopeProToolsEditSelectionToTracks } from "./proToolsTrackEditSelection";

type ProToolsEditTrackNavigation =
  | { readonly kind: "move"; readonly direction: -1 | 1 }
  | { readonly kind: "extend"; readonly direction: -1 | 1 }
  | { readonly kind: "remove"; readonly edge: "top" | "bottom" };

export function ownsProToolsEditKeyboardFocus(element: Element | null): boolean {
  return element?.closest(".pt-timeline-scroll, [data-clip-id]") !== null;
}

function navigationForEvent(event: KeyboardEvent): ProToolsEditTrackNavigation | null {
  const direction = event.code === "KeyP" ? -1 : event.code === "Semicolon" ? 1 : 0;
  if (direction === 0 || event.metaKey) return null;
  if (event.ctrlKey && event.shiftKey && !event.altKey) return { kind: "extend", direction };
  if (event.ctrlKey && event.altKey && !event.shiftKey) {
    return { kind: "remove", edge: direction === -1 ? "top" : "bottom" };
  }
  const commandFocus = ownsProToolsEditKeyboardFocus(document.activeElement)
    && !event.ctrlKey && !event.altKey && !event.shiftKey;
  const systemMove = event.ctrlKey && !event.altKey && !event.shiftKey;
  return commandFocus || systemMove ? { kind: "move", direction } : null;
}

function orderedEditTrackIds(visibleTrackIds: readonly string[]): readonly string[] {
  const proTools = useProTools.getState();
  const store = useStore.getState();
  const requested = new Set(proTools.editSelectionTrackIds);
  const ordered = visibleTrackIds.filter((trackId) => requested.has(trackId));
  if (ordered.length > 0) return ordered;
  const fallbackTrackId = proTools.editSelectionTrackId ?? store.selectedTrackId;
  return fallbackTrackId && visibleTrackIds.includes(fallbackTrackId) ? [fallbackTrackId] : [];
}

function applyNavigation(
  navigation: ProToolsEditTrackNavigation,
  visibleTrackIds: readonly string[],
): boolean {
  const proTools = useProTools.getState();
  const store = useStore.getState();
  const currentTrackIds = orderedEditTrackIds(visibleTrackIds);
  switch (navigation.kind) {
    case "move": {
      const requestedFocus = proTools.editSelectionTrackId ?? store.selectedTrackId;
      const focusTrackId = requestedFocus && visibleTrackIds.includes(requestedFocus)
        ? requestedFocus
        : currentTrackIds.at(-1);
      if (!focusTrackId) return false;
      const targetTrackId = visibleTrackIds[visibleTrackIds.indexOf(focusTrackId) + navigation.direction];
      if (!targetTrackId) return false;
      scopeProToolsEditSelectionToTracks([targetTrackId], targetTrackId);
      return true;
    }
    case "extend": {
      const edgeTrackId = navigation.direction === -1 ? currentTrackIds[0] : currentTrackIds.at(-1);
      if (!edgeTrackId) return false;
      const targetTrackId = visibleTrackIds[
        visibleTrackIds.indexOf(edgeTrackId) + navigation.direction
      ];
      if (!targetTrackId || currentTrackIds.includes(targetTrackId)) return false;
      const nextTrackIds = navigation.direction === -1
        ? [targetTrackId, ...currentTrackIds]
        : [...currentTrackIds, targetTrackId];
      scopeProToolsEditSelectionToTracks(nextTrackIds, targetTrackId);
      return true;
    }
    case "remove": {
      if (currentTrackIds.length <= 1) return false;
      const nextTrackIds = navigation.edge === "top"
        ? currentTrackIds.slice(1)
        : currentTrackIds.slice(0, -1);
      const focusTrackId = navigation.edge === "top" ? nextTrackIds[0] : nextTrackIds.at(-1);
      if (!focusTrackId) return false;
      scopeProToolsEditSelectionToTracks(nextTrackIds, focusTrackId);
      return true;
    }
  }
  const unreachable: never = navigation;
  return unreachable;
}

export function handleProToolsEditTrackNavigation(event: KeyboardEvent): boolean {
  const navigation = navigationForEvent(event);
  if (!navigation) return false;
  const snapshot = useStore.getState().snapshot;
  if (!snapshot) return false;
  const visibleTrackIds = snapshot.tracks
    .filter((track) => !track.isGroup && !track.isReturn)
    .map((track) => track.id);
  if (!applyNavigation(navigation, visibleTrackIds)) return false;
  event.preventDefault();
  return true;
}
