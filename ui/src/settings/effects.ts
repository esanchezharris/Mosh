// Side-effect application for UI-local settings: project effective values onto the
// document so a chosen skin/theme/scale reskins the running app. Kept separate from
// the value store so the persistence logic stays pure and head-lessly testable.
//
//   skin    → <html data-skin="…">   (token set; see mosh.css skin blocks)
//   theme   → <html data-theme="…">  (light/dark ground; independent axis)
//   uiScale → document zoom           (whole-UI reflow; the JUCE WebView handles it)
//
// Anything with no visual side effect (voiceOn/voiceVol) is simply consumed by its
// React owner via the store — no effect needed here.

import type { SettingValue } from "./schema";
import { resolveShell } from "../v2/shellQuery";

export function applySettingEffects(values: Record<string, SettingValue>): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // The modern shells (v2 + the newer "openlanes" v3) are single Mosh-native designs with
  // NO skin axis. When one is active, pin data-skin to "mosh" so a persisted non-mosh skin
  // (e.g. "ableton") can't leak its token overrides into the shell's scoped CSS. (openlanes
  // scopes its own CSS under .v3-shell and carries its OWN material theme, independent of
  // this axis.) Classic keeps the user's chosen skin.
  const shell = resolveShell(values.uiShell);
  if (shell === "v2" || shell === "openlanes") root.setAttribute("data-skin", "mosh");
  else if (typeof values.skin === "string") root.setAttribute("data-skin", values.skin);
  if (typeof values.theme === "string") root.setAttribute("data-theme", values.theme);
  if (typeof values.uiScale === "number")
    (root.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(values.uiScale);
}
