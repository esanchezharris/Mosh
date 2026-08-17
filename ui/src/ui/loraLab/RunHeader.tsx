// The run's state, in the unit a producer thinks in.
//
// EPOCHS is the headline number, not steps. Steps are an implementation detail
// of batch size and accumulation — change either and the same training becomes a
// different step count — whereas epochs answer "how many times has it seen my
// music", which is the question, and the one whose right answer moved 145 -> 44
// -> 11 across three real corpora. Steps stay available one disclosure away for
// anyone reconciling against the trainer's own log.
//
// The loss curve is not here at all. It is in Diagnostics, because it is the
// number that misled the entire training round: it descended smoothly across a
// run whose output quality was, by ear, going sideways.

import { useStore } from "../../store";
import { epochsFor, formatDuration } from "./recipe";

export function RunHeader({ clipCount }: { clipCount: number }) {
  const run = useStore((s) => s.labRun);
  const recipe = useStore((s) => s.capabilities?.trainingRecipe);

  if (!run) return null;

  const batch = recipe?.batchSize ?? 2;
  const accum = recipe?.gradAccum ?? 2;
  const epochsDone = clipCount > 0 ? epochsFor(clipCount, run.step, batch, accum) : 0;
  const epochsTotal = clipCount > 0 ? epochsFor(clipCount, run.totalSteps, batch, accum) : 0;
  const frac = run.totalSteps > 0 ? Math.min(1, run.step / run.totalSteps) : 0;

  const pill =
    run.status === "training" ? "training"
    : run.status === "precompute" ? "preparing"
    : run.status === "ready" ? "done"
    : run.status === "cancelled" ? "stopped"
    : run.status === "error" ? "failed" : run.status;

  return (
    <div className="lab-run" data-testid="lab-run">
      <div className="lab-run-top">
        <div className="lab-epochs">
          <span className="lab-epochs-n display" data-testid="lab-epochs">
            {epochsTotal > 0 ? epochsDone.toFixed(epochsDone < 10 ? 1 : 0) : "—"}
          </span>
          <span className="lab-epochs-of">
            {epochsTotal > 0 ? `of ${epochsTotal.toFixed(0)} epochs` : "epochs"}
          </span>
        </div>
        <span className={`gen-badge st-${run.status === "error" ? "error" : run.status === "ready" ? "ready" : "working"}`}
          data-testid="lab-run-status">{pill}</span>
        {run.etaSeconds != null && run.status === "training" && (
          <span className="lab-eta" data-testid="lab-eta">{formatDuration(run.etaSeconds)} left</span>
        )}
      </div>

      <div className="gen-prog lab-prog" role="progressbar"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}
        aria-label="Training progress">
        <span style={{ width: `${frac * 100}%` }} />
      </div>

      {/* One disclosure down: the numbers you need only when reconciling against
          the trainer's own log, or explaining an unexpected duration. `leg` is
          pmetal's auto-chunking — it splits itself into <=600-step child
          processes to stay under a real macOS Metal resource ceiling, and a
          producer watching the process list deserves to know why there are
          several. */}
      <details className="lab-detail">
        <summary>Run detail</summary>
        <div className="lab-detail-grid" data-testid="lab-run-detail">
          <span>step</span><span>{run.step} / {run.totalSteps}</span>
          <span>batch</span><span>{batch} × {accum} accum (effective {batch * accum})</span>
          {run.sPerStep != null && (<><span>pace</span><span>{run.sPerStep.toFixed(2)} s/step</span></>)}
          {run.legs != null && (<><span>leg</span><span>{run.leg ?? 1} of {run.legs} (auto-chunked)</span></>)}
          {run.error && (<><span>error</span><span className="err">{run.error}</span></>)}
        </div>
      </details>
    </div>
  );
}
