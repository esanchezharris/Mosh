// The live track header's I/O grid (WIDGETS.md §2 — Live 12's per-track Mixer
// Panel Group). Every control here is either REAL (correct options, current value,
// the mutation through the one seam) or honestly DISABLED with the reason — never
// a fake popup that looks alive. The monitoring trio (In·Auto·Off, already real via
// set_input_monitor) stays in the M/S/arm row above, Live's own header order.
//
// Capability matrix (engine-verified):
//   Input Type popup      REAL — waveInputOptions/midiInputOptions → set_track_input
//   Input Channel popup   DISABLED — no finer-channel command exists
//   Output Type popup     REAL — trackOutputOptions → set_track_output (default/dev/track)
//   Output Channel popup  DISABLED — no per-channel output command exists
//   Volume / Pan sliders  REAL — set_track_volume / set_track_pan; drag + dbl-click reset
//
// The routing catalogs are LAZY (loadRouting/loadMidiInputs on mount — the store's
// on-demand discipline: execute_command is synchronous, never at app init).

import { useEffect } from "react";
import { useStore } from "../store";
import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import { MoshTip } from "../chrome/Tooltip";
import {
  currentTrackInput, currentTrackOutput, trackOutputOptions, trackOutputPatch,
  type DeviceOption,
} from "../settings/routing";
import type { Track } from "../types";
import { inputDisplayLabel, inputOptionsFor, optionLabel, VOLUME_DEFAULT_DB, PAN_DEFAULT } from "./trackIo";

export function TrackIoSection({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const waveInputs = useStore((s) => s.waveInputs);
  const midiInputs = useStore((s) => s.midiInputs);
  const trackOutputs = useStore((s) => s.trackOutputs);
  const loadRouting = useStore((s) => s.loadRouting);
  const loadMidiInputs = useStore((s) => s.loadMidiInputs);
  useEffect(() => { void loadRouting(); void loadMidiInputs(); }, [loadRouting, loadMidiInputs]);

  const inputOpts = inputOptionsFor(waveInputs, midiInputs, !!track.isInstrument);
  const inputValue = currentTrackInput(track);
  const outputOpts = trackOutputOptions(trackOutputs, track.id);
  const outputValue = currentTrackOutput(track);

  return (
    <div className="live-tio-grid" data-testid="live-track-io">
      <div className="live-tio-row">
        <IoPopup
          testId="live-io-in"
          ariaLabel={`Input source for ${track.name}`}
          display={inputDisplayLabel(track, inputOpts)}
          options={inputOpts}
          value={inputValue}
          onPick={(v) => void exec("set_track_input", { trackId: track.id, deviceID: v })}
        />
        <DisabledCell
          testId="live-io-in-chan"
          reason="Per-channel pickers have no engine command yet — set_track_input takes a whole device/pair."
        />
      </div>

      <div className="live-tio-row">
        <IoPopup
          testId="live-io-out"
          ariaLabel={`Output destination for ${track.name}`}
          display={optionLabel(outputOpts, outputValue, "Master")}
          options={outputOpts}
          value={outputValue}
          onPick={(v) => void exec("set_track_output", trackOutputPatch(v, track.id))}
        />
        <DisabledCell
          testId="live-io-out-chan"
          reason="Per-channel output pickers have no engine command yet — set_track_output takes a whole destination."
        />
      </div>

      <div className="live-tio-row" data-testid="live-io-volpan">
        <label className="live-io-slider" title={`Volume — ${(track.volumeDb ?? 0).toFixed(1)} dB (double-click resets to 0)`}>
          <input
            type="range"
            min={-70} max={6} step={0.5}
            value={track.volumeDb ?? VOLUME_DEFAULT_DB}
            data-testid="live-io-volume"
            aria-label={`Volume for ${track.name}`}
            onChange={(e) => void exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })}
            onDoubleClick={() => void exec("set_track_volume", { trackId: track.id, db: VOLUME_DEFAULT_DB })}
          />
          <span className="live-io-val">{(track.volumeDb ?? 0).toFixed(1)}</span>
        </label>
        <label className="live-io-slider" title={`Pan — ${(track.pan ?? 0).toFixed(2)} (double-click resets to centre)`}>
          <input
            type="range"
            min={-1} max={1} step={0.01}
            value={track.pan ?? PAN_DEFAULT}
            data-testid="live-io-pan"
            aria-label={`Pan for ${track.name}`}
            onChange={(e) => void exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })}
            onDoubleClick={() => void exec("set_track_pan", { trackId: track.id, pan: PAN_DEFAULT })}
          />
          <span className="live-io-val">{(track.pan ?? 0).toFixed(2)}</span>
        </label>
      </div>
    </div>
  );
}

/** A real routing popup: a button showing the current value that opens a MoshMenu
 *  (menu on click, per WIDGETS §2 — NOT a <select>). Options come from the engine
 *  catalogs; the current value is marked. */
function IoPopup({ testId, ariaLabel, display, options, value, onPick }: {
  testId: string;
  ariaLabel: string;
  display: string;
  options: DeviceOption[];
  value: string;
  onPick: (value: string) => void;
}) {
  return (
    <MoshMenu
      label={ariaLabel}
      trigger={
        <button
          className="live-io-pop"
          data-testid={testId}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          title={display}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="live-io-pop-label">{display}</span>
          <span className="live-io-pop-caret" aria-hidden="true">▾</span>
        </button>
      }
    >
      <div className="live-menu" role="menu">
        {options.map((o) => (
          <MoshMenuItem
            key={o.value || "__none__"}
            testId={`${testId}-opt`}
            ariaLabel={o.label}
            onPick={() => onPick(o.value)}
          >
            <span className="live-io-check" aria-hidden="true">{o.value === value ? "✓" : ""}</span>
            <span className="live-menu-label">{o.label}</span>
          </MoshMenuItem>
        ))}
      </div>
    </MoshMenu>
  );
}

/** The honest-disablement cell: Live's look, inert, and the reason on hover —
 *  what a control looks like when the engine has no command behind it. */
function DisabledCell({ testId, reason }: { testId: string; reason: string }) {
  return (
    <MoshTip side="top" label={reason}>
      <button
        className="live-io-pop live-io-dis"
        data-testid={testId}
        disabled
        aria-disabled="true"
        aria-label="Not available"
      >
        <span className="live-io-pop-label">—</span>
        <span className="live-io-pop-caret" aria-hidden="true">▾</span>
      </button>
    </MoshTip>
  );
}
