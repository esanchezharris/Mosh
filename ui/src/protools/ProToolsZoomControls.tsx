import { useStore } from "../store";
import { useProTools } from "./proToolsState";
import { applyHorizontalZoom, applyHorizontalZoomStep, nextVerticalZoom } from "./proToolsZoom";

export function ProToolsZoomControls() {
  const pxPerSec = useStore((state) => state.pxPerSec);
  const presets = useProTools((state) => state.horizontalZoomPresets);
  const setPreset = useProTools((state) => state.setHorizontalZoomPreset);
  const audioWaveformZoom = useProTools((state) => state.audioWaveformZoom);
  const midiNoteZoom = useProTools((state) => state.midiNoteZoom);
  const setAudioWaveformZoom = useProTools((state) => state.setAudioWaveformZoom);
  const setMidiNoteZoom = useProTools((state) => state.setMidiNoteZoom);

  return (
    <div className="pt-toolbar-group pt-zoom-group" role="group" aria-label="Zoom controls">
      <span className="pt-toolbar-label">Zoom</span>
      <div className="pt-horizontal-zoom" role="group" aria-label="Horizontal Zoom">
        <div className="pt-zoom-step-row">
          <button type="button" data-testid="pt-zoom-out" aria-label="Horizontal zoom out, R"
            onClick={() => applyHorizontalZoomStep(-1)}>−</button>
          <output aria-label="Horizontal zoom scale">{Math.round(pxPerSec)}</output>
          <button type="button" data-testid="pt-zoom-in" aria-label="Horizontal zoom in, T"
            onClick={() => applyHorizontalZoomStep(1)}>+</button>
        </div>
        <div className="pt-zoom-presets" aria-label="Zoom presets">
          {presets.map((preset, index) => (
            <button key={index} type="button" data-testid={`pt-zoom-preset-${index + 1}`}
              aria-label={`Zoom preset ${index + 1}, ${Math.round(preset)} pixels per second. Command-click to store current zoom`}
              aria-pressed={Math.abs(pxPerSec - preset) < 0.01}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) setPreset(index, pxPerSec);
                else applyHorizontalZoom(preset);
              }}>
              {index + 1}
            </button>
          ))}
        </div>
      </div>
      <div className="pt-zoom-media" role="group" aria-label="Vertical media zoom">
        <button type="button" data-testid="pt-waveform-zoom-out"
          aria-label={`Audio waveform vertical zoom out, ${Math.round(audioWaveformZoom * 100)} percent`}
          onClick={() => setAudioWaveformZoom(nextVerticalZoom(audioWaveformZoom, -1))}>A−</button>
        <button type="button" data-testid="pt-waveform-zoom-in"
          aria-label={`Audio waveform vertical zoom in, ${Math.round(audioWaveformZoom * 100)} percent`}
          onClick={() => setAudioWaveformZoom(nextVerticalZoom(audioWaveformZoom, 1))}>A+</button>
        <button type="button" data-testid="pt-midi-zoom-out"
          aria-label={`MIDI note vertical zoom out, ${Math.round(midiNoteZoom * 100)} percent`}
          onClick={() => setMidiNoteZoom(nextVerticalZoom(midiNoteZoom, -1))}>M−</button>
        <button type="button" data-testid="pt-midi-zoom-in"
          aria-label={`MIDI note vertical zoom in, ${Math.round(midiNoteZoom * 100)} percent`}
          onClick={() => setMidiNoteZoom(nextVerticalZoom(midiNoteZoom, 1))}>M+</button>
      </div>
    </div>
  );
}
