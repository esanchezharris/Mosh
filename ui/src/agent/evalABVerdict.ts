// Pure verdict logic for the efficacy-A/B injection-redesign sweep — no LLM, no IO, so it
// unit-tests offline. scripts/evalAB.mts feeds it the TARGETED pass-rates per arm plus the
// golden no-regression flag; it returns the pre-registered bucket. The bar is fixed BEFORE
// the run (no p-hacking): a real LIFT must clear +10pp over baseline AND beat the intent@k3
// control (the config that measured the −30% harm); a golden regression FAILs the whole run.
export type Bucket = "LIFT" | "HARM-REMOVED-NO-LIFT" | "NO-CHANGE" | "REGRESSION" | "FAIL";

export type VerdictInput = {
  concreteK1: number; // targeted pass-rate — concrete worked-example @ top-1 (the decision arm)
  intentK3: number; // targeted pass-rate — intent-only @ top-3 (the control that measured −30%)
  baseline: number; // targeted pass-rate — no cards
  goldenOk: boolean; // did golden no-regression hold (no card-induced drop) in every shipped arm?
};

export const LIFT_THRESHOLD = 0.1; // a real lift clears +10pp over baseline
export const NOISE_FLOOR = 0.05; // ~binomial noise at the decision rep count

export function verdictBucket(v: VerdictInput, opts: { lift?: number; noise?: number } = {}): Bucket {
  const lift = opts.lift ?? LIFT_THRESHOLD;
  const noise = opts.noise ?? NOISE_FLOOR;
  // A golden regression fails the run regardless of any targeted gain — over-eager firing on
  // card-irrelevant asks is the real risk, and it must not be bought with a targeted win.
  if (!v.goldenOk) return "FAIL";
  if (v.concreteK1 - v.baseline >= lift && v.concreteK1 >= v.intentK3) return "LIFT";
  if (v.concreteK1 < v.baseline - noise) return "REGRESSION";
  // Back to (or above) baseline and clearly above the intent@k3 control → the harm is gone,
  // but no genuine lift over not-injecting-cards-at-all.
  if (v.concreteK1 > v.intentK3 + noise) return "HARM-REMOVED-NO-LIFT";
  return "NO-CHANGE";
}

/** Golden no-regression for the SHIPPED concrete@top-1 arm vs the no-cards baseline.
 *  Returns null (NOT a silent pass) when a golden arm wasn't run — so a targeted-only run
 *  can't masquerade as a regression-checked, shippable verdict. */
export function goldenOk(none: number | null, concrete: number | null, noise = NOISE_FLOOR): boolean | null {
  if (none == null || concrete == null) return null;
  return concrete >= none - noise;
}
