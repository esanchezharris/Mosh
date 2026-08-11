import { useStore } from "../store";
import { useShell } from "../v2/shellState";
import { applyProToolsFadePlan } from "./proToolsFadeApply";
import {
  buildProToolsFadePlan,
  proToolsFadeTargets,
} from "./proToolsFades";
import { currentProToolsDefaultFadeOptions } from "./proToolsFadeDefaults";
import { useProTools } from "./proToolsState";

export { DEFAULT_PROTOOLS_FADE_OPTIONS } from "./proToolsFadeDefaults";

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
  if (targets.length === 0) return true;
  if (event.metaKey && event.ctrlKey) {
    const plan = buildProToolsFadePlan(targets, currentProToolsDefaultFadeOptions());
    void applyProToolsFadePlan("create default fades", plan, store.projectEpoch)
      .then((result) => {
        if (!result.stale && result.error) useStore.getState().setLastError(result.error);
      });
  } else {
    onOpenFades?.();
  }
  return true;
}
