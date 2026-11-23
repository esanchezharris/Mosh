// Side-effect application for UI-local settings: project effective values onto the
// document so a chosen skin/theme/scale reskins the running app. Kept separate from
// the value store so the persistence logic stays pure and head-lessly testable.
//
//   (always)       → <html data-skin="mosh"> (V3 is the only shell and has no skin axis)
//   theme          → <html data-theme="…">  (light/dark ground; independent axis)
//   uiScale        → document zoom           (whole-UI reflow; the JUCE WebView handles it)
//   telemetryOptIn → native bridge call      (no DOM effect — see below)
//
// Anything with no visual OR native side effect (voiceOn/voiceVol) is simply
// consumed by its React owner via the store — no effect needed here.

import type { SettingValue } from "./schema";
import { setTelemetryOptIn } from "../bridge";

export function applySettingEffects(values: Record<string, SettingValue>): void {
  if (typeof document === "undefined") return;

  // Opt-in crash reporting + telemetry (default OFF; docs/telemetry/PRIVACY.md).
  // No DOM effect, but this is the same single funnel — called on every settings
  // change AND on boot hydrate — that the crash/telemetry module needs to learn
  // the current opt-in bit. Fire-and-forget + native-only (a no-op in dev/mock/
  // tests, mirroring archivePair() in bridge.ts): never throws, never blocks a
  // settings change on a bridge round-trip.
  void setTelemetryOptIn(Boolean(values.telemetryOptIn));

  const root = document.documentElement;
  // V3 is one Mosh-native design with no skin axis: pin data-skin so mosh.css's shared
  // rules (piano roll, mixer) always resolve the Mosh token set.
  root.setAttribute("data-skin", "mosh");
  if (typeof values.theme === "string") root.setAttribute("data-theme", values.theme);
  if (typeof values.uiScale === "number")
    (root.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(values.uiScale);
}
