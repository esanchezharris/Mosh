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
 *  is present only on measured items (today: role "bass" — 808 one-shots).
 *  `subEnergyDb` (round 2, correction note 6) is a 30-120 Hz band RMS in dBFS,
 *  written by the manifest generators onto "bass" items only — optional: a
 *  manifest without it (or a native list_palette response that hasn't been
 *  taught to forward it yet) degrades to the pre-round-2 nearest-root pick. */
export type PaletteItem = { readonly path: string; readonly role: string; readonly rootNote?: number; readonly subEnergyDb?: number };

/** One instrument preset, the shape `list_presets` returns per entry. */
export type PresetItem = { readonly plugin: string; readonly name: string; readonly file: string; readonly source?: string };
export type PresetMenu = readonly PresetItem[];

export type DrumPadPick = {
  readonly note: number;
  readonly name: string;
  readonly file: string;
  readonly gainDb?: number;
  readonly chokeGroup?: number;
  /** Round 3 (R3.2) — set only when this pad's file came from a `kitMatch`
   *  lane mapping (the nearest-neighbour cosine similarity to the owner's kit
   *  sample the lab-manifest generator measured), not the plain seeded pick. */
  readonly matchCosine?: number;
};

/** One lane entry of a `~/Library/Mosh/lab-manifests/kitmatch-*.json` file
 *  (written by `service/presets/match_kit.py`, plan R3.2) — the owner's kit
 *  sample for this lane and its nearest palette-v2 neighbour. `alternates` is
 *  passed through untouched; pickDrumPalette never reads it. */
export type KitMatchLane = {
  readonly ownerFile: string;
  readonly role: string;
  readonly paletteFile: string;
  readonly cosine: number;
  readonly alternates?: readonly unknown[];
};

/** The parsed kitmatch manifest — keyed by DrumLane id (kick, snare, snare2,
 *  clap, clap2, hat, openhat, perc, fx, roll), matching DEFAULT_DRUM_LANES's
 *  ids 1:1. No entry for "bass"/"808" — that pick keeps the sub-energy rule
 *  (round 2 note 6) unconditionally; kit-matching only ever touches the 10
 *  drum pad lanes. */
export type KitMatchFile = {
  readonly lanes: Readonly<Record<string, KitMatchLane>>;
  readonly [key: string]: unknown;
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

// Round 2 correction note 6 ("808 / low end weak or wrong; drums groove / feel"):
// kick -2dB (was fighting the 808 for headroom), both hats -6dB (they were
// washing out the groove), clap2 -6 -> -8dB (a layer tag should sit UNDER the
// main clap it doubles, not beside it).
export const DEFAULT_DRUM_LANES: readonly DrumLane[] = [
  { id: "kick", note: 36, role: "kick", label: "Kick", gainDb: -2 },
  { id: "snare", note: 38, role: "snare", label: "Snare" },
  { id: "snare2", note: 37, role: "snare", label: "Snare 2" },
  { id: "clap", note: 39, role: "clap", label: "Clap" },
  { id: "clap2", note: 40, role: "clap", label: "Clap 2", gainDb: -8 },
  { id: "hat", note: 42, role: "hat", label: "Hat", gainDb: -6, chokeGroup: 1 },
  { id: "openhat", note: 46, role: "openhat", label: "Open Hat", gainDb: -6, chokeGroup: 1 },
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
  /** Round 3 (R3.2) — a parsed kitmatch manifest. When a lane has an entry
   *  AND that entry's `paletteFile` is present among `items`, that exact file
   *  wins the lane (carrying `matchCosine`) instead of the seeded pick; a
   *  missing lane entry, or a `paletteFile` that isn't in `items` (the
   *  manifest can point at a palette snapshot older than what's on disk now),
   *  falls back to the ordinary seeded pick for that lane, unchanged. */
  readonly kitMatch?: KitMatchFile;
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
  // Round 2 correction note 6 ("808 / low end weak or wrong"): when the
  // manifest carries a measured sub-band level, the loudest 30-120 Hz item
  // wins outright — a thin-sounding 808 was a level/selection problem, not a
  // tuning one (every candidate is already re-pitched to keyNote via the
  // rootNote+36 math below, so raw measured level is directly comparable).
  // A manifest with no subEnergyDb on ANY bass candidate (the pre-round-2
  // shape, and every existing fixture) falls back to the original
  // nearest-to-60 rule unchanged.
  const withEnergy = bassCandidates.filter((i) => typeof i.subEnergyDb === "number");
  const bassSorted = withEnergy.length > 0
    ? withEnergy.slice().sort((a, b) => (b.subEnergyDb! - a.subEnergyDb!) || a.path.localeCompare(b.path))
    : bassCandidates
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

  // Round 3 (R3.2) — path -> item lookup for kitMatch's exact-file wins,
  // scoped to the same non-bass pool takeFromRole/takeAnyLeftover draw from.
  const byPath = new Map<string, PaletteItem>();
  for (const item of items) if (item.role !== "bass") byPath.set(item.path, item);

  const pads: DrumPadPick[] = [];
  for (const lane of lanes) {
    const kitEntry = opts.kitMatch?.lanes[lane.id];
    let picked: PaletteItem | undefined;
    let matchCosine: number | undefined;
    if (kitEntry && !used.has(kitEntry.paletteFile) && byPath.has(kitEntry.paletteFile)) {
      picked = byPath.get(kitEntry.paletteFile);
      used.add(kitEntry.paletteFile);
      matchCosine = kitEntry.cosine;
    } else {
      picked = takeFromRole(lane.role) ?? takeAnyLeftover();
    }
    if (!picked) continue; // a genuinely empty palette lane — produceTemplate reports missing pads
    pads.push({
      note: lane.note,
      name: lane.label,
      file: picked.path,
      ...(lane.gainDb !== undefined ? { gainDb: lane.gainDb } : {}),
      ...(lane.chokeGroup !== undefined ? { chokeGroup: lane.chokeGroup } : {}),
      ...(matchCosine !== undefined ? { matchCosine } : {}),
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

// Round 2 correction note 2 ("there's a synth part that's exactly the same
// through all runs" / "no variation in the synth sounds"): the constant-seed
// bug is the root cause (fixed at the driver — produceLiveRun.mts's --seed),
// but a SQ/ARP/SEQ-tagged patch has its OWN internal motion regardless of what
// notes it's given ("arp-lucy-blake-dpo-broken-wings-sq-1" sounded identical
// across runs even though its note data differed) — belt-and-braces alongside
// the curate_vital.py source-side curation: prefer a filename that does NOT
// look self-sequencing for every role except "arp", which WANTS that motion.
// A soft preference, not a hard exclusion — a role whose only candidates are
// all SQ/ARP/SEQ-tagged still gets one rather than going silent.
const SQ_SEQ_ARP_RE = /sq|seq|arp/i;
function preferNonSequencing(pool: readonly PresetItem[], role: SynthRole): readonly PresetItem[] {
  if (role === "arp") return pool;
  const safe = pool.filter((p) => !SQ_SEQ_ARP_RE.test(p.file));
  return safe.length > 0 ? safe : pool;
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
  const takeFromPresetRole = (presetRole: string, role: SynthRole): PresetItem | undefined => {
    const bucket = preferNonSequencing((byPresetRole.get(presetRole) ?? []).filter((p) => !used.has(p.file)), role);
    if (bucket.length === 0) return undefined;
    const picked = pickOne(bucket, rng);
    used.add(picked.file);
    return picked;
  };
  const takeAnyLeftover = (role: SynthRole): PresetItem | undefined => {
    const leftover = preferNonSequencing(vital.filter((p) => !used.has(p.file)).sort((a, b) => a.file.localeCompare(b.file)), role);
    if (leftover.length === 0) return undefined;
    const picked = pickOne(leftover, rng);
    used.add(picked.file);
    return picked;
  };

  const picks: SynthPresetPick[] = [];
  for (const role of SYNTH_ROLE_ORDER) {
    let found: PresetItem | undefined;
    for (const presetRole of SYNTH_ROLE_PREFERENCE[role]) {
      found = takeFromPresetRole(presetRole, role);
      if (found) break;
    }
    found = found ?? takeAnyLeftover(role); // role-short fallback: any unused preset beats a bare 4OSC default
    if (found) picks.push({ role, file: found.file, name: found.name });
  }
  return picks;
}
