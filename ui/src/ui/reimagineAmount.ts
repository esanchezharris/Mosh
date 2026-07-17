// Maps the re-imagine "keep ↔ re-imagine" dial (0–100 UI) to SA3's init_noise_level (nl).
// nl is a UNIDIRECTIONAL keep→reimagine ramp (not colours' centered ±ceil). The float is the
// source of truth (it lives in the render param + cache fingerprint); this only converts for
// display/write so the user never sees a raw 0.4. Constants mirror the authoritative Python guard
// in service/adapters/stable_audio3_adapter.py (NL_MIN / NL_MAX_RECOGNIZABLE) — keep them in
// lockstep. Normal caps at NL_MAX (recognizability guard); the Lab slider spans up to NL_GENERATE
// (1.0 = full re-imagine = generate). The Lab guard is uncapped service-side, so a raw nl > 1.0
// simply shows as 100 here.
export const NL_MIN = 0.01;      // < this is a near-identity no-op (the adapter rejects it)
export const NL_MAX = 0.5;       // normal-mode recognizability ceiling
export const NL_GENERATE = 1.0;  // Lab slider top: nl=1.0 == generate-from-scratch (source fully gone)

const ceilFor = (lab: boolean): number => (lab ? NL_GENERATE : NL_MAX);

/** 0–100 dial → nl float. 0 → NL_MIN (minimal change), 100 → ceil (0.5 normal / 1.0 Lab). */
export function amountToNl(amount: number, lab: boolean): number {
  const a = Math.max(0, Math.min(100, amount)) / 100;
  const ceil = ceilFor(lab);
  return NL_MIN + a * (ceil - NL_MIN);
}

/** nl float → 0–100 dial position (rounded int, display-clamped to [0,100]). */
export function nlToAmount(nl: number, lab: boolean): number {
  const ceil = ceilFor(lab);
  const frac = (nl - NL_MIN) / (ceil - NL_MIN);
  return Math.round(Math.max(0, Math.min(1, frac)) * 100);
}
