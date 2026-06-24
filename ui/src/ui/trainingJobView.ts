// Pure TrainingJob → render-ready view model for the LoRA popover Jobs list
// (TopbarTools › TrainingTool). Same split as meterGeom.ts / takeLanes.ts: the
// component stays a thin paint over this testable derivation.
//
// The trainer drives a job queued → running → ready, or terminates in
// error / cancelled, reporting a 0..1 `progress` fraction and (on failure) an
// `error` string (service/server.py:280-318). Before AL-003 the popover showed
// only `jobId · status`; this surfaces the progress bar + the failure reason.

import type { TrainingJob } from "../types";

export type TrainingJobPhase = "queued" | "running" | "ready" | "error" | "cancelled";

export type TrainingJobView = {
  phase: TrainingJobPhase;
  progressPct: number; // 0..100, integer
  showProgress: boolean; // true while in-flight (queued/running)
  canImport: boolean; // ready only — gates the Import button
  errorText: string | null; // failure reason, error phase only
  label: string; // human status word for the row
};

// Map the raw backend status string to a known phase. Unknown / empty statuses
// read as "queued" (a job we know about but can't classify is still pending).
function toPhase(status: string): TrainingJobPhase {
  const s = String(status ?? "").trim().toLowerCase();
  switch (s) {
    case "running":
      return "running";
    case "ready":
    case "complete":
    case "completed":
    case "succeeded":
    case "success":
      return "ready";
    case "error":
    case "failed":
      return "error";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "queued":
    default:
      return "queued";
  }
}

// 0..1 fraction → clamped integer percentage. Non-finite reads as the nearest
// bound (NaN/-Inf → 0, +Inf → 100).
function toPct(progress: number | undefined): number {
  const p = Number(progress);
  if (Number.isNaN(p)) return 0;
  return Math.round(Math.max(0, Math.min(1, p)) * 100);
}

export function deriveTrainingJob(job: TrainingJob): TrainingJobView {
  const phase = toPhase(job.status);
  // A ready job is fully complete by definition, even if the last reported
  // progress fraction lagged behind the final step.
  const progressPct = phase === "ready" ? 100 : toPct(job.progress);
  const showProgress = phase === "queued" || phase === "running";
  const canImport = phase === "ready";
  const errorText = phase === "error" ? (job.error?.trim() || "training failed") : null;

  let label: string;
  switch (phase) {
    case "running":
      label = `training ${progressPct}%`;
      break;
    case "error":
      label = "failed";
      break;
    default:
      label = phase; // "queued" | "ready" | "cancelled"
      break;
  }

  return { phase, progressPct, showProgress, canImport, errorText, label };
}
