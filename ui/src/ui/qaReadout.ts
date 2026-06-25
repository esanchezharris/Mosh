// Pure view-model for the generative drawer's judge-panel quality readout (AL-006).
//
// Keeps the formatting logic out of the React component so it can be unit-tested without
// rendering: the component (Dock.tsx → GenBody) just maps this struct to markup. The
// readout surfaces the bare pq / pq_base numbers AND the Audiobox judge's human-readable
// `reasoning`, plus the hygiene flags (quality_degraded rendered as a warning).
export type { RenderQA } from "../types";
import type { RenderQA } from "../types";

export type QAFlag = { label: string; warn: boolean };
export type QAReadoutView = {
  pqText: string;
  reasoning: string | null;
  flags: QAFlag[];
};

/** Build the readout view, or null when there's no production-quality score to show. */
export function qaReadoutView(qa: RenderQA | undefined | null): QAReadoutView | null {
  if (!qa || qa.pq == null) return null;
  const pqText =
    qa.pq_base != null ? `pq ${qa.pq} / ${qa.pq_base}` : `pq ${qa.pq}`;
  const reasoning =
    typeof qa.reasoning === "string" && qa.reasoning.trim().length > 0
      ? qa.reasoning
      : null;
  const flags: QAFlag[] = (qa.flags ?? []).map((f) => ({
    label: f,
    warn: f === "quality_degraded",
  }));
  return { pqText, reasoning, flags };
}
