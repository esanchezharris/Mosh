// Dev-only entry for the Character Lab demo. `?view=character-lab` swaps the whole shell
// for the lab panel on the dev server / e2e — WITHOUT touching any persisted setting.
// import.meta.env.DEV is false in the shipped single-file bundle, so the lab is
// unreachable in production and the shipping shells are unaffected. Dependency-free by
// design (mirrors v2/shellQuery.ts) so it can be imported from App.tsx before init().

export function isCharacterLab(): boolean {
  const dev = typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  if (!dev) return false;
  try {
    return new URLSearchParams(window.location.search).get("view") === "character-lab";
  } catch {
    return false;
  }
}

// Dev-only entry for the Moshi REDESIGN lab — the side-by-side runtime bake-off
// (SVG springs vs state-machine vs trimmed 2D shader) for the post-raymarcher Moshi.
// Same DEV gate + zero-store doctrine as the character lab above.
export function isMoshiLab(): boolean {
  const dev = typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  if (!dev) return false;
  try {
    return new URLSearchParams(window.location.search).get("view") === "moshi-lab";
  } catch {
    return false;
  }
}
