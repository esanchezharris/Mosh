import {
  currentTrackInput,
  currentTrackOutput,
  midiInputOptions,
  trackOutputOptions,
  trackOutputPatch,
  waveInputOptions,
} from "../settings/routing";
import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { appliedFailure } from "./commandFeedback";
import { executeProToolsMixFanout } from "./proToolsMixFanout";

export function ProToolsMixRouting({ snapshot, track, inputTargetTrackIds, outputTargetTrackIds }: {
  readonly snapshot: Snapshot;
  readonly track: Track;
  readonly inputTargetTrackIds: readonly string[];
  readonly outputTargetTrackIds: readonly string[];
}) {
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
            onChange={(event) => {
              const deviceID = event.currentTarget.value;
              void executeProToolsMixFanout({
                snapshot,
                targetTrackIds: inputTargetTrackIds,
                commandForTrack: (trackId) => ({
                  command: "set_track_input",
                  args: { trackId, deviceID },
                }),
                resultFailure: (result) => appliedFailure(result, "Input routing could not be applied."),
              });
            }}>
            {inputs.map((option) => <option key={option.value || "__none__"} value={option.value}>{option.label}</option>)}
          </select>
        )}
      </label>
      <label>Output
        <select data-testid="pt-mix-output" aria-label={`Output destination for ${track.name}`}
          value={outputValue}
          disabled={Boolean(track.isGroup)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            const destinationTrackId = value.startsWith("track:") ? value.slice("track:".length) : null;
            void executeProToolsMixFanout({
              snapshot,
              targetTrackIds: outputTargetTrackIds.filter((trackId) => trackId !== destinationTrackId),
              commandForTrack: (trackId) => ({
                command: "set_track_output",
                args: trackOutputPatch(value, trackId),
              }),
            });
          }}>
          {outputs.map((option) => <option key={option.value || "__default__"} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </section>
  );
}
