import { useStore } from "../store";
import { useShell } from "../v2/shellState";
import { proToolsFadeTargets } from "./proToolsFades";
import { useProTools } from "./proToolsState";

export function handleProToolsFadesShortcut(
  event: KeyboardEvent,
  onOpenFades?: () => void,
): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey
    || event.key.toLowerCase() !== "f") return false;

  event.preventDefault();
  const store = useStore.getState();
  const snapshot = store.snapshot;
  if (!snapshot) return true;
  const proTools = useProTools.getState();
  const targets = proToolsFadeTargets({
    snapshot,
    selectedClipIds: store.selection,
    editingClipId: store.editingClipId,
    editRange: useShell.getState().timeRange,
    editTrackIds: proTools.editSelectionTrackIds,
  });
  if (targets.length > 0) onOpenFades?.();
  return true;
}
