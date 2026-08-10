import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import {
  formatProToolsPunchRange,
  resolveProToolsPunchRange,
} from "./punchRecording";
import { useProToolsTimelineRange } from "./proToolsTimelineSelection";

const resultError = (result: CommandResult, fallback: string): string | null =>
  result.ok ? null : result.error ?? fallback;

export function ProToolsPunchControls({ snapshot }: { readonly snapshot: Snapshot }) {
  const exec = useStore((state) => state.exec);
  const transport = useStore((state) => state.transport);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const timelineSelection = useProToolsTimelineRange();
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const epochRef = useRef(projectEpoch);
  const recordOptions = snapshot.session.project?.recordOptions;
  const punchEnabled = recordOptions?.punchInOut ?? false;
  const preRollBars = snapshot.session.countInBars ?? snapshot.session.project?.countInBars ?? 0;
  const punchRange = resolveProToolsPunchRange(timelineSelection, transport);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (epochRef.current === projectEpoch) return;
    epochRef.current = projectEpoch;
    setBusy(false);
  }, [projectEpoch]);

  const fail = (message: string) => useStore.getState().setLastError(message);
  const stillCurrent = (epoch: number) => useStore.getState().projectEpoch === epoch;
  const finish = (epoch: number) => {
    if (mountedRef.current && stillCurrent(epoch)) setBusy(false);
  };

  const setPunch = async () => {
    if (busy || !recordOptions) return;
    const epoch = useStore.getState().projectEpoch;
    setBusy(true);
    if (!punchEnabled) {
      if (!punchRange) {
        fail("Punch needs a Timeline selection or stored range before it can be enabled.");
        finish(epoch);
        return;
      }
      const rangeResult = await exec("set_transport", {
        loop: false,
        loopStart: punchRange.start,
        loopEnd: punchRange.end,
      });
      if (!stillCurrent(epoch)) return;
      const rangeError = resultError(rangeResult, "The punch range could not be set.");
      if (rangeError) {
        fail(rangeError);
        finish(epoch);
        return;
      }
    }
    const result = await exec("set_record_options", { punchInOut: !punchEnabled });
    if (!stillCurrent(epoch)) return;
    const error = resultError(result, "Punch recording could not be changed.");
    if (error) fail(error);
    finish(epoch);
  };

  const setPreRoll = async (bars: number) => {
    if (busy || ![0, 1, 2].includes(bars)) return;
    const epoch = useStore.getState().projectEpoch;
    setBusy(true);
    const result = await exec("set_count_in", { bars });
    if (!stillCurrent(epoch)) return;
    const error = resultError(result, "Pre-roll could not be changed.");
    if (error) fail(error);
    finish(epoch);
  };

  return (
    <div className="pt-punch-controls" role="group" aria-label="Punch and pre-roll">
      <button type="button" className="pt-punch-button" data-testid="pt-punch-toggle"
        aria-pressed={punchEnabled} disabled={busy || !recordOptions}
        title={punchEnabled
          ? `Punch recording enabled: ${formatProToolsPunchRange(punchRange)}`
          : `Enable range-bounded Punch: ${formatProToolsPunchRange(punchRange)}`}
        onClick={() => void setPunch()}>Punch</button>
      <label className="pt-preroll-control">Pre
        <select data-testid="pt-preroll-select" aria-label="Recording pre-roll"
          value={preRollBars} disabled={busy}
          onChange={(event) => void setPreRoll(Number(event.target.value))}>
          <option value={0}>Off</option>
          <option value={1}>1 bar</option>
          <option value={2}>2 bars</option>
        </select>
      </label>
      <output className="pt-punch-range-readout" data-testid="pt-punch-range-readout"
        aria-live="polite">{formatProToolsPunchRange(punchRange)}</output>
    </div>
  );
}
