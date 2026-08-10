// Pure velocity-tool logic for the mock's transform_velocities case — the TS
// mirror of MoshOps::cmdTransformVelocities (Live 12's velocity tool row:
// Randomize ±amount / Ramp lo→hi in time order / Deviation ±offset, all clamped
// 1–127). Randomness is deterministic-seeded from the canonical args + the
// target notes' current state, so a replayed command reproduces itself — the
// same contract the engine earns with its FNV-1a → mt19937_64 seed. The mock and
// the engine are separate environments, so byte-identical STREAMS are not
// required — replay determinism within each is.

export type VelocityMode = "randomize" | "ramp" | "deviate";
export type VelocityTarget = { start: number; pitch: number; velocity: number };

export function clampVelocity(v: number): number {
  return Math.max(1, Math.min(127, Math.round(v)));
}

/** FNV-1a 64-bit over the same canonical payload the engine seeds from. */
export function velocitySeed(
  mode: string,
  clipId: string,
  amount: number,
  lo: number,
  hi: number,
  targets: readonly VelocityTarget[],
): bigint {
  let h = 1469598103934665603n;
  const M = (1n << 64n) - 1n;
  const mix = (v: bigint) => { h ^= v & M; h = (h * 1099511628211n) & M; };
  for (const c of `${mode}|${clipId}`) mix(BigInt(c.codePointAt(0)!));
  mix(BigInt(amount)); mix(BigInt(lo)); mix(BigInt(hi));
  for (const n of targets) {
    mix(BigInt(n.pitch));
    mix(BigInt(n.velocity));
    mix(BigInt(Math.round(n.start * 1e6)));
  }
  return h;
}

/** A tiny deterministic PRNG (splitmix64) so the mock needs no external dep. */
export function splitmix64(seed: bigint): () => number {
  let s = seed & ((1n << 64n) - 1n);
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & ((1n << 64n) - 1n);
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & ((1n << 64n) - 1n);
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & ((1n << 64n) - 1n);
    z ^= z >> 31n;
    return Number(z >> 11n) / 2 ** 53; // [0, 1)
  };
}

/** The new velocity for every target, in the same order as `targets`. */
export function transformVelocities(
  targets: readonly VelocityTarget[],
  mode: VelocityMode,
  opts: { amount?: number; lo?: number; hi?: number; clipId?: string },
): number[] {
  const amount = Math.max(0, Math.min(127, Math.round(opts.amount ?? 0)));
  const lo = clampVelocity(opts.lo ?? 1);
  const hi = clampVelocity(opts.hi ?? 127);
  if (mode === "ramp") {
    const sorted = targets
      .map((n, i) => ({ n, i }))
      .sort((a, b) => (a.n.start - b.n.start) || (a.n.pitch - b.n.pitch));
    const out = new Array<number>(targets.length);
    const n = sorted.length;
    sorted.forEach(({ i }, k) => {
      const t = n > 1 ? k / (n - 1) : 0;
      out[i] = clampVelocity(Math.round(lo + (hi - lo) * t));
    });
    return out;
  }
  const rand = splitmix64(velocitySeed(mode, opts.clipId ?? "", amount, lo, hi, targets));
  return targets.map((t) => {
    const offset = Math.round((rand() * 2 - 1) * amount);   // uniform [-amount, +amount]
    return clampVelocity(t.velocity + offset);
  });
}
