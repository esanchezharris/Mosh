import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../store";
import type { AutoPoint } from "../types";
import {
  automationClipboardFromSelection,
  automationPointIsSelected,
  automationPointsForPaste,
  selectedAutomationPointIndices,
  type AutomationRange,
  type AutomationTarget,
} from "./automationEditing";
import { useProTools } from "./proToolsState";

type Options = {
  readonly trackId: string;
  readonly target: AutomationTarget | null;
  readonly points: readonly AutoPoint[];
  readonly selection: AutomationRange | null;
  readonly position: number;
};

export function useProToolsAutomationClipboard(options: Options) {
  const { trackId, target, points, selection, position } = options;
  const exec = useStore((state) => state.exec);
  const runAtomic = useStore((state) => state.runAtomic);
  const clipboard = useProTools((state) => state.automationClipboard);
  const setClipboard = useProTools((state) => state.setAutomationClipboard);
  const canCopy = selection !== null
    && points.some((point) => automationPointIsSelected(point, selection));
  const canPaste = clipboard !== null && target !== null;

  const copy = () => {
    if (!selection || !target) return false;
    const next = automationClipboardFromSelection(points, selection, target.paramName);
    if (!next) return false;
    setClipboard(next);
    return true;
  };

  const cut = () => {
    if (!selection || !target || !copy()) return false;
    const indices = selectedAutomationPointIndices(points, selection);
    void runAtomic("cut automation", async (atomicExec) => {
      for (const pointIndex of indices) {
        const result = await atomicExec("remove_automation_point", {
          trackId,
          pluginIndex: target.pluginIndex,
          paramIndex: target.paramIndex,
          pointIndex,
        });
        if (!result.ok) break;
      }
    });
    return true;
  };

  const paste = () => {
    if (!clipboard || !target) return false;
    const pastedPoints = automationPointsForPaste(clipboard, position);
    if (pastedPoints.length === 0) return false;
    void exec("write_automation_curve", {
      trackId,
      pluginIndex: target.pluginIndex,
      paramIndex: target.paramIndex,
      apply: "replace",
      replaceStart: position,
      replaceEnd: position + clipboard.duration,
      points: pastedPoints,
    });
    return true;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const key = event.key.toLowerCase();
    if (!(event.metaKey || event.ctrlKey) || event.altKey
      || (key !== "c" && key !== "x" && key !== "v")) return false;
    event.preventDefault();
    event.stopPropagation();
    if (key === "c") copy();
    else if (key === "x") cut();
    else paste();
    return true;
  };

  return { canCopy, canPaste, copy, cut, onKeyDown, paste };
}
