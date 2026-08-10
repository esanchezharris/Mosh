import { useEffect, useState } from "react";
import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import {
  currentTrackInput,
  currentTrackOutput,
  midiInputOptions,
  trackOutputOptions,
  trackOutputPatch,
  waveInputOptions,
  type DeviceOption,
} from "../settings/routing";
import { useStore } from "../store";
import type { Track } from "../types";
import { appliedFailure } from "./commandFeedback";
import { ProToolsDeviceRack } from "./ProToolsDeviceRack";

const VOLUME_DEFAULT_DB = 0;
const PAN_DEFAULT = 0;

function optionLabel(
  options: readonly DeviceOption[],
  value: string,
  emptyLabel: string,
  snapshotLabel?: string,
): string {
  if (!value) return emptyLabel;
  return options.find((option) => option.value === value)?.label ?? snapshotLabel ?? value;
}

function inputOptions(track: Track, wave: ReturnType<typeof waveInputOptions>, midi: ReturnType<typeof midiInputOptions>): DeviceOption[] {
  if (!track.isInstrument) return wave;
  return [...wave, ...midi.filter((option) => option.value !== "")];
}

function IoMenu({ label, testId, display, options, value, onPick }: {
  readonly label: string;
  readonly testId: "pt-io-input" | "pt-io-output";
  readonly display: string;
  readonly options: readonly DeviceOption[];
  readonly value: string;
  readonly onPick: (value: string) => void;
}) {
  return (
    <MoshMenu label={label} trigger={
      <button type="button" className="pt-io-menu" data-testid={testId} aria-label={label}>
        <span>{display}</span><span aria-hidden="true">▾</span>
      </button>
    }>
      <div className="pt-menu" role="menu">
        {options.map((option) => (
          <MoshMenuItem key={option.value || "__none__"}
            testId={`${testId}-option`} ariaLabel={option.label} onPick={() => onPick(option.value)}>
            <span aria-hidden="true">{option.value === value ? "✓" : "·"}</span>
            <span>{option.label}</span>
          </MoshMenuItem>
        ))}
      </div>
    </MoshMenu>
  );
}

export function ProToolsTrackInspector({ track }: { readonly track: Track }) {
  const exec = useStore((state) => state.exec);
  const setLastError = useStore((state) => state.setLastError);
  const waveInputs = useStore((state) => state.waveInputs);
  const midiInputs = useStore((state) => state.midiInputs);
  const trackOutputs = useStore((state) => state.trackOutputs);
  const loadRouting = useStore((state) => state.loadRouting);
  const loadMidiInputs = useStore((state) => state.loadMidiInputs);
  const [name, setName] = useState(track.name);
  const [nameInvalid, setNameInvalid] = useState(false);

  useEffect(() => { void loadRouting(); void loadMidiInputs(); }, [loadMidiInputs, loadRouting]);
  useEffect(() => { setName(track.name); setNameInvalid(false); }, [track.id, track.name]);

  const waveOptions = waveInputOptions(waveInputs);
  const midiOptions = midiInputOptions(midiInputs);
  const inputs = inputOptions(track, waveOptions, midiOptions);
  const inputValue = currentTrackInput(track);
  const outputs = trackOutputOptions(trackOutputs, track.id);
  const outputValue = currentTrackOutput(track);

  const commitName = () => {
    const next = name.trim();
    if (!next) {
      setNameInvalid(true);
      return;
    }
    setNameInvalid(false);
    if (next !== track.name) void exec("rename_track", { trackId: track.id, name: next });
  };
  const setMonitor = async (mode: "off" | "automatic" | "on") => {
    const result = await exec("set_input_monitor", { trackId: track.id, mode });
    const failure = appliedFailure(result, "Input monitoring could not be applied.");
    if (failure) setLastError(failure);
  };

  return (
    <div className="pt-track-inspector" data-testid="pt-track-inspector">
      <header className="pt-detail-head">
        <span className="pt-detail-title">Track — {track.name}</span>
        <span className="pt-device-rack-label">I/O · Mix · Inserts A–E</span>
      </header>
      <div className="pt-track-inspector-body">
        <section className="pt-track-channel" aria-label={`${track.name} routing and mix`}>
          <label className="pt-inspector-name">Name
            <input data-testid="pt-track-name" value={name} aria-invalid={nameInvalid}
              aria-describedby={nameInvalid ? "pt-track-name-error" : undefined}
              onChange={(event) => { setName(event.target.value); setNameInvalid(false); }}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitName();
                if (event.key === "Escape") { setName(track.name); setNameInvalid(false); }
              }} />
          </label>
          {nameInvalid && <span id="pt-track-name-error" className="pt-field-error" role="alert">Track name cannot be empty.</span>}
          <div className="pt-routing-grid">
            <span className="pt-field-label">Input</span>
            <IoMenu label={`Input source for ${track.name}`} testId="pt-io-input"
              display={optionLabel(inputs, inputValue, "No Input", track.input?.name)} options={inputs} value={inputValue}
              onPick={(deviceID) => void exec("set_track_input", { trackId: track.id, deviceID })} />
            <span className="pt-field-label">Output</span>
            <IoMenu label={`Output destination for ${track.name}`} testId="pt-io-output"
              display={optionLabel(outputs, outputValue, "Default output", track.output?.name)} options={outputs} value={outputValue}
              onPick={(value) => void exec("set_track_output", trackOutputPatch(value, track.id))} />
          </div>
          <div className="pt-monitor-group" role="group" aria-label={`Input monitoring for ${track.name}`}>
            <span className="pt-field-label">Monitor</span>
            {(["off", "automatic", "on"] as const).map((mode) => (
              <button key={mode} type="button" data-testid={`pt-monitor-${mode}`}
                aria-pressed={(track.monitor ?? "automatic") === mode} onClick={() => void setMonitor(mode)}>
                {mode === "automatic" ? "Auto" : mode === "on" ? "In" : "Off"}
              </button>
            ))}
          </div>
          <div className="pt-mix-grid">
            <label>Volume
              <input type="range" min={-70} max={6} step={0.5} value={track.volumeDb ?? VOLUME_DEFAULT_DB}
                data-testid="pt-track-volume" aria-label={`Volume for ${track.name}`}
                onChange={(event) => void exec("set_track_volume", { trackId: track.id, db: Number(event.target.value) })}
                onDoubleClick={() => void exec("set_track_volume", { trackId: track.id, db: VOLUME_DEFAULT_DB })} />
              <output>{(track.volumeDb ?? VOLUME_DEFAULT_DB).toFixed(1)} dB</output>
            </label>
            <label>Pan
              <input type="range" min={-1} max={1} step={0.01} value={track.pan ?? PAN_DEFAULT}
                data-testid="pt-track-pan" aria-label={`Pan for ${track.name}`}
                onChange={(event) => void exec("set_track_pan", { trackId: track.id, pan: Number(event.target.value) })}
                onDoubleClick={() => void exec("set_track_pan", { trackId: track.id, pan: PAN_DEFAULT })} />
              <output>{(track.pan ?? PAN_DEFAULT).toFixed(2)}</output>
            </label>
          </div>
        </section>
        <ProToolsDeviceRack track={track} embedded />
      </div>
    </div>
  );
}
