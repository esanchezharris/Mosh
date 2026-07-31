// Dev-only entry for the Character Lab demo. `?view=character-lab` swaps the whole shell
// for the lab panel on the dev server / e2e — WITHOUT touching any persisted setting.
// The explicit development mode is absent from the shipped single-file bundle, so the lab is
// unreachable in production and the shipping shells are unaffected. Dependency-free by
// design (mirrors v2/shellQuery.ts) so it can be imported from App.tsx before init().

export function isCharacterLab(): boolean {
  const mode = typeof import.meta !== "undefined"
    ? (import.meta as { env?: { MODE?: string } }).env?.MODE
    : undefined;
  const dev = mode === "development" || mode === "test";
  if (!dev) return false;
  try {
    return new URLSearchParams(window.location.search).get("view") === "character-lab";
  } catch {
    return false;
  }
}
