import {
  currentTrackInput,
  currentTrackOutput,
  midiInputOptions,
  trackOutputOptions,
  trackOutputPatch,
  waveInputOptions,
} from "../settings/routing";
import { useStore } from "../store";
import type { Track } from "../types";

export function ProToolsMixRouting({ track }: { readonly track: Track }) {
  const exec = useStore((state) => state.exec);
  const waveInputs = useStore((state) => state.waveInputs);
  const midiInputs = useStore((state) => state.midiInputs);
  const trackOutputs = useStore((state) => state.trackOutputs);
  const returnBus = useStore((state) => state.snapshot?.buses?.find((bus) =>
    bus.trackId === track.id || bus.bus === track.returnBus));
  const wave = waveInputOptions(waveInputs);
  const midi = midiInputOptions(midiInputs);
  const inputs = track.isInstrument ? [...wave, ...midi.filter((option) => option.value !== "")] : wave;
  const outputs = trackOutputOptions(trackOutputs, track.id);
  const inputValue = currentTrackInput(track);
  const outputValue = currentTrackOutput(track);

  return (
    <section className="pt-mix-routing" aria-label={`${track.name} input and output`}>
      <label>Input
        {track.isReturn || track.isGroup ? (
          <span className="pt-mix-fixed-route" data-testid="pt-mix-input">
            {track.isReturn ? `Bus · ${returnBus?.name ?? track.name}` : "Routing group"}
          </span>
        ) : (
          <select data-testid="pt-mix-input" aria-label={`Input source for ${track.name}`}
            value={inputValue}
            onChange={(event) => void exec("set_track_input", {
              trackId: track.id,
              deviceID: event.currentTarget.value,
            })}>
            {inputs.map((option) => <option key={option.value || "__none__"} value={option.value}>{option.label}</option>)}
          </select>
        )}
      </label>
      <label>Output
        <select data-testid="pt-mix-output" aria-label={`Output destination for ${track.name}`}
          value={outputValue}
          onChange={(event) => void exec("set_track_output", trackOutputPatch(event.currentTarget.value, track.id))}>
          {outputs.map((option) => <option key={option.value || "__default__"} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </section>
  );
}
