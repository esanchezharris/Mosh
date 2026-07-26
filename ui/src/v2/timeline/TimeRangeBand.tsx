// UIREACH-TIMERANGE — the cross-lane overlay for a shift-drag time-range selection
// (drawn by BarRuler). This is delete_time_range's ONLY shipped-UI home: the command
// has full native + mock parity (ARR-011) and has been agent-callable all along, but
// no shell ever wired an actual delete action to it — v2 had no time-span selection of
// any kind, and even classic's Arrange.tsx range tool only ever painted the band (its
// own comment says "delete_time_range on demand" and then never implements the demand).
//
// Plain delete and ripple delete are two SEPARATELY LABELLED buttons, not one button
// plus a modifier: ripple silently slides every downstream clip in the project left to
// close the gap, and that is not something a producer should be able to trigger by
// missing a held key. Whichever one runs, the (now-stale) selection clears itself —
// the clips it described just moved or split.
//
// The same span also drives Loop — set_transport {loop:true, loopStart, loopEnd} — which
// v2 otherwise cannot reach at all: TopBar.tsx has read-only loop-state DISPLAY (the
// "loop"/bars readout) but no control ever calls set_transport with a loop arg in this
// shell. Loop does not invalidate the selection (delete does — the clips it described
// just moved or split), so it stays put after toggling; clicking it again while it is
// already looping exactly this span turns looping off instead of re-arming it.

import { useStore } from "../../store";
import { useShell } from "../shellState";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import { headW } from "./geom";
import { IconClose } from "../../ui/icons";

const EPS = 1e-6;

export function TimeRangeBand() {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const exec = useStore((s) => s.exec);
  const transport = useStore((s) => s.transport);
  const range = useShell((s) => s.timeRange);
  const dragging = useShell((s) => s.timeRangeDragging);
  const setRange = useShell((s) => s.setTimeRange);

  const active = !!range && range.end > range.start;
  useEscapeToClose(active, () => setRange(null));

  if (!active) return null;
  const r = range!;

  const runDelete = async (ripple: boolean) => {
    const { start, end } = r;
    setRange(null); // the span it describes is about to move/vanish — clear eagerly
    await exec("delete_time_range", ripple ? { start, end, ripple: true } : { start, end });
  };

  const loopingThis = transport.looping
    && Math.abs(transport.loopStart - r.start) < EPS
    && Math.abs(transport.loopEnd - r.end) < EPS;
  const toggleLoop = async () => {
    if (loopingThis) await exec("set_transport", { loop: false });
    else await exec("set_transport", { loop: true, loopStart: r.start, loopEnd: r.end });
  };

  const left = headW() + r.start * pxPerSec;
  const width = (r.end - r.start) * pxPerSec;

  return (
    <div className="v2-timerange-band" style={{ left, width }} data-testid="v2-timerange-band">
      {/* Withheld while still dragging — otherwise it jitters across the screen chasing
          the pointer instead of settling once, on release, like TempoRibbon's field. */}
      {!dragging && (
        <div className="v2-timerange-toolbar" data-testid="v2-timerange-toolbar">
          <button
            type="button" data-testid="v2-timerange-loop"
            aria-pressed={loopingThis}
            title={loopingThis ? "Stop looping this range" : "Loop this range"}
            onClick={() => void toggleLoop()}
          >
            {loopingThis ? "Looping" : "Loop"}
          </button>
          <button
            type="button" data-testid="v2-timerange-delete"
            title="Remove this range on every track, leaving a hole"
            onClick={() => void runDelete(false)}
          >
            Delete
          </button>
          <button
            type="button" data-testid="v2-timerange-delete-ripple"
            title="Remove this range on every track and slide everything after it left to close the gap"
            onClick={() => void runDelete(true)}
          >
            Delete, close gap
          </button>
          <button
            type="button" className="v2-timerange-clear" data-testid="v2-timerange-clear"
            title="Clear selection" aria-label="Clear time range selection"
            onClick={() => setRange(null)}
          >
            <IconClose size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
