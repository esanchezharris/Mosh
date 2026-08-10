import { useStore } from "../store";
import { useProTools } from "./proToolsState";
import { applyHorizontalZoom, applyHorizontalZoomStep } from "./proToolsZoom";

export function ProToolsZoomControls() {
  const pxPerSec = useStore((state) => state.pxPerSec);
  const presets = useProTools((state) => state.horizontalZoomPresets);
  const setPreset = useProTools((state) => state.setHorizontalZoomPreset);

  return (
    <div className="pt-toolbar-group pt-zoom-group" role="group" aria-label="Horizontal Zoom">
      <span className="pt-toolbar-label">Zoom</span>
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
  );
}
