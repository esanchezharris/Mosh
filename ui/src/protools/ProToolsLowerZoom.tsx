import { useStore } from "../store";
import { useProTools } from "./proToolsState";
import { applyHorizontalZoomStep } from "./proToolsZoom";
import { nextTrackHeightScale } from "./trackHeightZoom";

export function ProToolsLowerZoom() {
  const pxPerSec = useStore((state) => state.pxPerSec);
  const trackHeightScale = useProTools((state) => state.trackHeightScale);
  const setTrackHeightScale = useProTools((state) => state.setTrackHeightScale);

  return (
    <div className="pt-lower-zoom">
      <div className="pt-lower-zoom-axis" role="group" aria-label="Track height zoom">
        <button type="button" data-testid="pt-lower-track-height-out"
          aria-label="Decrease all track heights"
          onClick={() => setTrackHeightScale(nextTrackHeightScale(trackHeightScale, -1))}>−</button>
        <output aria-label="Track height scale">{Math.round(trackHeightScale * 100)}%</output>
        <button type="button" data-testid="pt-lower-track-height-in"
          aria-label="Increase all track heights"
          onClick={() => setTrackHeightScale(nextTrackHeightScale(trackHeightScale, 1))}>+</button>
      </div>
      <div className="pt-lower-zoom-axis" role="group" aria-label="Timeline horizontal zoom">
        <button type="button" data-testid="pt-lower-zoom-out"
          aria-label="Timeline zoom out" onClick={() => applyHorizontalZoomStep(-1)}>−</button>
        <output aria-label="Timeline zoom scale">{Math.round(pxPerSec)}</output>
        <button type="button" data-testid="pt-lower-zoom-in"
          aria-label="Timeline zoom in" onClick={() => applyHorizontalZoomStep(1)}>+</button>
      </div>
    </div>
  );
}
