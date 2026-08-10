import { useRef } from "react";
import { capturePointer, releasePointer } from "./pointerCapture";
import {
  PROTOOLS_UNIVERSE_DEFAULT_HEIGHT,
  PROTOOLS_UNIVERSE_MAX_HEIGHT,
  PROTOOLS_UNIVERSE_MIN_HEIGHT,
} from "./proToolsUniverse";
import { useProTools } from "./proToolsState";

export function ProToolsUniverseResizer() {
  const height = useProTools((state) => state.universeHeight);
  const setHeight = useProTools((state) => state.setUniverseHeight);
  const resizeRef = useRef<{
    readonly pointerId: number;
    readonly startY: number;
    readonly startHeight: number;
  } | null>(null);

  return (
    <div className="pt-universe-resizer" data-testid="pt-universe-resizer"
      role="separator" aria-orientation="horizontal" aria-label="Resize Universe view"
      aria-valuemin={PROTOOLS_UNIVERSE_MIN_HEIGHT}
      aria-valuemax={PROTOOLS_UNIVERSE_MAX_HEIGHT}
      aria-valuenow={height} tabIndex={0}
      onDoubleClick={() => setHeight(PROTOOLS_UNIVERSE_DEFAULT_HEIGHT)}
      onPointerDown={(event) => {
        resizeRef.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight: height,
        };
        capturePointer(event.currentTarget, event.pointerId);
      }}
      onPointerMove={(event) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        setHeight(resize.startHeight + event.clientY - resize.startY);
      }}
      onPointerUp={(event) => {
        if (resizeRef.current?.pointerId !== event.pointerId) return;
        resizeRef.current = null;
        releasePointer(event.currentTarget, event.pointerId);
      }}
      onPointerCancel={(event) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        resizeRef.current = null;
        setHeight(resize.startHeight);
        releasePointer(event.currentTarget, event.pointerId);
      }}
      onKeyDown={(event) => {
        const next = event.key === "ArrowDown"
          ? height + 8
          : event.key === "ArrowUp"
            ? height - 8
            : event.key === "Home"
              ? PROTOOLS_UNIVERSE_MIN_HEIGHT
              : event.key === "End"
                ? PROTOOLS_UNIVERSE_MAX_HEIGHT
                : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        setHeight(next);
      }} />
  );
}
