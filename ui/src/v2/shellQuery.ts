// Dev/e2e-only shell override. Reads a `?shell=v2` / `?shell=classic` query param so
// `npm run dev` and Playwright can pick a shell per page-load WITHOUT mutating the
// persisted setting. The explicit development mode is absent from the production bundle,
// so this can never affect the shipped app.
//
// This file intentionally imports NOTHING from settings/* — settings/effects.ts reads
// it, and effects.ts is itself imported by the settings store, so a settings import
// here would create an evaluation cycle. Keep it dependency-free.

// "live" is the additive Live-12-Arrangement clone shell (ui/src/live) — same
// registration seam as v2: a uiShell enum value plus this dev-only override.
export type ShellId = "classic" | "v2" | "live";

export function devShellOverride(): ShellId | null {
  // import.meta.env may be undefined in some non-Vite contexts; guard defensively.
  const mode = typeof import.meta !== "undefined"
    ? (import.meta as { env?: { MODE?: string } }).env?.MODE
    : undefined;
  const dev = mode === "development" || mode === "e2e" || mode === "test";
  if (!dev) return null;
  try {
    const q = new URLSearchParams(window.location.search).get("shell");
    if (q === "v2") return "v2";
    if (q === "live") return "live";
    if (q === "classic" || q === "legacy") return "classic"; // accept "legacy" as an alias
    return null;
  } catch {
    return null;
  }
}

// Resolve the active shell from an explicit uiShell value, honoring the dev override.
// Pure (no store read) so both the reactive store path and effects.ts can share it.
export function resolveShell(uiShell: unknown): ShellId {
  const over = devShellOverride();
  if (over) return over;
  if (uiShell === "v2") return "v2";
  if (uiShell === "live") return "live";
  return "classic";
}
