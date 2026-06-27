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
  // The v2 shell is a single Mosh-native design with NO skin axis. When it's active,
  // pin data-skin to "mosh" so a persisted non-mosh skin (e.g. "ableton") can't leak
  // its token overrides into v2's scoped CSS. Classic keeps the user's chosen skin.
  if (resolveShell(values.uiShell) === "v2") root.setAttribute("data-skin", "mosh");
  else if (typeof values.skin === "string") root.setAttribute("data-skin", values.skin);
  if (typeof values.theme === "string") root.setAttribute("data-theme", values.theme);
  if (typeof values.uiScale === "number")
    (root.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(values.uiScale);
}
