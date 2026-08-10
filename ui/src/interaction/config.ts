// The bridge between the settings store and the interaction layer. Pure builders
// assemble the ACTIVE feel / keymap / gesture-table from a settings getter (override
// ?? schema default); the `live*` helpers read straight from the settings store so
// the Arrange pointer/key handlers pick up changes immediately (no re-render needed).

import type { SettingValue } from "../settings/schema";
import { useSettings } from "../settings/store";
import { FEEL_DEFAULTS, type Feel } from "./feel";
import { getKeymap, REBINDABLE_ACTIONS, type Keymap } from "./keymap";
import { type GestureTable } from "./gestures";
import { getGestureTable } from "./gestureTables";
import { resolveShell } from "../v2/shellQuery";

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

// Active keymap = the selected preset with any non-empty key.* override layered on.
export function buildKeymap(get: Getter): Keymap {
  const base = get("keymap");
  const km: Keymap = { ...getKeymap(typeof base === "string" ? base : "mosh") };
  for (const action of REBINDABLE_ACTIONS) {
    const v = get(`key.${action}`);
    if (typeof v === "string" && v.trim()) km[action] = v.trim();
  }
  return km;
}

// ── live readers (event-time): the handlers call these so the latest settings apply
// without forcing React re-renders of the arrangement tree.

// Resolve-time ONLY (nothing is materialized): with no EXPLICIT keymap/gestureTable
// override persisted — and an explicit "mosh" IS an explicit choice — the LIVE shell
// resolves these two settings to "ableton" (its native interaction bundle). Every
// other shell, and every explicit user choice, resolves exactly as before. This is
// the fix for "the live shell boots with the mosh bundle and its Live keys are dead"
// (uiShell defaults to "live" while keymap/gestureTable default to "mosh"; the
// ableton bundle only ever materialized if the user picked the template by hand).
// activeKeymap() in settings/store.ts mirrors this resolution for key.* rebind
// buckets — the two must agree or rebinds land in the wrong keymap's bucket.
export function effectiveInteractionSetting(id: string): SettingValue {
  const st = useSettings.getState();
  if (id !== "keymap" && id !== "gestureTable") return st.get(id);
  const explicit = st.values[id];
  if (explicit !== undefined) return explicit;              // the user's choice always wins
  // The EFFECTIVE shell (honors the dev/e2e ?shell= override), not just the
  // persisted value — a ?shell=v2 boot with uiShell unset must NOT get the bundle.
  if (resolveShell(st.get("uiShell")) === "live") return "ableton";
  return st.get(id);                                        // every other shell: schema default
}

const liveGet: Getter = (id) => effectiveInteractionSetting(id);
export const liveFeel = (): Feel => buildFeel(liveGet);
export const liveKeymap = (): Keymap => buildKeymap(liveGet);
export const liveGestureTable = (): GestureTable => getGestureTable(gestureTableName(liveGet));
