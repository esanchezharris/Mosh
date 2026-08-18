// The take sheet — every checkpoint this run produced, newest first.
//
// Chronological because that is the one honest structural claim about a training
// run: it produces takes over time, and the later ones are more trained, not
// necessarily better. Sorting by any quality measure would assert an ordering the
// evidence does not support (the probe stayed flat while the adapters plainly
// improved, and the higher-scoring take lost by ear).
//
// The BASE row is pinned at the bottom, outside the run's chronology, because it
// is not a take — it is the thing every take is compared against. It was added
// after the owner noted mid-round that they could not tell how good the base
// model was on these prompts, which made every "is this better?" unanswerable.

import { useStore } from "../../store";
import { TakeRow, type TakeRowModel } from "./TakeRow";

const BASE_ROW: TakeRowModel = { name: null, step: -1, isFinal: false, landedAt: 0 };

export function TakeSheet() {
  const takes = useStore((s) => s.labTakes);
  const dismissed = useStore((s) => s.labDismissed);
  const restore = useStore((s) => s.restoreLabTakes);
  const promptSet = useStore((s) => s.labPrompt.trim().length > 0);
  const running = useStore((s) => s.labRun?.status === "training" || s.labRun?.status === "precompute");

  const hidden = new Set(dismissed);
  const shown = takes
    .filter((t) => !hidden.has(t.name))
    // Final last-produced, then newest step first. `landedAt` is the client clock
    // stamped once when a take first appears, never re-stamped on a poll.
    .slice()
    .sort((a, b) => (b.isFinal ? 1 : 0) - (a.isFinal ? 1 : 0) || b.step - a.step || b.landedAt - a.landedAt);

  return (
    <div className="lab-sheet" data-testid="lab-sheet">
      {!promptSet && (
        <div className="lab-hint" data-testid="lab-hint-prompt">
          Write a prompt above to audition takes. Use the words you would use for a real render —
          a take is only useful if it answers the question you actually ask the model.
        </div>
      )}

      {shown.length === 0 && (
        <div className="lab-hint dim" data-testid="lab-sheet-empty">
          {running
            ? "No checkpoints yet. The first lands part-way through the run and appears here while training continues."
            : "No takes yet. Train a run, or open one you already have."}
        </div>
      )}

      {shown.map((t) => <TakeRow key={t.name} take={t} />)}

      <div className="lab-sheet-base">
        <TakeRow take={BASE_ROW} />
      </div>

      {dismissed.length > 0 && (
        // Hidden, not deleted — each take is ~20 minutes of compute, and the whole
        // finding behind this feature is that the take you nearly binned was
        // sometimes the good one.
        <button className="btn ghost lab-restore" data-testid="lab-restore" onClick={restore}>
          Show {dismissed.length} hidden {dismissed.length === 1 ? "take" : "takes"}
        </button>
      )}
    </div>
  );
}
