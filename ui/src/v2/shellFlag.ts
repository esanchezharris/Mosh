// "Which shell is active" — the single source of truth read by everything that must
// behave differently under the v2 shell (the App router, the webrtc_signal gate in the
// store, Moshi's composer mount). Honors the dev `?shell=` override over the persisted
// `uiShell` setting. Splits into:
//   - isV2Active() — imperative read (for non-React code like the store event router)
//   - useIsV2()    — reactive hook (re-renders when the setting changes)

import { useSettings } from "../settings/store";
import { resolveShell, type ShellId } from "./shellQuery";

export type { ShellId };

/** Imperative: the active shell right now. */
export function activeShell(): ShellId {
  return resolveShell(useSettings.getState().get("uiShell"));
}

export function isV2Active(): boolean {
  return activeShell() === "v2";
}

/** Reactive: subscribes to the uiShell setting so the caller re-renders on a switch. */
export function useIsV2(): boolean {
  const uiShell = useSettings((s) => s.get("uiShell"));
  return resolveShell(uiShell) === "v2";
}

// "Modern shell" = v2 or v3: the two Mosh-native designs that own their composer in a
// dedicated dock (v2 bottom bar, v3 MoshiDock) and pin data-skin=mosh (settings/effects.ts).
// Use these where the behaviour is a property of that design, not of v2 specifically; keep
// isV2Active for things only v2 has (the video room — see store/events.ts onWebrtcSignal).
// V3 parity brief §2 (docs/V3-PARITY-BRIEF-2026-09-17.md).
export function isModernShell(shell: ShellId = activeShell()): boolean {
  return shell === "v2" || shell === "v3";
}

export function useIsModernShell(): boolean {
  const uiShell = useSettings((s) => s.get("uiShell"));
  return isModernShell(resolveShell(uiShell));
}
