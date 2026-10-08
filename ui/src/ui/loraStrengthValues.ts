// LoRA strength rules shared by every surface that applies a LoRA (see LoraStrength.tsx).

/** Where a newly added LoRA starts. */
export const LORA_ADD_VALUE = 70;
/** The notch: full strength, what the adapter was trained to do. */
export const LORA_IDEAL_VALUE = 100;
export const LORA_SLIDER_MAX = 200;

/** The slider's position for a value: values beyond 0..200 pin to the nearest edge. */
export function sliderPosition(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(LORA_SLIDER_MAX, Math.max(0, value));
}

/** A typed value, or null when it is not a number (the edit is then dropped). */
export function parseStrength(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** As shown: whole numbers plainly, anything else to at most two places. */
export function formatStrength(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}
