import { useStore } from "../store";
import { applyHorizontalZoomStep } from "./proToolsZoom";

export function ProToolsLowerZoom() {
  const pxPerSec = useStore((state) => state.pxPerSec);

  return (
    <div className="pt-lower-zoom" role="group" aria-label="Timeline horizontal zoom">
      <button type="button" data-testid="pt-lower-zoom-out"
        aria-label="Timeline zoom out" onClick={() => applyHorizontalZoomStep(-1)}>−</button>
      <output aria-label="Timeline zoom scale">{Math.round(pxPerSec)}</output>
      <button type="button" data-testid="pt-lower-zoom-in"
        aria-label="Timeline zoom in" onClick={() => applyHorizontalZoomStep(1)}>+</button>
    </div>
  );
}
