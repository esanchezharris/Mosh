// "Which shell is active" — the single source of truth read by everything that must
// behave differently under a MODERN shell (the App router, the webrtc_signal gate in the
// store, Moshi's composer mount, the v2-layout settings panel). Honors the dev `?shell=`
// override over the persisted `uiShell` setting. There are now two modern shells (v2 and
// the newer "openlanes" v3); the gates below apply to BOTH — hence isV2Active/useIsV2 are
// intentionally "is a modern (non-classic) shell active", and the openlanes-specific
// helpers below distinguish v3 when a caller genuinely needs to.
//   - isV2Active() / isModernShell() — imperative (for non-React code like the store router)
//   - useIsV2()    / useIsModernShell() — reactive hook (re-renders when the setting changes)
//   - isOpenLanesActive() / useIsOpenLanes() — strictly the v3 shell

import { useSettings } from "../settings/store";
import { resolveShell, type ShellId } from "./shellQuery";

export type { ShellId };

/** Imperative: the active shell right now. */
export function activeShell(): ShellId {
  return resolveShell(useSettings.getState().get("uiShell"));
}

/** Imperative: any modern (non-classic) shell — v2 or openlanes. */
export function isModernShell(): boolean {
  return activeShell() !== "classic";
}
/** Reactive: any modern (non-classic) shell — v2 or openlanes. */
export function useIsModernShell(): boolean {
  const uiShell = useSettings((s) => s.get("uiShell"));
  return resolveShell(uiShell) !== "classic";
}

// Back-compat aliases — the existing call sites (store webrtc gate, Moshi composer,
// settings panel) all want "modern shell", so these forward to the broadened predicate.
export const isV2Active = isModernShell;
export const useIsV2 = useIsModernShell;

/** Imperative: strictly the openlanes (v3) shell. */
export function isOpenLanesActive(): boolean {
  return activeShell() === "openlanes";
}
/** Reactive: strictly the openlanes (v3) shell. */
export function useIsOpenLanes(): boolean {
  const uiShell = useSettings((s) => s.get("uiShell"));
  return resolveShell(uiShell) === "openlanes";
}
