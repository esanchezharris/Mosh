import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { TunerReading } from "../types";
import { describeTuner, formatCents, tunerKey, tunerView } from "../ui/tuner";

// How long the last note stays on screen after the pitch stops. A consonant or a breath
// between two notes is a gap of a few tens of milliseconds; without this the display
// would blank on every one of them.
export const TUNER_HOLD_MS = 350;

/** The reading to draw: the current one, or the last one for a moment after it stops. */
function useHeldReading(current: TunerReading | undefined): TunerReading | undefined {
  const [held, setHeld] = useState<TunerReading | undefined>(current);
  useEffect(() => {
    if (current) { setHeld(current); return; }
    const timer = setTimeout(() => setHeld(undefined), TUNER_HOLD_MS);
    return () => clearTimeout(timer);
  }, [current]);
  return current ?? held;
}

/** Mosh AutoTune's live note display: the note being sung, a needle for how far it is from
 *  the note it is being pulled to, and that note. Subscribes to its own tuner only, so the
 *  30 Hz readings redraw this strip and nothing else. */
export function TunerReadout({ trackId, index }: { trackId: string; index: number }) {
  const reading = useHeldReading(useStore((s) => s.tuners[tunerKey(trackId, index)]));
  const view = tunerView(reading);
  return (
    <div className={`tuner${view ? "" : " idle"}`} data-testid="v3-tuner" data-live={view ? "" : undefined}
      role="img" aria-label={describeTuner(view)}
      title="The note being sung, how far it is from the note AutoTune is pulling to, and that note">
      <span className="heard" data-testid="v3-tuner-heard">{view ? view.heard : "–"}</span>
      <span className="meter" aria-hidden="true">
        <i className={view?.inTune ? "ok" : undefined} style={{ left: `${(view?.position ?? 0.5) * 100}%` }} />
      </span>
      <span className="cents" data-testid="v3-tuner-cents">{view ? formatCents(view.cents) : ""}</span>
      <span className="arrow" aria-hidden="true">{"→"}</span>
      <span className="target" data-testid="v3-tuner-target">{view ? view.target : "–"}</span>
    </div>
  );
}
