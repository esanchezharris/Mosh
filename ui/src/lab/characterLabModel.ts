// Character Lab — the pure, DOM-free core of the knob demo. No React, no WebGL here:
// just the family-name math (mirrored from moshi.js) and the control descriptors that
// map each slider/toggle onto the component's public API. Keeping this pure means the
// wiring is unit-testable headless (no GL context) and the panel renders its rack from
// data, so a control can never drift from the API call it claims to make.

// The structural slice of moshi.js's API the lab drives. (Moshi.tsx declares the full
// type for the product wiring; the lab only needs these methods, typed loosely so a
// mock api satisfies it in tests.)
export type MoshiApiLike = {
  set: (k: string, v: number) => unknown;
  setPersonality: (n: string | number, seed?: number, o?: object) => unknown;
  setStyle: (s: string) => unknown;
  setQuality: (q: string) => unknown;
  setAnatomy: (a: string) => unknown;
};

// The canonical family order (Object.keys(FAMILIES) in moshi.js). Used as a fallback so
// tests and a pre-load render don't depend on the WebGL component being on `window`.
export const FAMILY_NAMES_FALLBACK = [
  "TAR", "DISCO", "MOLTEN", "GHOST", "SILK", "BREAKS", "CHROME", "BUBBLE", "PORCELAIN",
] as const;

type MoshiStatics = {
  PERSONALITIES?: string[];
  STYLES?: string[];
  QUALITIES?: string[];
  ANATOMIES?: string[];
};

function statics(): MoshiStatics {
  if (typeof window === "undefined") return {};
  return ((window as unknown as { Moshi?: MoshiStatics }).Moshi) ?? {};
}

// Read the live option lists off the component when present (single source of truth),
// else fall back to the known-good lists so the lab can't drift or crash headless.
export function familyNames(): readonly string[] {
  const p = statics().PERSONALITIES;
  return p && p.length ? p : FAMILY_NAMES_FALLBACK;
}
export function styleOptions(): readonly string[] {
  return statics().STYLES ?? ["ps2", "toon", "baked"];
}
export function qualityOptions(): readonly string[] {
  return statics().QUALITIES ?? ["ps1", "ps2", "ps2+"];
}
export function anatomyOptions(): readonly string[] {
  return statics().ANATOMIES ?? ["A", "B", "C"];
}

// Mirrors moshi.js setPersonality(number): NAMES[floor(((v%1)+1)%1 * NAMES.length)].
// The double-mod normalizes negatives and keeps v===1 wrapping to the first family,
// exactly as the component does, so the on-screen label always matches the render.
export function familyNameAt(dial: number, names: readonly string[] = familyNames()): string {
  const frac = ((dial % 1) + 1) % 1;
  const idx = Math.floor(frac * names.length);
  return names[idx] ?? names[0];
}

// ── continuous controls ─────────────────────────────────────────────────────
// MORPH is special (it drives texture+color via setPersonality and owns the seed
// context), so it has dedicated appliers. The plain drives are uniform.
export type DriveKey = "energy" | "heat" | "mood";
export type SliderSpec = { key: DriveKey; label: string; hint: string };

export const DRIVE_SLIDERS: readonly SliderSpec[] = [
  { key: "energy", label: "SHAPE", hint: "body-wave displacement" },
  { key: "heat", label: "HEAT", hint: "ember core + lime eyes" },
  { key: "mood", label: "MOOD", hint: "grin + liveliness" },
];

export function applyDrive(api: MoshiApiLike, key: DriveKey, v: number): void {
  api.set(key, v);
}

// MORPH: a non-snap call so dragging produces a real cross-family palette/displacement
// crossfade rather than a hard cut.
export function applyMorph(api: MoshiApiLike, dial: number): void {
  api.setPersonality(dial);
}

// SEED: re-resolve the limb anatomy within the family the MORPH dial currently selects,
// so rerolling the shape never silently changes the material/colour.
export function applySeed(api: MoshiApiLike, dial: number, seed: number): void {
  api.setPersonality(familyNameAt(dial), seed);
}

// ── discrete controls ───────────────────────────────────────────────────────
export type ToggleKey = "style" | "quality" | "anatomy";
export type ToggleSpec = {
  key: ToggleKey;
  label: string;
  options: () => readonly string[];
  apply: (api: MoshiApiLike, value: string) => void;
};

export const TOGGLES: readonly ToggleSpec[] = [
  { key: "style", label: "STYLE", options: styleOptions, apply: (api, v) => void api.setStyle(v) },
  { key: "quality", label: "QUALITY", options: qualityOptions, apply: (api, v) => void api.setQuality(v) },
  { key: "anatomy", label: "ANATOMY", options: anatomyOptions, apply: (api, v) => void api.setAnatomy(v) },
];
