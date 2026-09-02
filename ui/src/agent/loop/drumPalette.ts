// W2.3 — deterministic pickers over the sound sources (palette-v2 one-shots +
// the curated Vital preset index) so the produce-lane PREFLIGHT (produceTemplate.ts)
// never asks the model to choose a file path. Two sources feed `pickDrumPalette`
// with the SAME item shape: the native `list_palette` manifest
// (~/Library/Mosh/palette-v2/manifest.json) and the lab manifest
// (~/Library/Mosh/lab-manifests/15drtt-jerk-r0.json, written by
// scripts/lab/make-lab-manifest.py) — this module doesn't care which.
//
// Design decision (plan W2.3): ONE drum track, 10 FIXED pads — one undo unit,
// one shared sampler so hat/openhat choke correctly, one add_midi_clip for the
// whole drum part (same shape as the reference beat's single Drum Rack).
//
// Everything here is a PURE function of its inputs plus an explicit seed — no
// Math.random, no Date.now — so the same palette + seed always produces the
// same picks (produceLiveRun.mts's --seed and the loop test both depend on this).

import type { SessionKey } from "../../types";

/** Item shape shared by both the native manifest and the lab manifest. `rootNote`
 *  is present only on measured items (today: role "bass" — 808 one-shots). */
export type PaletteItem = { readonly path: string; readonly role: string; readonly rootNote?: number };

/** One instrument preset, the shape `list_presets` returns per entry. */
export type PresetItem = { readonly plugin: string; readonly name: string; readonly file: string; readonly source?: string };
export type PresetMenu = readonly PresetItem[];

export type DrumPadPick = {
  readonly note: number;
  readonly name: string;
  readonly file: string;
  readonly gainDb?: number;
  readonly chokeGroup?: number;
};

export type BassPick = { readonly file: string; readonly rootNote: number; readonly keyNote: number };

export type DrumPalettePick = {
  readonly pads: readonly DrumPadPick[];
  readonly bass: BassPick;
};

/** The 10-pad lane map (plan W2.3, verbatim):
 *  36 kick · 38 snare · 37 snare2 · 39 clap · 40 clap2 (−6 dB) · 42 hat ·
 *  46 openhat (choke 1 with hat) · 41 perc · 43 fx · 44 roll.
 *  `role` is the palette-v2 role this lane prefers to draw from; "roll" has no
 *  dedicated role in palette-v2 (kick, snare, clap, hat, openhat, perc, fx, bass)
 *  so it is filled from whichever role has a spare item after every other lane
 *  is satisfied (see pickDrumPalette). */
export type DrumLane = {
  readonly id: string;
  readonly note: number;
  readonly role: string;
  readonly label: string;
  readonly gainDb?: number;
  readonly chokeGroup?: number;
};

export const DEFAULT_DRUM_LANES: readonly DrumLane[] = [
  { id: "kick", note: 36, role: "kick", label: "Kick" },
  { id: "snare", note: 38, role: "snare", label: "Snare" },
  { id: "snare2", note: 37, role: "snare", label: "Snare 2" },
  { id: "clap", note: 39, role: "clap", label: "Clap" },
  { id: "clap2", note: 40, role: "clap", label: "Clap 2", gainDb: -6 },
  { id: "hat", note: 42, role: "hat", label: "Hat", chokeGroup: 1 },
  { id: "openhat", note: 46, role: "openhat", label: "Open Hat", chokeGroup: 1 },
  { id: "perc", note: 41, role: "perc", label: "Perc" },
  { id: "fx", note: 43, role: "fx", label: "FX" },
  { id: "roll", note: 44, role: "roll", label: "Roll" },
];

// ── deterministic RNG — FNV-1a over the sorted item paths gives a seed that is
// stable regardless of manifest/scan ORDER, then mulberry32 walks it forward so
// picks within a role vary across the sequence instead of always taking index 0.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseSeed(items: readonly PaletteItem[], seed?: number): number {
  const paths = items.map((i) => i.path).slice().sort();
  return (fnv1a(paths.join("|")) ^ (seed ?? 0)) >>> 0;
}

/** Deterministically pick ONE item from `pool`, advancing `rng`. */
function pickOne<T>(pool: readonly T[], rng: () => number): T {
  const idx = Math.floor(rng() * pool.length) % pool.length;
  return pool[idx]!;
}

export type PickDrumPaletteOptions = {
  /** Reserved for future scale-aware picking; drum one-shots and the 808 root
   *  don't currently need the session key (see the module header). */
  readonly key?: SessionKey;
  readonly seed?: number;
  readonly lanes?: readonly DrumLane[];
};

/** Pick the 10 drum pads + the sustained 808/bass from a flat palette-v2 (or lab
 *  manifest) item list. Deterministic: same items + seed ⇒ same picks. Throws when
 *  the palette can't cover the requirement (no bass item, or every lane empty) —
 *  produceTemplate.ts surfaces that as a preflight failure rather than silently
 *  degrading to a placeholder kit. */
export function pickDrumPalette(items: readonly PaletteItem[], opts: PickDrumPaletteOptions = {}): DrumPalettePick {
  const lanes = opts.lanes ?? DEFAULT_DRUM_LANES;
  const rng = mulberry32(baseSeed(items, opts.seed));

  const bassCandidates = items.filter((i) => i.role === "bass" && typeof i.rootNote === "number");
  if (bassCandidates.length === 0)
    throw new Error("pickDrumPalette: no palette item with role \"bass\" and a measured rootNote");
  const bassSorted = bassCandidates
    .slice()
    .sort((a, b) => Math.abs((a.rootNote! + 36) - 60) - Math.abs((b.rootNote! + 36) - 60) || a.path.localeCompare(b.path));
  const bassItem = bassSorted[0]!;

  // Pool per role, sorted for determinism; `used` tracks paths already claimed so
  // no two lanes (or the "roll" fallback) ever draw the same file.
  const byRole = new Map<string, PaletteItem[]>();
  for (const item of items) {
    if (item.role === "bass") continue; // never doubles as a drum one-shot
    const bucket = byRole.get(item.role) ?? [];
    bucket.push(item);
    byRole.set(item.role, bucket);
  }
  for (const bucket of byRole.values()) bucket.sort((a, b) => a.path.localeCompare(b.path));

  const used = new Set<string>();
  const takeFromRole = (role: string): PaletteItem | undefined => {
    const bucket = (byRole.get(role) ?? []).filter((i) => !used.has(i.path));
    if (bucket.length === 0) return undefined;
    const picked = pickOne(bucket, rng);
    used.add(picked.path);
    return picked;
  };
  // Any unused item in ANY drum-eligible role — the "roll" lane's fallback (there
  // is no dedicated "roll" role in palette-v2 today).
  const takeAnyLeftover = (): PaletteItem | undefined => {
    const leftover = [...byRole.values()].flat().filter((i) => !used.has(i.path)).sort((a, b) => a.path.localeCompare(b.path));
    if (leftover.length === 0) return undefined;
    const picked = pickOne(leftover, rng);
    used.add(picked.path);
    return picked;
  };

  const pads: DrumPadPick[] = [];
  for (const lane of lanes) {
    const picked = takeFromRole(lane.role) ?? takeAnyLeftover();
    if (!picked) continue; // a genuinely empty palette lane — produceTemplate reports missing pads
    pads.push({
      note: lane.note,
      name: lane.label,
      file: picked.path,
      ...(lane.gainDb !== undefined ? { gainDb: lane.gainDb } : {}),
      ...(lane.chokeGroup !== undefined ? { chokeGroup: lane.chokeGroup } : {}),
    });
  }
  if (pads.length === 0) throw new Error("pickDrumPalette: no drum one-shots found in the palette");

  return {
    pads,
    bass: { file: bassItem.path, rootNote: bassItem.rootNote!, keyNote: bassItem.rootNote! + 36 },
  };
}

// ── synth preset picking ────────────────────────────────────────────────────

export type SynthRole = "lead" | "chords_pad" | "drone" | "counter" | "arp" | "ambient" | "stab";

export type SynthPresetPick = { readonly role: SynthRole; readonly file: string; readonly name: string };

/** Preference order per synth role — the curated Vital index (W2.4) names files
 *  `<presetRole>-<slug>.vital` with presetRole one of lead, pluck, pad, keys,
 *  bass, bell, arp, atmos, fx. First preference that still has an unused preset
 *  wins; "no repeats" means a file claimed by an earlier role never reappears. */
const SYNTH_ROLE_PREFERENCE: Record<SynthRole, readonly string[]> = {
  lead: ["lead"],
  chords_pad: ["pad"],
  drone: ["pad", "atmos"],
  counter: ["pluck", "keys"],
  arp: ["arp", "pluck"],
  ambient: ["atmos", "pad"],
  stab: ["keys", "bell", "pluck"],
};

/** The fixed order the 7 synth roles are assigned in — earlier roles get first
 *  pick of a contested presetRole bucket (e.g. "pad" is shared by chords_pad,
 *  drone and ambient). */
const SYNTH_ROLE_ORDER: readonly SynthRole[] = ["lead", "chords_pad", "drone", "counter", "arp", "ambient", "stab"];

function presetRoleOf(file: string): string {
  const base = (file.split("/").pop() ?? file).replace(/\.[^./]+$/, "");
  return base.split("-")[0]?.toLowerCase() ?? "";
}

/** Pick one non-repeating Vital preset per synth role from the curated menu.
 *  Deterministic given the same menu + seed. A role with no reachable preset
 *  (its whole preference chain, and the role-agnostic fallback, are exhausted)
 *  is simply absent from the result — produceTemplate.ts records a
 *  `presetError` for that track instead of failing the whole preflight. */
export function pickSynthPresets(menu: PresetMenu, seed = 0): readonly SynthPresetPick[] {
  const vital = menu.filter((p) => p.plugin === "vital");
  const rng = mulberry32(fnv1a(vital.map((p) => p.file).slice().sort().join("|")) ^ (seed >>> 0));

  const byPresetRole = new Map<string, PresetItem[]>();
  for (const p of vital) {
    const role = presetRoleOf(p.file);
    const bucket = byPresetRole.get(role) ?? [];
    bucket.push(p);
    byPresetRole.set(role, bucket);
  }
  for (const bucket of byPresetRole.values()) bucket.sort((a, b) => a.file.localeCompare(b.file));

  const used = new Set<string>();
  const takeFromPresetRole = (role: string): PresetItem | undefined => {
    const bucket = (byPresetRole.get(role) ?? []).filter((p) => !used.has(p.file));
    if (bucket.length === 0) return undefined;
    const picked = pickOne(bucket, rng);
    used.add(picked.file);
    return picked;
  };
  const takeAnyLeftover = (): PresetItem | undefined => {
    const leftover = vital.filter((p) => !used.has(p.file)).sort((a, b) => a.file.localeCompare(b.file));
    if (leftover.length === 0) return undefined;
    const picked = pickOne(leftover, rng);
    used.add(picked.file);
    return picked;
  };

  const picks: SynthPresetPick[] = [];
  for (const role of SYNTH_ROLE_ORDER) {
    let found: PresetItem | undefined;
    for (const presetRole of SYNTH_ROLE_PREFERENCE[role]) {
      found = takeFromPresetRole(presetRole);
      if (found) break;
    }
    found = found ?? takeAnyLeftover(); // role-short fallback: any unused preset beats a bare 4OSC default
    if (found) picks.push({ role, file: found.file, name: found.name });
  }
  return picks;
}
