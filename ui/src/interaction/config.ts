// The bridge between the settings store and the interaction layer. Pure builders
// assemble the ACTIVE feel / keymap / gesture-table from a settings getter (override
// ?? schema default); the `live*` helpers read straight from the settings store so
// the Arrange pointer/key handlers pick up changes immediately (no re-render needed).

import type { SettingValue } from "../settings/schema";
import { useSettings } from "../settings/store";
import { getWorkflowProfile } from "../settings/workflowProfiles";
import { FEEL_DEFAULTS, type Feel } from "./feel";
import { getKeymap, rebindAction, removeCombo, REBINDABLE_ACTIONS, type ScopedKeymap } from "./keymap";
import { type GestureTable } from "./gestures";
import { getGestureTable } from "./gestureTables";

type Getter = (id: string) => SettingValue;

const num = (v: SettingValue, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export function buildFeel(get: Getter): Feel {
  return {
    dragThreshold: num(get("feel.dragThreshold"), FEEL_DEFAULTS.dragThreshold),
    doubleClickMs: num(get("feel.doubleClickMs"), FEEL_DEFAULTS.doubleClickMs),
    edgeGrabPx: num(get("feel.edgeGrabPx"), FEEL_DEFAULTS.edgeGrabPx),
    snapStrength: num(get("feel.snapStrength"), FEEL_DEFAULTS.snapStrength),
    zoomSensitivity: num(get("feel.zoomSensitivity"), FEEL_DEFAULTS.zoomSensitivity),
    scrollSensitivity: num(get("feel.scrollSensitivity"), FEEL_DEFAULTS.scrollSensitivity),
  };
}

export function gestureTableName(get: Getter): string {
  const v = get("gestureTable");
  return typeof v === "string" ? v : "mosh";
}

export function applyReservedKeyCombos(
  keymap: ScopedKeymap,
  reservedKeyCombos: readonly string[],
): ScopedKeymap {
  let next = keymap;
  for (const combo of reservedKeyCombos) next = removeCombo(next, combo);
  return next;
}

// Active keymap = the selected preset with any non-empty key.* override layered on.
export function buildKeymap(get: Getter): ScopedKeymap {
  const shell = get("uiShell");
  const legacy = get("keymap");
  const profile = getWorkflowProfile(get("workflowProfile"));
  const base = shell === "classic"
    ? (typeof legacy === "string" ? legacy : "mosh")
    : profile.keymapId;
  let km = getKeymap(base);
  for (const action of REBINDABLE_ACTIONS) {
    const v = get(`key.${action}`);
    if (typeof v === "string" && v.trim()) km = rebindAction(km, action, v.trim());
  }
  return shell === "classic" ? km : applyReservedKeyCombos(km, profile.reservedKeyCombos);
}

// ── live readers (event-time): the handlers call these so the latest settings apply
// without forcing React re-renders of the arrangement tree.
const liveGet: Getter = (id) => useSettings.getState().get(id);
export const liveFeel = (): Feel => buildFeel(liveGet);
export const liveKeymap = (): ScopedKeymap => buildKeymap(liveGet);
export const liveGestureTable = (): GestureTable => getGestureTable(gestureTableName(liveGet));
