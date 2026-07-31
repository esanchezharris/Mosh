// Dev/e2e-only override for the session picker, mirroring shellQuery.ts's `?shell=`.
//
// The picker is gated on being inside the real JUCE WebView (see bridge.isRealNative), so
// it can never appear in vitest or in the ~30 Playwright specs that boot against the dev
// mock — the blast radius is structurally zero rather than "zero as long as every spec
// remembers to seed a flag". That also means the picker itself would be untestable, so
// `?picker=1` opts a single spec back in.
//
// import.meta.env.DEV is false in the production single-file bundle, so this can never
// affect the shipped app. Kept dependency-free for the same reason shellQuery.ts is.

export function devPickerOverride(): boolean {
  const env = typeof import.meta !== "undefined"
    ? (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env
    : undefined;
  const dev = Boolean(env?.DEV || env?.MODE === "e2e");
  if (!dev) return false;
  try {
    return new URLSearchParams(window.location.search).get("picker") === "1";
  } catch {
    return false;
  }
}
