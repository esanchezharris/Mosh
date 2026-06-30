// ── Sound palette (the vector sample DB, consumer side) ───────────────────────
// Pure, fs-free view over the palette manifest built by service/palette/build_palette.py
// (vectors.npy + manifest.json). The beat builder uses it to put REAL sounds on every
// track — a real kit (assign_sample) + a real, pitched 808 (assign_sample mode:"melodic").
//
// Two access shapes, both DETERMINISTIC (seeded) so a build is reproducible:
//   • pick(role, seed)            — one sensible real default for a role (completeness).
//   • candidates(role, n, seed)   — a small diverse set to offer a model to CHOOSE from
//                                    (the taste signal; the harness fills any gap via pick).
// "Which sound is best" is NEVER decided here — that is learned later from owner A/B picks
// over the same vectors (#56). This module only supplies real, role-correct options.

export type PaletteItem = {
  path: string; // 44.1k/PCM_16 asset — safe to assign_sample headlessly
  role: string; // kick | snare | hat | clap | 808 | perc | melodic | other
  rootNote: number | null; // melodic/808: the sample's root MIDI note for repitch
  char: string[]; // light descriptive tags (for later preference features, never scored)
  src?: string; // original library path (provenance)
};

type RawItem = {
  path?: string; role_guess?: string; root_note?: number | null;
  char?: string[]; src?: string; kind?: string;
};
export type PaletteManifest = { items?: RawItem[] };

export interface BeatPalette {
  has(role: string): boolean;
  size(role: string): number;
  pick(role: string, seed?: number): PaletteItem | null;
  candidates(role: string, n: number, seed?: number): PaletteItem[];
}

// FNV-1a — a tiny deterministic string hash so seeded picks are stable across runs/machines.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function makePalette(manifest: PaletteManifest): BeatPalette {
  const byRole = new Map<string, PaletteItem[]>();
  for (const it of manifest.items ?? []) {
    if (!it.path || !it.role_guess) continue;
    const item: PaletteItem = {
      path: it.path, role: it.role_guess, rootNote: it.root_note ?? null,
      char: Array.isArray(it.char) ? it.char : [], src: it.src,
    };
    (byRole.get(item.role) ?? byRole.set(item.role, []).get(item.role)!).push(item);
  }
  // stable order (by path) so seeded indexing is deterministic regardless of manifest order
  for (const arr of byRole.values()) arr.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const list = (role: string) => byRole.get(role) ?? [];
  return {
    has: (role) => list(role).length > 0,
    size: (role) => list(role).length,
    pick(role, seed = 0) {
      const a = list(role);
      if (!a.length) return null;
      return a[hash(`${role}:${seed}`) % a.length];
    },
    candidates(role, n, seed = 0) {
      const a = list(role);
      if (!a.length) return [];
      const k = Math.min(n, a.length);
      const start = hash(`${role}:${seed}:c`) % a.length;
      // even stride across the (timbre-sorted-by-path) list → a spread, not N near-dups
      const stride = Math.max(1, Math.floor(a.length / k));
      const out: PaletteItem[] = [];
      const seen = new Set<number>();
      for (let i = 0; i < k; i++) {
        const idx = (start + i * stride) % a.length;
        if (seen.has(idx)) continue;
        seen.add(idx);
        out.push(a[idx]);
      }
      return out;
    },
  };
}
